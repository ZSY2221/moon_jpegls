///|
priv struct ResolvedScan {
  scan_info : ScanInfo
  params : Parameters
  lse_marker : Preset?
}

///|
pub struct Encoder {
  priv mut frame : Frame
  priv frame_info : FrameInfo
  priv scans : Array[ResolvedScan]
  priv mut scan_index : Int32
  priv mut scan : Scan
  priv bits : BitWriter
  priv mut scan_header : Bool
  priv mut trailer : Bool
  priv mut run : Int32
  priv vector : FixedArray[Int32]
  priv mut vector_size : Int32
  priv mut terminal : Status?
}

///|
/// Creates a multi-component encoder supporting ILV=0, ILV=1 and ILV=2 scans.
pub fn Encoder::new_scans(
  frame_info : FrameInfo,
  scans : Array[MultiScanSpec],
  limits : Limits,
) -> Encoder raise CodecError {
  validate_limits(limits)
  let count = frame_info.components.length()
  guard frame_info.bits >= 2 && frame_info.bits <= 16 else {
    raise InvalidArgument("sample precision must be in 2..16")
  }
  validate_frame_dimensions(frame_info.width, frame_info.height, count, limits)
  for index in 0..<count {
    let comp = frame_info.components[index]
    guard comp.id >= 0 && comp.id <= 255 else {
      raise InvalidArgument("component id must be in 0..255")
    }
    guard comp.h_sampling >= 1 &&
      comp.h_sampling <= 4 &&
      comp.v_sampling >= 1 &&
      comp.v_sampling <= 4 else {
      raise InvalidArgument("component sampling factors must be in 1..4")
    }
    for earlier in 0..<index {
      guard comp.id != frame_info.components[earlier].id else {
        raise InvalidArgument("duplicate frame component id")
      }
    }
  }
  guard scans.length() > 0 else {
    raise InvalidArgument("at least one scan is required")
  }
  let seen = Array::make(count, false)
  let mut scanned_count = 0
  let mut max_vector_size = 0
  let resolved : Array[ResolvedScan] = []
  let mut last_emitted_lse : Preset? = None
  for i in 0..<scans.length() {
    let spec = scans[i]
    let ns = spec.component_ids.length()
    guard ns >= 1 && ns <= 4 else {
      raise InvalidArgument("scan component count must be in 1..4")
    }
    guard spec.point_transform == 0 else {
      raise UnsupportedFeature("point transform is not supported yet")
    }
    guard (ns == 1 && spec.interleave == 0) ||
      (ns > 1 && (spec.interleave == 1 || spec.interleave == 2)) else {
      raise InvalidArgument("invalid scan interleave mode")
    }
    if spec.interleave == 2 {
      max_vector_size = max(max_vector_size, ns)
    }
    let comp_indices : Array[Int32] = []
    let comp_ids : Array[Int32] = []
    for cid in spec.component_ids {
      guard frame_info.find_component(cid) is Some(comp_idx) else {
        raise InvalidArgument("scan references an undeclared component id")
      }
      guard !seen[comp_idx] else {
        raise InvalidArgument("duplicate scan for component id")
      }
      if spec.interleave == 2 && comp_indices.length() > 0 {
        let first = comp_indices[0]
        guard frame_info.component_width(comp_idx) ==
          frame_info.component_width(first) &&
          frame_info.component_height(comp_idx) ==
          frame_info.component_height(first) else {
          raise InvalidArgument(
            "sample-interleaved components must have identical dimensions",
          )
        }
        guard comp_idx > comp_indices[comp_indices.length() - 1] else {
          raise InvalidArgument(
            "sample-interleaved components must follow frame order",
          )
        }
      }
      seen[comp_idx] = true
      comp_indices.push(comp_idx)
      comp_ids.push(cid)
      scanned_count += 1
    }
    let scan_frame : Frame = {
      width: frame_info.width,
      height: frame_info.height,
      bits: frame_info.bits,
      near: spec.near,
    }
    let effective = resolve_preset(scan_frame, spec.preset)
    let needs_lse = spec.preset != Preset::defaults() ||
      (i == 0 && frame_info.bits > 12) ||
      last_emitted_lse is Some(_)
    let lse_marker = if needs_lse && last_emitted_lse != Some(effective) {
      last_emitted_lse = Some(effective)
      Some(effective)
    } else {
      None
    }
    let scan_info : ScanInfo = {
      scan_index: i,
      component_index: comp_indices[0],
      component_id: comp_ids[0],
      component_indices: comp_indices,
      component_ids: comp_ids,
      near: spec.near,
      interleave: spec.interleave,
      point_transform: spec.point_transform,
      preset: effective,
      header_offset: 0L,
      entropy_offset: 0L,
      end_offset: 0L,
      rows_decoded: 0,
      completed: false,
    }
    resolved.push({
      scan_info,
      params: Parameters::new(effective, spec.near),
      lse_marker,
    })
  }
  guard scanned_count == count else {
    raise InvalidArgument("scans must cover every declared frame component")
  }
  for comp in frame_info.components {
    guard comp.h_sampling == 1 && comp.v_sampling == 1 else {
      raise UnsupportedFeature("component sampling factors must be 1x1")
    }
  }
  // A vector can emit four 64-bit Golomb symbols plus the run prefix.
  // Include the partially filled byte and allow as few as seven bits per byte.
  let vector_bytes = ceil_div(64 * max_vector_size + 16 + 7, 7)
  let cap = max(32, max(16 + 3 * count, vector_bytes))
  let bits = BitWriter::with_capacity(cap)
  bits.frame_header(frame_info)
  let first = resolved[0]
  {
    frame: {
      width: frame_info.width,
      height: frame_info.height,
      bits: frame_info.bits,
      near: first.scan_info.near,
    },
    frame_info,
    scans: resolved,
    scan_index: 0,
    scan: Scan::new_interleaved(frame_info, first.scan_info, first.params),
    bits,
    scan_header: false,
    trailer: false,
    run: -1,
    vector: FixedArray::make(max_vector_size, 0),
    vector_size: 0,
    terminal: None,
  }
}

///|
/// Creates a multi-component non-interleaved (ILV=0, Ns=1 per scan) encoder.
pub fn Encoder::new_multicomponent(
  frame_info : FrameInfo,
  scans : Array[ScanSpec],
  limits : Limits,
) -> Encoder raise CodecError {
  let multi : Array[MultiScanSpec] = []
  for spec in scans {
    multi.push({
      component_ids: [spec.component_id],
      interleave: 0,
      near: spec.near,
      point_transform: 0,
      preset: spec.preset,
    })
  }
  Encoder::new_scans(frame_info, multi, limits)
}

///|
pub fn Encoder::new(
  frame : Frame,
  limits : Limits,
  preset~ : Preset = Preset::defaults(),
) -> Encoder raise CodecError {
  Encoder::new_multicomponent(
    {
      width: frame.width,
      height: frame.height,
      bits: frame.bits,
      components: [{ id: 1, h_sampling: 1, v_sampling: 1 }],
    },
    [{ component_id: 1, near: frame.near, preset }],
    limits,
  )
}

///|
pub fn Encoder::frame_info(self : Encoder) -> FrameInfo {
  self.frame_info
}

///|
pub fn Encoder::scan_index(self : Encoder) -> Int32 {
  self.scan_index
}

///|
pub fn Encoder::scan_count(self : Encoder) -> Int32 {
  self.scans.length()
}

///|
pub fn Encoder::component_index(self : Encoder) -> Int32 {
  self.scans[self.scan_index].scan_info.component_index
}

///|
pub fn Encoder::component_id(self : Encoder) -> Int32 {
  self.scans[self.scan_index].scan_info.component_id
}

///|
pub fn Encoder::current_component_index(self : Encoder) -> Int32 {
  let slot = if self.scan.last_row_idx >= 0 {
    self.scan.last_row_comp
  } else {
    self.scan.active_comp
  }
  self.scan.comp_indices[slot]
}

///|
pub fn Encoder::current_component_id(self : Encoder) -> Int32 {
  let slot = if self.scan.last_row_idx >= 0 {
    self.scan.last_row_comp
  } else {
    self.scan.active_comp
  }
  self.scan.comp_ids[slot]
}

///|
pub fn Encoder::current_row(self : Encoder) -> Int32 {
  self.scan.last_row_idx
}

///|
pub fn Encoder::row_index(self : Encoder) -> Int32 {
  if self.scan.comp_prev.length() == 0 {
    self.scan.rows
  } else {
    self.scan.total_rows
  }
}

///|
pub fn Encoder::preset(self : Encoder) -> Preset {
  self.scan.params.preset()
}

///|
pub fn Encoder::workspace_bytes(self : Encoder) -> Int32 {
  self.scan.workspace_bytes() +
  self.bits.pending.length() +
  4 * self.vector.length()
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
  let index = abs_i32(id)
  let sign = sign_of(id)
  let predicted = scan.prediction_at(a, b, c, index, sign)
  let error = p.reduce(sign * (sample - predicted))
  let k = golomb_order(scan.ctx_a[index], scan.ctx_n[index])
  let mapped = map_regular(error) ^ scan.regular_invert(index, k)
  self.bits.symbol(mapped, k, p.limit, p.qbpp)
  scan.update_regular(index, error)
  let recon = if p.near == 0 { sample } else { p.reconstruct(predicted, sign * error) }
  scan.store(recon)
}

///|
fn Encoder::run_sample(self : Encoder, sample : Int32, a : Int32) -> Unit {
  let scan = self.scan
  let p = scan.params
  let exponent = run_exponents[scan.run_index]
  if abs_i32(sample - a) <= p.near {
    self.run += 1
    scan.store(a)
    if self.run == 1 << exponent {
      self.bits.bits(1, 1)
      scan.run_index = min(31, scan.run_index + 1)
      self.run = 0
    }
    if scan.x == scan.active_width && self.run != 0 {
      self.bits.bits(1, 1)
    }
  } else {
    self.bits.bits(0, 1)
    self.bits.bits(self.run, exponent)
    let b = scan.previous[scan.x]
    let (kind, predicted, sign) = if abs_i32(a - b) <= p.near {
      (1, a, 1)
    } else {
      (0, b, sign_of(b - a))
    }
    self.interruption(sample, kind, predicted, sign, exponent)
    scan.run_index = max(0, scan.run_index - 1)
    self.run = -1
  }
}

///|
fn Encoder::interruption(
  self : Encoder,
  sample : Int32,
  kind : Int32,
  predicted : Int32,
  sign : Int32,
  exponent : Int32,
) -> Unit {
  let scan = self.scan
  let p = scan.params
  let k = scan.run_order(kind)
  let error = p.reduce(sign * (sample - predicted))
  let mapped_sign = if error != 0 &&
    (error < 0) == scan.run_negative_odd(kind, k) {
    1
  } else {
    0
  }
  let mapped = 2 * abs_i32(error) - kind - mapped_sign
  self.bits.symbol(mapped, k, p.limit - exponent - 1, p.qbpp)
  scan.update_run(kind, error, mapped)
  scan.store(p.reconstruct(predicted, sign * error))
}

///|
fn Encoder::sample_vector(self : Encoder, value : Int32) -> Unit {
  let scan = self.scan
  let count = scan.comp_indices.length()
  self.vector[self.vector_size] = value
  self.vector_size += 1
  if self.vector_size < count {
    return
  }
  self.vector_size = 0
  if self.run < 0 && scan.joint_run_context() {
    self.run = 0
  }
  if self.run < 0 {
    for slot in 0..<count {
      let (a, b, c, d) = scan.neighbors()
      self.regular(self.vector[slot], a, b, c, scan.context_id(a, b, c, d))
    }
    return
  }
  let mut continues = true
  for slot in 0..<count {
    scan.select_component(slot)
    if abs_i32(self.vector[slot] - scan.left()) > scan.params.near {
      continues = false
      break
    }
  }
  scan.select_component(0)
  let exponent = run_exponents[scan.run_index]
  if continues {
    for _ in 0..<count {
      scan.store(scan.left())
    }
    self.run += 1
    if self.run == 1 << exponent {
      self.bits.bits(1, 1)
      scan.run_index = min(31, scan.run_index + 1)
      self.run = 0
    }
    if scan.x == scan.active_width && self.run != 0 {
      self.bits.bits(1, 1)
    }
  } else {
    self.bits.bits(0, 1)
    self.bits.bits(self.run, exponent)
    for slot in 0..<count {
      let b = scan.previous[scan.x]
      self.interruption(
        self.vector[slot],
        0,
        b,
        sign_of(b - scan.left()),
        exponent,
      )
    }
    scan.run_index = max(0, scan.run_index - 1)
    self.run = -1
  }
}

///|
fn Encoder::sample(self : Encoder, value : Int32) -> Unit {
  let scan = self.scan
  if self.run >= 0 {
    self.run_sample(value, scan.left())
  } else {
    let (a, b, c, d) = scan.neighbors()
    let id = scan.context_id(a, b, c, d)
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
  let out_safe = output.length() - 14
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
        let cur = self.scans[self.scan_index]
        if cur.lse_marker is Some(marker_preset) {
          self.bits.lse1(marker_preset)
        }
        let si = cur.scan_info
        self.bits.scan_header(
          si.component_ids,
          si.near,
          si.interleave,
          si.point_transform,
        )
        continue
      }
      if self.trailer {
        break Done
      }
      if self.scan.x == self.scan.active_width {
        let is_real = self.scan.next_line_or_finish()
        self.run = -1
        if is_real {
          break RowReady
        }
        continue
      }
      if self.scan.is_finished(self.frame.height) {
        if self.scan_index + 1 < self.scans.length() {
          self.bits.finish_scan()
          self.scan_index += 1
          let next_cfg = self.scans[self.scan_index]
          self.scan = Scan::new_interleaved(
            self.frame_info,
            next_cfg.scan_info,
            next_cfg.params,
          )
          self.frame = {
            width: self.frame_info.width,
            height: self.frame_info.height,
            bits: self.frame_info.bits,
            near: next_cfg.scan_info.near,
          }
          self.run = -1
          self.scan_header = false
          continue
        }
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
      if self.scan.ilv != 2 && produced <= out_safe {
        let scan = self.scan
        let p = scan.params
        let prev = scan.previous
        let curr = scan.current
        let width = scan.active_width
        let width_m1 = width - 1
        let near = p.near
        let maxval = p.maxval
        let maxval_u = maxval.reinterpret_as_uint()
        let step = p.step
        let range = p.range
        let half_range = p.half_range
        let min_err = p.min_err
        let qbpp = p.qbpp
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
        let mut run = self.run
        let mut run_index = scan.run_index
        let mut pos = offset + consumed
        let end = offset + length
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
        let mut cap = 8
        let mut nbits = 8 - self.bits.free
        let init_mask = (1U << nbits) - 1U
        let mut buf = (self.bits.word >> self.bits.free).reinterpret_as_uint() &
          init_mask
        let mut invalid_sample = false
        while x < width && pos < end && produced <= out_safe {
          if run >= 0 {
            let sample = input[pos]
            if sample.reinterpret_as_uint() > maxval_u {
              invalid_sample = true
              break
            }
            let exponent = run_exponents[run_index]
            let diff = sample - a
            if (if diff < 0 { -diff } else { diff }) <= near {
              run += 1
              curr[x] = a
              x += 1
              pos += 1
              if run == 1 << exponent {
                buf = (buf << 1) | 1U
                nbits += 1
                if nbits >= cap {
                  nbits -= cap
                  let out_byte = (buf >> nbits).reinterpret_as_int() &
                    (if cap == 7 { 0x7F } else { 0xFF })
                  output[produced] = out_byte.to_byte()
                  produced += 1
                  cap = if out_byte == 255 { 7 } else { 8 }
                }
                if run_index < 31 {
                  run_index += 1
                }
                run = 0
              }
              if x == width && run != 0 {
                buf = (buf << 1) | 1U
                nbits += 1
                if nbits >= cap {
                  nbits -= cap
                  let out_byte = (buf >> nbits).reinterpret_as_int() &
                    (if cap == 7 { 0x7F } else { 0xFF })
                  output[produced] = out_byte.to_byte()
                  produced += 1
                  cap = if out_byte == 255 { 7 } else { 8 }
                }
              }
            } else {
              // Emit 0 bit + run remainder (1 + exponent bits, <= 16 <= 24)
              let prefix_len = 1 + exponent
              buf = (buf << prefix_len) | run.reinterpret_as_uint()
              nbits += prefix_len
              while nbits >= cap {
                nbits -= cap
                let out_byte = (buf >> nbits).reinterpret_as_int() &
                  (if cap == 7 { 0x7F } else { 0xFF })
                output[produced] = out_byte.to_byte()
                produced += 1
                cap = if out_byte == 255 { 7 } else { 8 }
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
              let error = p.reduce(sign * (sample - predicted))
              let neg_odd = k != 0 || run_neg[kind] << 1 >= rn
              let mapped_sign = if error == 0 {
                0
              } else if (error < 0) == neg_odd {
                1
              } else {
                0
              }
              let err_mag = if error < 0 { -error } else { error }
              let mapped = (err_mag << 1) - kind - mapped_sign
              let r_esc = escape_limit - exponent - 1
              let unary = mapped >> k
              if unary < r_esc {
                let total = unary + 1 + k
                if total <= 24 {
                  let code = (1U << k) |
                    (mapped & ((1 << k) - 1)).reinterpret_as_uint()
                  buf = (buf << total) | code
                  nbits += total
                  while nbits >= cap {
                    nbits -= cap
                    let out_byte = (buf >> nbits).reinterpret_as_int() &
                      (if cap == 7 { 0x7F } else { 0xFF })
                    output[produced] = out_byte.to_byte()
                    produced += 1
                    cap = if out_byte == 255 { 7 } else { 8 }
                  }
                } else {
                  let mut zeros_left = unary
                  while zeros_left > 24 {
                    buf = buf << 24
                    nbits += 24
                    zeros_left -= 24
                    while nbits >= cap {
                      nbits -= cap
                      let out_byte = (buf >> nbits).reinterpret_as_int() &
                        (if cap == 7 { 0x7F } else { 0xFF })
                      output[produced] = out_byte.to_byte()
                      produced += 1
                      cap = if out_byte == 255 { 7 } else { 8 }
                    }
                  }
                  let rem_len = zeros_left + 1 + k
                  if rem_len <= 24 {
                    let code = (1U << k) |
                      (mapped & ((1 << k) - 1)).reinterpret_as_uint()
                    buf = (buf << rem_len) | code
                    nbits += rem_len
                    while nbits >= cap {
                      nbits -= cap
                      let out_byte = (buf >> nbits).reinterpret_as_int() &
                        (if cap == 7 { 0x7F } else { 0xFF })
                      output[produced] = out_byte.to_byte()
                      produced += 1
                      cap = if out_byte == 255 { 7 } else { 8 }
                    }
                  } else {
                    buf = buf << zeros_left
                    nbits += zeros_left
                    while nbits >= cap {
                      nbits -= cap
                      let out_byte = (buf >> nbits).reinterpret_as_int() &
                        (if cap == 7 { 0x7F } else { 0xFF })
                      output[produced] = out_byte.to_byte()
                      produced += 1
                      cap = if out_byte == 255 { 7 } else { 8 }
                    }
                    let code = (1U << k) |
                      (mapped & ((1 << k) - 1)).reinterpret_as_uint()
                    buf = (buf << (1 + k)) | code
                    nbits += 1 + k
                    while nbits >= cap {
                      nbits -= cap
                      let out_byte = (buf >> nbits).reinterpret_as_int() &
                        (if cap == 7 { 0x7F } else { 0xFF })
                      output[produced] = out_byte.to_byte()
                      produced += 1
                      cap = if out_byte == 255 { 7 } else { 8 }
                    }
                  }
                }
              } else {
                let mut zeros_left = r_esc
                while zeros_left > 24 {
                  buf = buf << 24
                  nbits += 24
                  zeros_left -= 24
                  while nbits >= cap {
                    nbits -= cap
                    let out_byte = (buf >> nbits).reinterpret_as_int() &
                      (if cap == 7 { 0x7F } else { 0xFF })
                    output[produced] = out_byte.to_byte()
                    produced += 1
                    cap = if out_byte == 255 { 7 } else { 8 }
                  }
                }
                buf = buf << zeros_left
                nbits += zeros_left
                while nbits >= cap {
                  nbits -= cap
                  let out_byte = (buf >> nbits).reinterpret_as_int() &
                    (if cap == 7 { 0x7F } else { 0xFF })
                  output[produced] = out_byte.to_byte()
                  produced += 1
                  cap = if out_byte == 255 { 7 } else { 8 }
                }
                let code = (1U << qbpp) |
                  ((mapped - 1) & ((1 << qbpp) - 1)).reinterpret_as_uint()
                buf = (buf << (1 + qbpp)) | code
                nbits += 1 + qbpp
                while nbits >= cap {
                  nbits -= cap
                  let out_byte = (buf >> nbits).reinterpret_as_int() &
                    (if cap == 7 { 0x7F } else { 0xFF })
                  output[produced] = out_byte.to_byte()
                  produced += 1
                  cap = if out_byte == 255 { 7 } else { 8 }
                }
              }
              let mut neg = run_neg[kind] + (if error < 0 { 1 } else { 0 })
              let mut ua = ra + ((mapped + 1 - kind) >> 1).reinterpret_as_uint()
              let mut un = rn
              if un == reset {
                ua = ua >> 1
                un = un >> 1
                neg = neg >> 1
              }
              run_a[kind] = ua
              run_n[kind] = un + 1
              run_neg[kind] = neg
              let recon = p.reconstruct(predicted, sign * error)
              curr[x] = recon
              x += 1
              pos += 1
              if run_index > 0 {
                run_index -= 1
              }
              run = -1
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
            }
          } else {
            let sample = input[pos]
            if sample.reinterpret_as_uint() > maxval_u {
              invalid_sample = true
              break
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
            if id == 0 {
              run = 0
              continue
            }
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
            let delta = sign * (sample - predicted)
            let ca = ctx_a[index]
            let mut cn = ctx_n[index]
            let mut cb = ctx_b[index]
            let k = golomb_order(ca, cn)
            let quantized = if near == 0 {
              delta
            } else if delta < 0 {
              let mag = -delta + near
              let q = match step {
                3 => mag / 3
                5 => mag / 5
                7 => mag / 7
                _ => mag / step
              }
              -q
            } else {
              let mag = delta + near
              match step {
                3 => mag / 3
                5 => mag / 5
                7 => mag / 7
                _ => mag / step
              }
            }
            let error = if quantized >= half_range {
              quantized - range
            } else if quantized < min_err {
              quantized + range
            } else {
              quantized
            }
            let invert = if near == 0 && k == 0 && cb << 1 <= -cn {
              1
            } else {
              0
            }
            let mapped = (if error < 0 { -2 * error - 1 } else { 2 * error }) ^
              invert
            let unary = mapped >> k
            if unary < escape_limit {
              let total = unary + 1 + k
              if total <= 24 {
                let code = (1U << k) |
                  (mapped & ((1 << k) - 1)).reinterpret_as_uint()
                buf = (buf << total) | code
                nbits += total
                while nbits >= cap {
                  nbits -= cap
                  let out_byte = (buf >> nbits).reinterpret_as_int() &
                    (if cap == 7 { 0x7F } else { 0xFF })
                  output[produced] = out_byte.to_byte()
                  produced += 1
                  cap = if out_byte == 255 { 7 } else { 8 }
                }
              } else {
                let mut zeros_left = unary
                while zeros_left > 24 {
                  buf = buf << 24
                  nbits += 24
                  zeros_left -= 24
                  while nbits >= cap {
                    nbits -= cap
                    let out_byte = (buf >> nbits).reinterpret_as_int() &
                      (if cap == 7 { 0x7F } else { 0xFF })
                    output[produced] = out_byte.to_byte()
                    produced += 1
                    cap = if out_byte == 255 { 7 } else { 8 }
                  }
                }
                let rem_len = zeros_left + 1 + k
                if rem_len <= 24 {
                  let code = (1U << k) |
                    (mapped & ((1 << k) - 1)).reinterpret_as_uint()
                  buf = (buf << rem_len) | code
                  nbits += rem_len
                  while nbits >= cap {
                    nbits -= cap
                    let out_byte = (buf >> nbits).reinterpret_as_int() &
                      (if cap == 7 { 0x7F } else { 0xFF })
                    output[produced] = out_byte.to_byte()
                    produced += 1
                    cap = if out_byte == 255 { 7 } else { 8 }
                  }
                } else {
                  buf = buf << zeros_left
                  nbits += zeros_left
                  while nbits >= cap {
                    nbits -= cap
                    let out_byte = (buf >> nbits).reinterpret_as_int() &
                      (if cap == 7 { 0x7F } else { 0xFF })
                    output[produced] = out_byte.to_byte()
                    produced += 1
                    cap = if out_byte == 255 { 7 } else { 8 }
                  }
                  let code = (1U << k) |
                    (mapped & ((1 << k) - 1)).reinterpret_as_uint()
                  buf = (buf << (1 + k)) | code
                  nbits += 1 + k
                  while nbits >= cap {
                    nbits -= cap
                    let out_byte = (buf >> nbits).reinterpret_as_int() &
                      (if cap == 7 { 0x7F } else { 0xFF })
                    output[produced] = out_byte.to_byte()
                    produced += 1
                    cap = if out_byte == 255 { 7 } else { 8 }
                  }
                }
              }
            } else {
              let mut zeros_left = escape_limit
              while zeros_left > 24 {
                buf = buf << 24
                nbits += 24
                zeros_left -= 24
                while nbits >= cap {
                  nbits -= cap
                  let out_byte = (buf >> nbits).reinterpret_as_int() &
                    (if cap == 7 { 0x7F } else { 0xFF })
                  output[produced] = out_byte.to_byte()
                  produced += 1
                  cap = if out_byte == 255 { 7 } else { 8 }
                }
              }
              buf = buf << zeros_left
              nbits += zeros_left
              while nbits >= cap {
                nbits -= cap
                let out_byte = (buf >> nbits).reinterpret_as_int() &
                  (if cap == 7 { 0x7F } else { 0xFF })
                output[produced] = out_byte.to_byte()
                produced += 1
                cap = if out_byte == 255 { 7 } else { 8 }
              }
              let code = (1U << qbpp) |
                ((mapped - 1) & ((1 << qbpp) - 1)).reinterpret_as_uint()
              buf = (buf << (1 + qbpp)) | code
              nbits += 1 + qbpp
              while nbits >= cap {
                nbits -= cap
                let out_byte = (buf >> nbits).reinterpret_as_int() &
                  (if cap == 7 { 0x7F } else { 0xFF })
                output[produced] = out_byte.to_byte()
                produced += 1
                cap = if out_byte == 255 { 7 } else { 8 }
              }
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
              sample
            } else {
              p.reconstruct(predicted, sign * error)
            }
            curr[x] = recon
            a = recon
            c = b
            b = d
            q2 = q1
            x += 1
            pos += 1
          }
        }
        scan.x = x
        scan.run_index = run_index
        self.run = run
        self.bits.free = cap - nbits
        let rem_mask = (1U << nbits) - 1U
        self.bits.word = ((buf & rem_mask) << self.bits.free).reinterpret_as_int()
        consumed = pos - offset
        if invalid_sample {
          raise InvalidArgument("sample is outside MAXVAL")
        }
        continue
      }
      let sample = input[offset + consumed]
      guard sample >= 0 && sample <= self.scan.params.maxval else {
        raise InvalidArgument("sample is outside MAXVAL")
      }
      consumed += 1
      if self.scan.ilv == 2 {
        self.sample_vector(sample)
      } else {
        self.sample(sample)
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
  { consumed, produced, status, }
}
