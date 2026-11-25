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
pub fn Encoder::new(
  frame : Frame,
  limits : Limits,
  preset~ : Preset = Preset::defaults(),
) -> Encoder raise CodecError {
  validate_limits(limits)
  validate_dimensions(frame.width, frame.height, limits)
  let effective = resolve_preset(frame, preset)
  let params = Parameters::new(effective, frame.near)
  let bits = BitWriter::new()
  let marker = if preset != Preset::defaults() || frame.bits > 12 {
    Some(effective)
  } else {
    None
  }
  bits.header(frame, marker)
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
pub fn Encoder::preset(self : Encoder) -> Preset {
  self.scan.params.preset()
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
    if scan.x == scan.width && self.run != 0 {
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
    let k = scan.run_order(kind)
    let error = p.reduce(sign * (sample - predicted))
    let mapped_sign = if error == 0 {
      0
    } else if (error < 0) == scan.run_negative_odd(kind, k) {
      1
    } else {
      0
    }
    let mapped = 2 * abs_i32(error) - kind - mapped_sign
    self.bits.symbol(mapped, k, p.limit - exponent - 1, p.qbpp)
    scan.update_run(kind, error, mapped)
    scan.store(p.reconstruct(predicted, sign * error))
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
    let x = scan.x
    let a = if x == 0 { scan.previous[0] } else { scan.current[x - 1] }
    let b = scan.previous[x]
    let c = if x == 0 { scan.previous_left } else { scan.previous[x - 1] }
    let d = scan.previous[min(x + 1, scan.width - 1)]
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
      if produced <= out_safe {
        let scan = self.scan
        let p = scan.params
        let prev = scan.previous
        let curr = scan.current
        let width = scan.width
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
              let (kind, predicted, sign) = if (
                  if d_ab < 0 { -d_ab } else { d_ab }
                ) <=
                near {
                (1, a, 1)
              } else {
                (0, rb, if rb < a { -1 } else { 1 })
              }
              let rn = run_n[kind]
              let ra = run_a[kind]
              let k = golomb_order(
                ra + ((rn >> 1) & (if kind != 0 { -1 } else { 0 })).reinterpret_as_uint(),
                rn,
              )
              let error = p.reduce(sign * (sample - predicted))
              let neg_odd = k != 0 || (run_neg[kind] << 1) >= rn
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
            let invert = if near == 0 && k == 0 && (cb << 1) <= -cn {
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
