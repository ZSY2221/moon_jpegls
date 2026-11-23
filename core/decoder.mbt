///|
priv enum DecodePhase {
  Sample
  Regular(Int32, Int32, Int32, Int32)
  RunBits(Int32)
  RunRemainder(Int32, Int32, Int32)
  Interruption(Int32, Int32, Int32, Bool)
  Padding
  StuffedPadding
  EndPrefix
  EndCode
}

///|
pub struct Decoder {
  priv header : HeaderParser
  priv bits : BitReader
  priv golomb : GolombReader
  priv mut frame : Frame?
  priv mut scan : Scan?
  priv mut phase : DecodePhase
  priv mut terminal : Status?
}

///|
pub fn Decoder::new(limits : Limits) -> Decoder {
  let terminal = try {
    validate_limits(limits)
    None
  } catch {
    error => Some(Failed(error))
  }
  {
    header: HeaderParser::new(limits),
    bits: BitReader::new(),
    golomb: GolombReader::new(),
    frame: None,
    scan: None,
    phase: Sample,
    terminal,
  }
}

///|
pub fn Decoder::frame(self : Decoder) -> Frame? {
  self.frame
}

///|
/// A borrowed row. Copy any samples needed beyond the next `step` call.
pub fn Decoder::row(self : Decoder) -> FixedArray[Int32] {
  match self.scan {
    Some(scan) if scan.rows > 0 => scan.previous
    _ => []
  }
}

///|
pub fn Decoder::workspace_bytes(self : Decoder) -> Int32 {
  let header_bytes = self.header.segment.length() +
    4 * self.header.preset.length()
  match self.scan {
    None => header_bytes
    Some(scan) => header_bytes + scan.workspace_bytes()
  }
}

///|
pub fn Decoder::pending_bits(self : Decoder) -> Int32 {
  self.bits.left
}

///|
pub fn Decoder::cancel(self : Decoder) -> Unit {
  if self.terminal is None {
    self.terminal = Some(Failed(Cancelled))
  }
}

///|
fn Decoder::start_sample(self : Decoder, scan : Scan) -> Unit {
  let (a, b, c, d) = scan.neighbors()
  let id = scan.context_id(a, b, c, d)
  if id == 0 {
    self.phase = RunBits(a)
  } else {
    let context = scan.regular[id.abs()]
    let k = golomb_order(context.a, context.n)
    let p = scan.params
    self.golomb.start(k, p.limit, p.qbpp)
    let invert = if context.invert(k, p.near) { 1 } else { 0 }
    self.phase = Regular(
      id.abs(),
      sign_of(id),
      scan.prediction(a, b, c, id),
      invert,
    )
  }
}

///|
fn Decoder::start_interruption(self : Decoder, scan : Scan, a : Int32) -> Unit {
  let (kind, predicted, sign) = scan.run_prediction(a)
  let context = scan.runs[kind]
  let k = context.order(kind)
  let p = scan.params
  self.golomb.start(k, p.limit - run_exponents[scan.run_index] - 1, p.qbpp)
  self.phase = Interruption(kind, predicted, sign, context.negative_odd(k))
}

///|
fn fill_run(scan : Scan, value : Int32, count : Int32) -> Unit {
  for _ in 0..<count {
    scan.store(value)
  }
}

///|
// Returns false precisely when another physical entropy byte is needed.
fn Decoder::advance_scan(self : Decoder, scan : Scan) -> Bool raise CodecError {
  let p = scan.params
  match self.phase {
    Sample => self.start_sample(scan)
    Regular(index, sign, predicted, invert) => {
      guard self.golomb.read(self.bits) is Some(mapped) else { return false }
      let error = unmap_regular(mapped ^ invert)
      p.check_error(error)
      scan.regular[index].update(p, error)
      scan.store(p.reconstruct(predicted, sign * error))
      self.phase = Sample
    }
    RunBits(a) => {
      if self.bits.left == 0 {
        return false
      }
      let exponent = run_exponents[scan.run_index]
      if self.bits.take(1) == 1 {
        let block = 1 << exponent
        let count = min(block, scan.width - scan.x)
        fill_run(scan, a, count)
        if count == block {
          scan.run_index = min(31, scan.run_index + 1)
        }
      } else {
        self.phase = RunRemainder(a, exponent, 0)
      }
    }
    RunRemainder(a, remaining, prefix) => {
      let take = min(remaining, self.bits.left)
      let value = (prefix << take) | self.bits.take(take)
      if take < remaining {
        self.phase = RunRemainder(a, remaining - take, value)
        return false
      }
      guard value < scan.width - scan.x else {
        raise InvalidData("run interruption outside row")
      }
      fill_run(scan, a, value)
      self.start_interruption(scan, a)
    }
    Interruption(kind, predicted, sign, negative_odd) => {
      guard self.golomb.read(self.bits) is Some(mapped) else { return false }
      let shifted = mapped + kind
      let magnitude = (shifted + 1) >> 1
      let negative = ((shifted & 1) == 1) == negative_odd
      let error = if negative { -magnitude } else { magnitude }
      p.check_error(error)
      scan.runs[kind].update(p, kind, error, mapped)
      scan.store(p.reconstruct(predicted, sign * error))
      scan.run_index = max(0, scan.run_index - 1)
      self.phase = Sample
    }
    _ => return false
  }
  true
}

///|
fn Decoder::advance_end(self : Decoder, byte : Int32) -> Bool raise CodecError {
  match self.phase {
    StuffedPadding => {
      guard byte == 0 else { raise InvalidData("nonzero stuffed pad byte") }
      self.phase = EndPrefix
    }
    EndPrefix => {
      guard byte == 0xFF else { raise InvalidData("missing EOI prefix") }
      self.phase = EndCode
    }
    EndCode =>
      match byte {
        0xD9 => return true
        0xFF => ()
        0xDA | 0xDC | 0xF8 | 0xD0..<=0xD7 =>
          raise UnsupportedFeature("additional scan or marker after entropy")
        _ => raise InvalidData("missing EOI")
      }
    _ => ()
  }
  false
}

///|
/// Decodes one slice and stops at a row event or the exact EOI byte.
pub fn Decoder::step(
  self : Decoder,
  input : Bytes,
  offset : Int32,
  length : Int32,
  eof : Bool,
) -> DecodeStep {
  if self.terminal is Some(status) {
    return { consumed: 0, status, }
  }
  let mut consumed = 0
  let status = try {
    guard offset >= 0 &&
      length >= 0 &&
      offset <= input.length() &&
      length <= input.length() - offset else {
      raise InvalidArgument("input byte slice")
    }
    while true {
      match (self.frame, self.scan) {
        (Some(frame), Some(scan)) if scan.rows < frame.height => {
          if scan.x == scan.width {
            scan.next_row()
            self.phase = if scan.rows == frame.height {
              Padding
            } else {
              Sample
            }
            break RowReady
          }
          if self.advance_scan(scan) {
            continue
          }
        }
        (Some(_), Some(_)) if self.phase is Padding => {
          guard self.bits.take(self.bits.left) == 0 else {
            raise InvalidData("nonzero entropy padding")
          }
          self.phase = if self.bits.stuffed {
            StuffedPadding
          } else {
            EndPrefix
          }
        }
        _ => ()
      }
      if consumed == length {
        if eof {
          raise Truncated
        }
        break NeedInput
      }
      let byte = input[offset + consumed].to_int()
      consumed += 1
      match self.scan {
        None =>
          if self.header.accept(byte) is Some((frame, params)) {
            self.frame = Some(frame)
            self.scan = Some(Scan::new(frame.width, params))
          }
        Some(_) =>
          match self.phase {
            StuffedPadding | EndPrefix | EndCode =>
              if self.advance_end(byte) {
                break Done
              }
            _ => self.bits.byte(byte)
          }
      }
    } nobreak {
      NeedInput
    }
  } catch {
    error => Failed(error)
  }
  match status {
    Done | Failed(_) => self.terminal = Some(status)
    _ => ()
  }
  { consumed, status, }
}
