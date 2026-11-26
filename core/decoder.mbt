///|
priv enum DecodePhase {
  Sample
  Regular
  RunBits
  RunRemainder
  Interruption
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
  priv mut frame_info : FrameInfo?
  priv mut scan : Scan?
  priv scans : Array[ScanInfo]
  priv mut current_scan : Int32
  priv mut bytes_read : Int64
  priv mut scan_end_offset : Int64
  priv mut marker_offset : Int64
  priv mut error_location : ErrorLocation?
  priv mut phase : DecodePhase
  priv mut phase_index : Int32
  priv mut phase_sign : Int32
  priv mut phase_pred : Int32
  priv mut phase_flag : Int32
  priv mut phase_prefix : Int32
  priv mut error : CodecError?
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
    frame_info: None,
    scan: None,
    scans: [],
    current_scan: -1,
    bytes_read: 0L,
    scan_end_offset: -1L,
    marker_offset: -1L,
    error_location: None,
    phase: Sample,
    phase_index: 0,
    phase_sign: 0,
    phase_pred: 0,
    phase_flag: 0,
    phase_prefix: 0,
    error: None,
    terminal,
  }
}

///|
pub fn Decoder::frame(self : Decoder) -> Frame? {
  self.frame
}

///|
pub fn Decoder::frame_info(self : Decoder) -> FrameInfo? {
  self.frame_info
}

///|
pub fn Decoder::scans(self : Decoder) -> Array[ScanInfo] {
  self.scans.copy()
}

///|
pub fn Decoder::current_scan(self : Decoder) -> ScanInfo? {
  if self.current_scan >= 0 && self.current_scan < self.scans.length() {
    Some(self.scans[self.current_scan])
  } else {
    None
  }
}

///|
pub fn Decoder::current_scan_index(self : Decoder) -> Int32 {
  self.current_scan
}

///|
pub fn Decoder::current_component_index(self : Decoder) -> Int32 {
  match self.scan {
    Some(scan) => {
      let slot = if scan.last_row_idx >= 0 {
        scan.last_row_comp
      } else {
        scan.active_comp
      }
      scan.comp_indices[slot]
    }
    None => -1
  }
}

///|
pub fn Decoder::current_component_id(self : Decoder) -> Int32 {
  match self.scan {
    Some(scan) => {
      let slot = if scan.last_row_idx >= 0 {
        scan.last_row_comp
      } else {
        scan.active_comp
      }
      scan.comp_ids[slot]
    }
    None => -1
  }
}

///|
pub fn Decoder::current_row(self : Decoder) -> Int32 {
  match self.scan {
    Some(scan) => scan.last_row_idx
    None => -1
  }
}

///|
pub fn Decoder::current_row_width(self : Decoder) -> Int32 {
  self.row().length()
}

///|
pub fn Decoder::structure(self : Decoder) -> StreamStructure? {
  match self.frame_info {
    Some(frame) =>
      Some({
        soi_offset: self.header.soi_offset,
        sof_offset: self.header.sof_offset,
        sof_length: self.header.sof_length,
        eoi_offset: self.header.eoi_offset,
        frame,
        scans: self.scans.copy(),
        markers: self.header.markers.copy(),
      })
    None => None
  }
}

///|
pub fn Decoder::error_location(self : Decoder) -> ErrorLocation? {
  self.error_location
}

///|
pub fn Decoder::preset(self : Decoder) -> Preset? {
  self.scan.map(scan => scan.params.preset())
}

///|
/// A read-only borrow by contract. Do not modify it. Copy samples needed beyond `step`.
pub fn Decoder::row(self : Decoder) -> FixedArray[Int32] {
  match self.scan {
    Some(scan) if scan.last_row_idx >= 0 =>
      if scan.comp_prev.length() == 0 {
        scan.previous
      } else {
        scan.comp_prev[scan.last_row_comp]
      }
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
  let run = if scan.ilv == 2 { scan.joint_run_context() } else { id == 0 }
  if run {
    self.phase = RunBits
    self.phase_pred = a
  } else {
    self.start_regular(scan, a, b, c, id)
  }
}

///|
fn Decoder::start_regular(
  self : Decoder,
  scan : Scan,
  a : Int32,
  b : Int32,
  c : Int32,
  id : Int32,
) -> Unit {
  let index = abs_i32(id)
  let sign = sign_of(id)
  let k = golomb_order(scan.ctx_a[index], scan.ctx_n[index])
  let p = scan.params
  self.golomb.start(k, p.limit, p.qbpp)
  self.phase = Regular
  self.phase_index = index
  self.phase_sign = sign
  self.phase_pred = scan.prediction_at(a, b, c, index, sign)
  self.phase_flag = scan.regular_invert(index, k)
}

///|
fn Decoder::start_interruption(self : Decoder, scan : Scan, a : Int32) -> Unit {
  let b = scan.previous[scan.x]
  let (kind, predicted, sign) = if scan.ilv != 2 &&
    abs_i32(a - b) <= scan.params.near {
    (1, a, 1)
  } else {
    (0, b, sign_of(b - a))
  }
  let k = scan.run_order(kind)
  let p = scan.params
  self.golomb.start(k, p.limit - run_exponents[scan.run_index] - 1, p.qbpp)
  self.phase = Interruption
  self.phase_index = kind
  self.phase_pred = predicted
  self.phase_sign = sign
  self.phase_flag = if scan.run_negative_odd(kind, k) { 1 } else { 0 }
}

///|
fn fill_run(scan : Scan, value : Int32, count : Int32) -> Unit {
  let start = scan.x
  if scan.ilv == 2 {
    for slot in 0..<scan.comp_indices.length() {
      scan.select_component(slot)
      let a = scan.left()
      for i in 0..<count {
        scan.current[start + i] = a
      }
    }
    scan.select_component(0)
  } else {
    for i in 0..<count {
      scan.current[start + i] = value
    }
  }
  scan.x = start + count
}

///|
// Returns 1 when making progress, 0 when another entropy byte is needed, -1 on error.
fn Decoder::advance_scan(self : Decoder, scan : Scan) -> Int32 {
  let p = scan.params
  match self.phase {
    Sample => {
      self.start_sample(scan)
      1
    }
    Regular => {
      let mapped = self.golomb.read(self.bits)
      if mapped == -1 {
        return 0
      }
      if mapped == -2 {
        self.error = Some(InvalidData("Golomb unary exceeds limit"))
        return -1
      }
      let error = unmap_regular(mapped ^ self.phase_flag)
      if !p.is_valid_error(error) {
        self.error = Some(InvalidData("prediction residual outside RANGE"))
        return -1
      }
      scan.update_regular(self.phase_index, error)
      scan.store(p.reconstruct(self.phase_pred, self.phase_sign * error))
      if scan.active_comp != 0 && scan.ilv == 2 {
        let (a, b, c, d) = scan.neighbors()
        self.start_regular(scan, a, b, c, scan.context_id(a, b, c, d))
      } else {
        self.phase = Sample
      }
      1
    }
    RunBits => {
      if self.bits.left == 0 {
        return 0
      }
      let exponent = run_exponents[scan.run_index]
      let a = self.phase_pred
      if self.bits.take(1) == 1 {
        let block = 1 << exponent
        let count = min(block, scan.active_width - scan.x)
        fill_run(scan, a, count)
        if count == block {
          scan.run_index = min(31, scan.run_index + 1)
        }
      } else {
        self.phase = RunRemainder
        self.phase_flag = exponent
        self.phase_prefix = 0
      }
      1
    }
    RunRemainder => {
      let remaining = self.phase_flag
      let take = min(remaining, self.bits.left)
      let value = (self.phase_prefix << take) | self.bits.take(take)
      if take < remaining {
        self.phase_flag = remaining - take
        self.phase_prefix = value
        return 0
      }
      if value >= scan.active_width - scan.x {
        self.error = Some(InvalidData("run interruption outside row"))
        return -1
      }
      let a = self.phase_pred
      fill_run(scan, a, value)
      self.start_interruption(scan, a)
      1
    }
    Interruption => {
      let mapped = self.golomb.read(self.bits)
      if mapped == -1 {
        return 0
      }
      if mapped == -2 {
        self.error = Some(InvalidData("Golomb unary exceeds limit"))
        return -1
      }
      let kind = self.phase_index
      let shifted = mapped + kind
      let magnitude = (shifted + 1) >> 1
      let negative = ((shifted & 1) == 1) == (self.phase_flag != 0)
      let error = if negative { -magnitude } else { magnitude }
      if !p.is_valid_error(error) {
        self.error = Some(InvalidData("prediction residual outside RANGE"))
        return -1
      }
      scan.update_run(kind, error, mapped)
      scan.store(p.reconstruct(self.phase_pred, self.phase_sign * error))
      if scan.active_comp != 0 && scan.ilv == 2 {
        self.start_interruption(scan, scan.left())
      } else {
        scan.run_index = max(0, scan.run_index - 1)
        self.phase = Sample
      }
      1
    }
    _ => 0
  }
}

///|
fn Decoder::complete_current_scan(self : Decoder) -> Unit {
  if self.current_scan >= 0 && self.current_scan < self.scans.length() {
    let cur = self.scans[self.current_scan]
    self.scans[self.current_scan] = {
      ..cur,
      end_offset: self.scan_end_offset,
      completed: true,
    }
  }
}

///|
fn Decoder::record_error_location(self : Decoder) -> Unit {
  if self.scan is None {
    let scan_idx = if self.header.bits > 0 {
      self.header.scan_count
    } else {
      -1
    }
    let offset = if self.header.marker_offset >= 0L {
      self.header.marker_offset
    } else {
      self.bytes_read
    }
    self.error_location = Some({
      scan_index: scan_idx,
      component_id: self.header.last_component_id,
      marker: self.header.marker,
      offset,
    })
  } else {
    // Entropy errors refer to the component being read, even after earlier row deliveries.
    let comp_id = match self.scan {
      Some(scan) if scan.ilv == 2 => scan.comp_ids[scan.active_comp]
      _ => self.current_component_id()
    }
    let marker = match self.phase {
      EndPrefix | EndCode => self.header.marker
      _ => 0xDA
    }
    let offset = match self.phase {
      EndPrefix | EndCode if self.marker_offset >= 0L => self.marker_offset
      _ => self.bytes_read
    }
    self.error_location = Some({
      scan_index: self.current_scan,
      component_id: comp_id,
      marker,
      offset,
    })
  }
}

///|
// Returns 1 on Done (EOI after all scans), 0 while continuing, -1 if transitioned to inter-scan HeaderParser.
fn Decoder::advance_end(self : Decoder, byte : Int32) -> Int32 raise CodecError {
  match self.phase {
    StuffedPadding => {
      guard byte == 0 else { raise InvalidData("nonzero stuffed pad byte") }
      self.scan_end_offset = self.bytes_read
      self.phase = EndPrefix
    }
    EndPrefix => {
      guard byte == 0xFF else { raise InvalidData("missing EOI prefix") }
      self.marker_offset = self.bytes_read - 1L
      self.phase = EndCode
    }
    EndCode => {
      if byte == 0xFF {
        return 0
      }
      self.complete_current_scan()
      if byte == 0xD9 {
        guard self.header.all_components_scanned() else {
          raise InvalidData("premature EOI: missing frame components")
        }
        self.header.eoi_offset = self.marker_offset
        self.header.record_marker(0xD9, self.marker_offset, 2, -1, 0)
        return 1
      }
      if self.header.all_components_scanned() {
        match byte {
          0xDC => raise UnsupportedFeature("DNL marker")
          0xD0..<=0xD7 => raise UnsupportedFeature("restart marker")
          _ => raise InvalidData("unexpected marker after final scan")
        }
      }
      self.scan = None
      self.bits.reset()
      self.golomb.reset()
      self.phase = Sample
      self.header.begin_inter_scan(self.marker_offset)
      return -1
    }
    _ => ()
  }
  0
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
        (Some(frame), Some(scan)) if !scan.is_finished(frame.height) => {
          if scan.x == scan.active_width {
            let is_real = scan.next_line_or_finish()
            if self.current_scan >= 0 && self.current_scan < self.scans.length() {
              let cur = self.scans[self.current_scan]
              self.scans[self.current_scan] = {
                ..cur,
                rows_decoded: scan.total_rows,
              }
            }
            self.phase = if scan.is_finished(frame.height) {
              Padding
            } else {
              Sample
            }
            if is_real {
              break RowReady
            }
            continue
          }
          if scan.ilv != 2 && self.phase is Sample && consumed < length {
            let p = scan.params
            let prev = scan.previous
            let curr = scan.current
            let width = scan.active_width
            let width_m1 = width - 1
            let near = p.near
            let maxval = p.maxval
            let step = p.step
            let range = p.range
            let min_err = p.min_err
            let max_err = p.max_err
            let wrap = p.wrap
            let maxval_plus_near = p.maxval_plus_near
            let neg_near = p.neg_near
            let qbpp = p.qbpp
            let limit = p.limit
            let escape_limit = p.escape_limit
            let t3 = p.t3
            let q_lut = p.q_lut
            let q_lut_len_u = q_lut.length().reinterpret_as_uint()
            let reset = p.reset
            let ctx_a = scan.ctx_a
            let ctx_b = scan.ctx_b
            let ctx_c = scan.ctx_c
            let ctx_n = scan.ctx_n
            let run_a = scan.run_a
            let run_n = scan.run_n
            let run_neg = scan.run_neg
            let mut x = scan.x
            let mut run_index = scan.run_index
            let mut pos = offset + consumed
            let end = offset + length
            let mut bleft = self.bits.left
            let mask0 = if bleft == 0 { 0U } else { (1U << bleft) - 1U }
            let mut bbuf = if bleft == 0 {
              0U
            } else {
              (self.bits.word.reinterpret_as_uint() & mask0) << (32 - bleft)
            }
            let mut stuffed = self.bits.stuffed
            let mut stuffed_mask = 0U
            let mut pushed = 0
            let mut a = if x == 0 { prev[0] } else { curr[x - 1] }
            let mut b = prev[x]
            let mut c = if x == 0 { scan.previous_left } else { prev[x - 1] }
            let g2_0 = b - c
            let idx2_0 = g2_0 + t3
            let mut q2 = if idx2_0.reinterpret_as_uint() < q_lut_len_u {
              q_lut[idx2_0]
            } else if g2_0 < 0 {
              -4
            } else {
              4
            }
            let mut abort_fast = false
            while x < width && !abort_fast {
              while bleft <= 24 && pos < end {
                let byte = input[pos].to_int()
                if stuffed {
                  if byte >= 128 {
                    break
                  }
                  bbuf = bbuf | (byte.reinterpret_as_uint() << (25 - bleft))
                  bleft += 7
                  stuffed = false
                  stuffed_mask = (stuffed_mask << 1) | 1U
                  pos += 1
                  pushed += 1
                } else if byte == 255 {
                  if pos + 1 >= end || input[pos + 1].to_int() >= 128 {
                    break
                  }
                  bbuf = bbuf | (255U << (24 - bleft))
                  bleft += 8
                  stuffed = true
                  stuffed_mask = stuffed_mask << 1
                  pos += 1
                  pushed += 1
                } else {
                  bbuf = bbuf | (byte.reinterpret_as_uint() << (24 - bleft))
                  bleft += 8
                  stuffed = false
                  stuffed_mask = stuffed_mask << 1
                  pos += 1
                  pushed += 1
                }
              }
              let d = if x < width_m1 { prev[x + 1] } else { b }
              let g1 = d - b
              let idx1 = g1 + t3
              let q1 = if idx1.reinterpret_as_uint() < q_lut_len_u {
                q_lut[idx1]
              } else if g1 < 0 {
                -4
              } else {
                4
              }
              let g3 = c - a
              let idx3 = g3 + t3
              let q3 = if idx3.reinterpret_as_uint() < q_lut_len_u {
                q_lut[idx3]
              } else if g3 < 0 {
                -4
              } else {
                4
              }
              let id = (q1 * 9 + q2) * 9 + q3
              if id != 0 {
                let (index, sign) = if id < 0 { (-id, -1) } else { (id, 1) }
                let (low, high) = if a < b { (a, b) } else { (b, a) }
                let edge = if c >= high {
                  low
                } else if c <= low {
                  high
                } else {
                  a + b - c
                }
                let cc = ctx_c[index]
                let raw_pred = edge + cc * sign
                let predicted = if raw_pred < 0 {
                  0
                } else if raw_pred > maxval {
                  maxval
                } else {
                  raw_pred
                }
                let ca = ctx_a[index]
                let mut cn = ctx_n[index]
                let mut cb = ctx_b[index]
                let k = golomb_order(ca, cn)
                let zeros = bbuf.clz()
                if zeros < 31 && zeros < escape_limit && zeros + 1 + k <= bleft {
                  bbuf = bbuf << (zeros + 1)
                  bleft -= zeros + 1
                  let rem = if k == 0 {
                    0
                  } else {
                    let r = (bbuf >> (32 - k)).reinterpret_as_int()
                    bbuf = bbuf << k
                    bleft -= k
                    r
                  }
                  let mut mapped = (zeros << k) | rem
                  if near == 0 && k == 0 && cb << 1 <= -cn {
                    mapped = mapped ^ 1
                  }
                  let error = if (mapped & 1) == 0 {
                    mapped >> 1
                  } else {
                    -((mapped + 1) >> 1)
                  }
                  if error < min_err || error > max_err {
                    self.error = Some(
                      InvalidData("prediction residual outside RANGE"),
                    )
                    abort_fast = true
                    break
                  }
                  let err_abs = if error < 0 { -error } else { error }
                  let mut ua = ca + err_abs.reinterpret_as_uint()
                  cb = cb + error * step
                  if cn == reset {
                    ua = ua >> 1
                    cb = cb >> 1
                    cn = cn >> 1
                  }
                  cn += 1
                  let mut uc = cc
                  if cb <= -cn {
                    cb += cn
                    if cb <= -cn {
                      cb = -cn + 1
                    }
                    if uc > -128 {
                      uc -= 1
                    }
                  } else if cb > 0 {
                    cb -= cn
                    if cb > 0 {
                      cb = 0
                    }
                    if uc < 127 {
                      uc += 1
                    }
                  }
                  ctx_a[index] = ua
                  ctx_b[index] = cb
                  ctx_c[index] = uc
                  ctx_n[index] = cn
                  let recon = if near == 0 {
                    let corr = predicted + sign * error
                    if corr < 0 {
                      corr + range
                    } else if corr > maxval {
                      corr - range
                    } else {
                      corr
                    }
                  } else {
                    let corr = predicted + sign * error * step
                    let in_r = if corr < neg_near {
                      corr + wrap
                    } else if corr > maxval_plus_near {
                      corr - wrap
                    } else {
                      corr
                    }
                    clamp_sample(in_r, maxval)
                  }
                  curr[x] = recon
                  a = recon
                  c = b
                  b = d
                  q2 = q1
                  x += 1
                } else {
                  self.golomb.start(k, limit, qbpp)
                  self.phase = Regular
                  self.phase_index = index
                  self.phase_sign = sign
                  self.phase_pred = predicted
                  self.phase_flag = if near == 0 && k == 0 && cb << 1 <= -cn {
                    1
                  } else {
                    0
                  }
                  abort_fast = true
                  break
                }
              } else {
                while x < width {
                  while bleft <= 24 && pos < end {
                    let byte = input[pos].to_int()
                    if stuffed {
                      if byte >= 128 {
                        break
                      }
                      bbuf = bbuf | (byte.reinterpret_as_uint() << (25 - bleft))
                      bleft += 7
                      stuffed = false
                      stuffed_mask = (stuffed_mask << 1) | 1U
                      pos += 1
                      pushed += 1
                    } else if byte == 255 {
                      if pos + 1 >= end || input[pos + 1].to_int() >= 128 {
                        break
                      }
                      bbuf = bbuf | (255U << (24 - bleft))
                      bleft += 8
                      stuffed = true
                      stuffed_mask = stuffed_mask << 1
                      pos += 1
                      pushed += 1
                    } else {
                      bbuf = bbuf | (byte.reinterpret_as_uint() << (24 - bleft))
                      bleft += 8
                      stuffed = false
                      stuffed_mask = stuffed_mask << 1
                      pos += 1
                      pushed += 1
                    }
                  }
                  if bleft == 0 {
                    self.phase = RunBits
                    self.phase_pred = a
                    abort_fast = true
                    break
                  }
                  let exponent = run_exponents[run_index]
                  if bbuf.reinterpret_as_int() < 0 {
                    bbuf = bbuf << 1
                    bleft -= 1
                    let block = 1 << exponent
                    let rem_row = width - x
                    let count = if block < rem_row { block } else { rem_row }
                    let stop_x = x + count
                    while x < stop_x {
                      curr[x] = a
                      x += 1
                    }
                    if count == block && run_index < 31 {
                      run_index += 1
                    }
                  } else if bleft < 1 + exponent {
                    bbuf = bbuf << 1
                    bleft -= 1
                    self.phase = RunRemainder
                    self.phase_pred = a
                    self.phase_flag = exponent
                    self.phase_prefix = 0
                    abort_fast = true
                    break
                  } else {
                    bbuf = bbuf << 1
                    bleft -= 1
                    let run_rem = if exponent == 0 {
                      0
                    } else {
                      let r = (bbuf >> (32 - exponent)).reinterpret_as_int()
                      bbuf = bbuf << exponent
                      bleft -= exponent
                      r
                    }
                    if run_rem >= width - x {
                      self.error = Some(
                        InvalidData("run interruption outside row"),
                      )
                      abort_fast = true
                      break
                    }
                    let stop_x = x + run_rem
                    while x < stop_x {
                      curr[x] = a
                      x += 1
                    }
                    while bleft <= 24 && pos < end {
                      let byte = input[pos].to_int()
                      if stuffed {
                        if byte >= 128 {
                          break
                        }
                        bbuf = bbuf |
                          (byte.reinterpret_as_uint() << (25 - bleft))
                        bleft += 7
                        stuffed = false
                        stuffed_mask = (stuffed_mask << 1) | 1U
                        pos += 1
                        pushed += 1
                      } else if byte == 255 {
                        if pos + 1 >= end || input[pos + 1].to_int() >= 128 {
                          break
                        }
                        bbuf = bbuf | (255U << (24 - bleft))
                        bleft += 8
                        stuffed = true
                        stuffed_mask = stuffed_mask << 1
                        pos += 1
                        pushed += 1
                      } else {
                        bbuf = bbuf |
                          (byte.reinterpret_as_uint() << (24 - bleft))
                        bleft += 8
                        stuffed = false
                        stuffed_mask = stuffed_mask << 1
                        pos += 1
                        pushed += 1
                      }
                    }
                    let rb = prev[x]
                    let d_ab = a - rb
                    let (kind, predicted, sign) = if (if d_ab < 0 {
                        -d_ab
                      } else {
                        d_ab
                      }) <=
                      near {
                      (1, a, 1)
                    } else {
                      (0, rb, if rb < a { -1 } else { 1 })
                    }
                    let rn = run_n[kind]
                    let ra = run_a[kind]
                    let k = golomb_order(
                      ra +
                      ((rn >> 1) & (if kind != 0 { -1 } else { 0 })).reinterpret_as_uint(),
                      rn,
                    )
                    let r_esc = escape_limit - exponent - 1
                    let zeros = bbuf.clz()
                    if zeros < 31 && zeros < r_esc && zeros + 1 + k <= bleft {
                      bbuf = bbuf << (zeros + 1)
                      bleft -= zeros + 1
                      let rem = if k == 0 {
                        0
                      } else {
                        let r = (bbuf >> (32 - k)).reinterpret_as_int()
                        bbuf = bbuf << k
                        bleft -= k
                        r
                      }
                      let mapped = (zeros << k) | rem
                      let shifted = mapped + kind
                      let magnitude = (shifted + 1) >> 1
                      let neg_odd = k != 0 || run_neg[kind] << 1 >= rn
                      let negative = ((shifted & 1) == 1) == neg_odd
                      let error = if negative { -magnitude } else { magnitude }
                      if error < min_err || error > max_err {
                        self.error = Some(
                          InvalidData("prediction residual outside RANGE"),
                        )
                        abort_fast = true
                        break
                      }
                      let mut rneg = run_neg[kind] +
                        (if error < 0 { 1 } else { 0 })
                      let mut ua = ra +
                        ((mapped + 1 - kind) >> 1).reinterpret_as_uint()
                      let mut un = rn
                      if un == reset {
                        ua = ua >> 1
                        un = un >> 1
                        rneg = rneg >> 1
                      }
                      run_a[kind] = ua
                      run_n[kind] = un + 1
                      run_neg[kind] = rneg
                      let recon = p.reconstruct(predicted, sign * error)
                      curr[x] = recon
                      x += 1
                      if run_index > 0 {
                        run_index -= 1
                      }
                      a = recon
                      if x < width {
                        b = prev[x]
                        c = prev[x - 1]
                        let g2_r = b - c
                        let idx2_r = g2_r + t3
                        q2 = if idx2_r.reinterpret_as_uint() < q_lut_len_u {
                          q_lut[idx2_r]
                        } else if g2_r < 0 {
                          -4
                        } else {
                          4
                        }
                      }
                      break
                    } else {
                      self.golomb.start(k, limit - exponent - 1, qbpp)
                      self.phase = Interruption
                      self.phase_index = kind
                      self.phase_pred = predicted
                      self.phase_sign = sign
                      self.phase_flag = if k != 0 || run_neg[kind] << 1 >= rn {
                        1
                      } else {
                        0
                      }
                      abort_fast = true
                      break
                    }
                  }
                }
              }
            }
            while pushed > 0 {
              let w = if (stuffed_mask & 1U) != 0U { 7 } else { 8 }
              if bleft < w {
                break
              }
              pos -= 1
              bleft -= w
              stuffed = w == 7
              stuffed_mask = stuffed_mask >> 1
              pushed -= 1
            }
            self.bits.left = bleft
            self.bits.word = if bleft == 0 {
              0
            } else {
              (bbuf >> (32 - bleft)).reinterpret_as_int()
            }
            self.bits.stuffed = stuffed
            scan.x = x
            scan.run_index = run_index
            let next_consumed = pos - offset
            self.bytes_read += (next_consumed - consumed).to_int64()
            consumed = next_consumed
            if self.error is Some(err) {
              self.error = None
              raise err
            }
            if scan.x == width || !(self.phase is Sample) || consumed < length {
              continue
            }
          }
          let res = self.advance_scan(scan)
          if res > 0 {
            continue
          }
          if res < 0 {
            if self.error is Some(err) {
              self.error = None
              raise err
            }
          }
        }
        (Some(_), Some(_)) if self.phase is Padding => {
          guard self.bits.take(self.bits.left) == 0 else {
            raise InvalidData("nonzero entropy padding")
          }
          if !self.bits.stuffed {
            self.scan_end_offset = self.bytes_read
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
      self.bytes_read += 1L
      match self.scan {
        None =>
          if self.header.accept(byte, self.bytes_read)
            is Some((frame, params, scan_info)) {
            let info = match self.frame_info {
              Some(existing) => existing
              None => {
                let created = self.header.frame_info()
                self.frame_info = Some(created)
                created
              }
            }
            self.frame = Some(frame)
            self.scans.push(scan_info)
            self.current_scan = self.scans.length() - 1
            self.scan = Some(Scan::new_interleaved(info, scan_info, params))
          }
        Some(_) =>
          match self.phase {
            StuffedPadding | EndPrefix | EndCode => {
              let end_state = self.advance_end(byte)
              if end_state > 0 {
                break Done
              } else if end_state < 0 {
                if self.header.accept(byte, self.bytes_read)
                  is Some((frame, params, scan_info)) {
                  let info = match self.frame_info {
                    Some(existing) => existing
                    None => self.header.frame_info()
                  }
                  self.frame = Some(frame)
                  self.scans.push(scan_info)
                  self.current_scan = self.scans.length() - 1
                  self.scan = Some(
                    Scan::new_interleaved(info, scan_info, params),
                  )
                }
              }
            }
            _ => {
              let err_code = self.bits.byte(byte)
              if err_code == 1 {
                raise UnsupportedFeature("restart marker")
              } else if err_code == 2 {
                raise InvalidData("marker inside an incomplete scan")
              }
            }
          }
      }
    } nobreak {
      NeedInput
    }
  } catch {
    error => {
      self.record_error_location()
      Failed(error)
    }
  }
  match status {
    Done | Failed(_) => self.terminal = Some(status)
    _ => ()
  }
  { consumed, status, }
}
