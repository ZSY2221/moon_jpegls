///|
pub struct Encoder {
  priv frame : Frame
  priv scan : Scan
  priv bits : BitWriter
  priv mut scan_header : Bool
  priv mut trailer : Bool
  priv mut run : Int32
  priv mut terminal : Status?
}

///|
pub fn Encoder::new(frame : Frame, limits : Limits) -> Encoder raise CodecError {
  validate_limits(limits)
  validate_dimensions(frame.width, frame.height, limits)
  guard frame.bits >= 2 &&
    frame.bits <= 16 &&
    frame.near >= 0 &&
    frame.near <= 255 else {
    raise InvalidArgument("sample precision or NEAR")
  }
  let maxval = frame.maxval()
  guard frame.near <= maxval / 2 else {
    raise InvalidArgument("NEAR exceeds MAXVAL / 2")
  }
  validate_profile(frame.bits, frame.near, maxval)
  let params = default_parameters(maxval, frame.near)
  let bits = BitWriter::new()
  bits.header(frame, params)
  {
    frame,
    scan: Scan::new(frame.width, params),
    bits,
    scan_header: false,
    trailer: false,
    run: -1,
    terminal: None,
  }
}

///|
pub fn Encoder::workspace_bytes(self : Encoder) -> Int32 {
  self.scan.workspace_bytes() + self.bits.pending.length()
}

///|
pub fn Encoder::pending_bytes(self : Encoder) -> Int32 {
  self.bits.end - self.bits.start
}

///|
pub fn Encoder::cancel(self : Encoder) -> Unit {
  if self.terminal is None {
    self.terminal = Some(Failed(Cancelled))
  }
}

///|
fn Encoder::regular(
  self : Encoder,
  sample : Int32,
  a : Int32,
  b : Int32,
  c : Int32,
  id : Int32,
) -> Unit {
  let scan = self.scan
  let p = scan.params
  let context = scan.regular[id.abs()]
  let sign = sign_of(id)
  let predicted = scan.prediction(a, b, c, id)
  let error = p.reduce(sign * (sample - predicted))
  let k = golomb_order(context.a, context.n)
  let mapped = map_regular(error) ^
    (if context.invert(k, p.near) { 1 } else { 0 })
  self.bits.symbol(mapped, k, p.limit, p.qbpp)
  context.update(p, error)
  scan.store(p.reconstruct(predicted, sign * error))
}

///|
fn Encoder::run_sample(self : Encoder, sample : Int32, a : Int32) -> Unit {
  let scan = self.scan
  let p = scan.params
  let exponent = run_exponents[scan.run_index]
  if (sample - a).abs() <= p.near {
    self.run += 1
    scan.store(a)
    if self.run == 1 << exponent {
      self.bits.bits(1, 1)
      scan.run_index = min(31, scan.run_index + 1)
      self.run = 0
    }
    if scan.x == scan.width && self.run != 0 {
      self.bits.bits(1, 1)
    }
  } else {
    self.bits.bits(0, 1)
    self.bits.bits(self.run, exponent)
    let (kind, predicted, sign) = scan.run_prediction(a)
    let context = scan.runs[kind]
    let k = context.order(kind)
    let error = p.reduce(sign * (sample - predicted))
    let mapped_sign = if error == 0 {
      0
    } else if (error < 0) == context.negative_odd(k) {
      1
    } else {
      0
    }
    let mapped = 2 * error.abs() - kind - mapped_sign
    self.bits.symbol(mapped, k, p.limit - exponent - 1, p.qbpp)
    context.update(p, kind, error, mapped)
    scan.store(p.reconstruct(predicted, sign * error))
    scan.run_index = max(0, scan.run_index - 1)
    self.run = -1
  }
}

///|
fn Encoder::sample(self : Encoder, value : Int32) -> Unit {
  if self.run >= 0 {
    self.run_sample(value, self.scan.left())
  } else {
    let (a, b, c, d) = self.scan.neighbors()
    let id = self.scan.context_id(a, b, c, d)
    if id == 0 {
      self.run = 0
      self.run_sample(value, a)
    } else {
      self.regular(value, a, b, c, id)
    }
  }
}

///|
/// Encodes a slice and writes at most `output.length()` bytes from offset zero.
/// Keep the unconsumed input and call again after handling the reported status.
pub fn Encoder::step(
  self : Encoder,
  input : FixedArray[Int32],
  offset : Int32,
  length : Int32,
  output : FixedArray[Byte],
  eof : Bool,
) -> EncodeStep {
  if self.terminal is Some(status) {
    return { consumed: 0, produced: 0, status, }
  }
  let mut consumed = 0
  let mut produced = 0
  let status = try {
    guard offset >= 0 &&
      length >= 0 &&
      offset <= input.length() &&
      length <= input.length() - offset else {
      raise InvalidArgument("input sample slice")
    }
    while true {
      produced += self.bits.drain(output, produced)
      if self.pending_bytes() > 0 {
        break NeedOutput
      }
      if !self.scan_header {
        self.scan_header = true
        self.bits.scan_header(self.frame.near)
        continue
      }
      if self.trailer {
        break Done
      }
      if self.scan.x == self.frame.width {
        self.scan.next_row()
        self.run = -1
        break RowReady
      }
      if self.scan.rows == self.frame.height {
        guard consumed == length else {
          raise InvalidArgument("extra samples after the declared frame")
        }
        if !eof {
          break NeedInput
        }
        self.bits.finish()
        self.trailer = true
        continue
      }
      if consumed == length {
        if eof {
          raise Truncated
        }
        break NeedInput
      }
      let sample = input[offset + consumed]
      guard sample >= 0 && sample <= self.scan.params.maxval else {
        raise InvalidArgument("sample is outside MAXVAL")
      }
      consumed += 1
      self.sample(sample)
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
  { consumed, produced, status, }
}
