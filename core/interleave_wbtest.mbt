///|
fn make_pattern_planes(
  frame : FrameInfo,
  maxvals : Array[Int32],
) -> Array[FixedArray[Int32]] {
  let out : Array[FixedArray[Int32]] = []
  let mut state = 0x13572468U
  for ci in 0..<frame.components.length() {
    let w = frame.component_width(ci)
    let h = frame.component_height(ci)
    let mv = maxvals[ci]
    let plane = FixedArray::make(w * h, 0)
    for y in 0..<h {
      for x in 0..<w {
        let i = y * w + x
        state = state * 1664525U + 1013904223U
        plane[i] = match (x + y + ci) % 13 {
          0 => 0
          1 => mv
          2 | 3 | 4 => (y * 17 + ci * 29) % (mv + 1)
          _ => ((state >> 16).reinterpret_as_int() + ci * 13) % (mv + 1)
        }
      }
    }
    out.push(plane)
  }
  out
}

///|
fn pack_scan_samples(
  frame : FrameInfo,
  scans : Array[MultiScanSpec],
  planes : Array[FixedArray[Int32]],
) -> FixedArray[Int32] {
  let buf : Array[Int32] = []
  for s in scans {
    if s.interleave == 0 {
      let ci = frame.find_component(s.component_ids[0]).unwrap()
      for v in planes[ci] {
        buf.push(v)
      }
    } else if s.interleave == 1 {
      let mcu_rows = ceil_div(frame.height, frame.max_v_sampling())
      for m in 0..<mcu_rows {
        for cid in s.component_ids {
          let ci = frame.find_component(cid).unwrap()
          let cw = frame.component_width(ci)
          let ch = frame.component_height(ci)
          let vs = frame.components[ci].v_sampling
          for v in 0..<vs {
            let y = m * vs + v
            if y < ch {
              let off = y * cw
              for x in 0..<cw {
                buf.push(planes[ci][off + x])
              }
            }
          }
        }
      }
    } else {
      let slots = s.component_ids.map(cid => frame.find_component(cid).unwrap())
      for pixel in 0..<planes[slots[0]].length() {
        for slot in slots {
          buf.push(planes[slot][pixel])
        }
      }
    }
  }
  FixedArray::from_array(buf[:])
}

///|
fn encode_scans_chunks(
  frame : FrameInfo,
  scans : Array[MultiScanSpec],
  samples : FixedArray[Int32],
  span : Int32,
  capacity : Int32,
) -> Bytes raise {
  let enc = Encoder::new_scans(frame, scans, Limits::default())
  let out = FixedArray::make(capacity, b'\x00')
  let result : Array[Byte] = []
  let mut at = 0
  while true {
    let size = min(span, samples.length() - at)
    let step = enc.step(samples, at, size, out, at + size == samples.length())
    at += step.consumed
    for i in 0..<step.produced {
      result.push(out[i])
    }
    match step.status {
      RowReady | NeedInput | NeedOutput => ()
      Failed(err) => raise err
      Done => {
        assert_eq(at, samples.length())
        return Bytes::from_array(result[:])
      }
    }
  }
  fail("encoder did not finish")
}

///|
fn decode_chunked(
  coded : Bytes,
  chunk_size : Int32,
) -> (FrameInfo, Array[ScanInfo], FixedArray[Int32], Array[(Int32, Int32)]) raise {
  let dec = Decoder::new(Limits::default())
  let mut at = 0
  let delivery : Array[(Int32, Int32)] = []
  let comp_offsets : Array[Int32] = []
  let comp_widths : Array[Int32] = []
  let mut pixels : FixedArray[Int32] = []
  while true {
    let take = min(chunk_size, coded.length() - at)
    let eof = at + take == coded.length()
    let step = dec.step(coded, at, take, eof)
    at += step.consumed
    match step.status {
      RowReady => {
        let info = dec.frame_info().unwrap()
        if pixels.length() == 0 {
          let mut off = 0
          for ci in 0..<info.components.length() {
            let cw = info.component_width(ci)
            let ch = info.component_height(ci)
            comp_offsets.push(off)
            comp_widths.push(cw)
            off += cw * ch
          }
          pixels = FixedArray::make(off, 0)
        }
        let ci = dec.current_component_index()
        let ri = dec.current_row()
        delivery.push((ci, ri))
        let row = dec.row()
        let cw = comp_widths[ci]
        let base = comp_offsets[ci] + ri * cw
        for x in 0..<cw {
          pixels[base + x] = row[x]
        }
      }
      Done => {
        assert_eq(at, coded.length())
        return (dec.frame_info().unwrap(), dec.scans(), pixels, delivery)
      }
      NeedInput => {
        assert_eq(step.consumed, take)
        for _ in 0..<2 {
          let paused = dec.step(coded, at, 0, false)
          assert_eq(paused.status, NeedInput)
          assert_eq(paused.consumed, 0)
        }
      }
      NeedOutput => fail("unexpected NeedOutput in decoder")
      Failed(err) => raise err
    }
  }
  fail("decoder did not finish")
}

///|
test "ILV=1 line-interleaved 2/3/4 components, custom LSE1, mixed scans and negative checks" {
  // 1) Pure ILV=1 across 2, 3, and 4 components, 8/12/16-bit, lossless + NEAR>0, custom LSE1
  let configs : Array[(Int32, Int32, Int32, Array[Int32], Array[Int32], Preset)] = [
    (13, 5, 8, [1, 2], [2, 1], { maxval: 255, t1: 4, t2: 9, t3: 22, reset: 31 }),
    (17, 6, 8, [10, 42, 7], [42, 7, 10], Preset::defaults()),
    (11, 4, 12, [1, 2, 3, 4], [4, 2, 1, 3], { ..Preset::defaults(), maxval: 1000 }),
    (9, 5, 16, [5, 19, 88], [5, 19, 88], Preset::defaults()),
  ]
  for idx in 0..<configs.length() {
    let (width, height, bits, ids, scan_ids, preset) = configs[idx]
    let near = if idx % 2 == 0 { 0 } else { 3 }
    let components : Array[ComponentSpec] = []
    let maxvals : Array[Int32] = []
    let mv = if preset.maxval > 0 { preset.maxval } else { (1 << bits) - 1 }
    for id in ids {
      components.push({ id, h_sampling: 1, v_sampling: 1 })
      maxvals.push(mv)
    }
    let frame : FrameInfo = { width, height, bits, components }
    let scans : Array[MultiScanSpec] = [
      { component_ids: scan_ids, interleave: 1, near, point_transform: 0, preset },
    ]
    let planes = make_pattern_planes(frame, maxvals)
    let samples = pack_scan_samples(frame, scans, planes)
    let coded = encode_scans(frame, scans, samples)
    assert_eq(coded, encode_scans_chunks(frame, scans, samples, 1, 16))
    assert_eq(coded, encode_scans_chunks(frame, scans, samples, 7, 1))

    let (dec_info, dec_scans, dec_buf, delivery) = decode_chunked(coded, 1)
    assert_eq(dec_info, frame)
    assert_eq(dec_scans.length(), 1)
    assert_eq(dec_scans[0].interleave, 1)
    assert_eq(dec_scans[0].component_ids, scan_ids)
    assert_eq(dec_scans[0].rows_decoded, height * scan_ids.length())
    assert_true(dec_scans[0].completed)
    // Verify exact line-interleaved delivery order (row 0 across all scan components before row 1)
    assert_eq(delivery.length(), height * scan_ids.length())
    for y in 0..<height {
      for s in 0..<scan_ids.length() {
        let expected_ci = frame.find_component(scan_ids[s]).unwrap()
        assert_eq(delivery[y * scan_ids.length() + s], (expected_ci, y))
      }
    }
    let plane_size = width * height
    for ci in 0..<ids.length() {
      let base = ci * plane_size
      for p in 0..<plane_size {
        assert_true((planes[ci][p] - dec_buf[base + p]).abs() <= near)
      }
    }
  }

  // 2) Mixed multi-scan frame: Scan 0 is ILV=1 [10, 30] NEAR=0 w/ custom LSE1;
  //    Scan 1 is ILV=0 [20] NEAR=2 w/ defaults (LSE1 reset); Scan 2 is ILV=0 [40] NEAR=0.
  let mixed_frame : FrameInfo = {
    width: 12,
    height: 4,
    bits: 8,
    components: [
      { id: 10, h_sampling: 1, v_sampling: 1 },
      { id: 20, h_sampling: 1, v_sampling: 1 },
      { id: 30, h_sampling: 1, v_sampling: 1 },
      { id: 40, h_sampling: 1, v_sampling: 1 },
    ],
  }
  let mixed_scans : Array[MultiScanSpec] = [
    {
      component_ids: [10, 30],
      interleave: 1,
      near: 0,
      point_transform: 0,
      preset: { maxval: 255, t1: 5, t2: 11, t3: 25, reset: 17 },
    },
    {
      component_ids: [20],
      interleave: 0,
      near: 2,
      point_transform: 0,
      preset: Preset::defaults(),
    },
    {
      component_ids: [40],
      interleave: 0,
      near: 0,
      point_transform: 0,
      preset: Preset::defaults(),
    },
  ]
  let mixed_planes = make_pattern_planes(mixed_frame, [255, 255, 255, 255])
  let mixed_samples = pack_scan_samples(mixed_frame, mixed_scans, mixed_planes)
  let mixed_coded = encode_scans(mixed_frame, mixed_scans, mixed_samples)
  let (_, m_scans, m_pixels) = decode_multicomponent(mixed_coded)
  assert_eq(m_scans.length(), 3)
  assert_eq(m_scans[0].component_ids, [10, 30])
  assert_eq(m_scans[0].interleave, 1)
  assert_eq(m_scans[1].component_ids, [20])
  assert_eq(m_scans[1].interleave, 0)
  assert_eq(m_scans[1].preset, default_preset(255, 2))
  assert_eq(m_scans[2].component_ids, [40])
  assert_eq(m_scans[2].preset, default_preset(255, 0))
  let plane_sz = 12 * 4
  for ci in 0..<4 {
    let tol = if ci == 1 { 2 } else { 0 }
    for p in 0..<plane_sz {
      assert_true((mixed_planes[ci][p] - m_pixels[ci * plane_sz + p]).abs() <= tol)
    }
  }

  // 3) Negative streams: truncation at every byte, trailing byte, illegal Ns/ILV combinations
  for cut in 0..<mixed_coded.length() {
    assert_true(
      (Ok(decode_multicomponent(mixed_coded[:cut].to_owned())) catch { e => Err(e) })
      is Err(Truncated),
    )
  }
  assert_true(
    (Ok(decode_multicomponent(mixed_coded + b"\x00")) catch { e => Err(e) })
    is Err(InvalidData(_)),
  )
  // Duplicate component ID across scan 0 (ILV=1) and scan 1 (ILV=0)
  let st = inspect(mixed_coded)
  let s1_id_off = st.scans[1].header_offset.to_int() + 5
  let dup_across = Bytes::makei(
    mixed_coded.length(),
    i => if i == s1_id_off { b'\x0A' } else { mixed_coded[i] },
  )
  assert_true(
    (Ok(decode_multicomponent(dup_across)) catch { e => Err(e) })
    is Err(InvalidData(_)),
  )
  // Force Ns=1 scan with ILV=1 in SOS header -> InvalidData
  let s1_ilv_off = st.scans[1].header_offset.to_int() + 8
  let bad_ns1_ilv1 = Bytes::makei(
    mixed_coded.length(),
    i => if i == s1_ilv_off { b'\x01' } else { mixed_coded[i] },
  )
  assert_true(
    (Ok(decode_multicomponent(bad_ns1_ilv1)) catch { e => Err(e) })
    is Err(InvalidData(_)),
  )
  // Force Ns=2 scan with ILV=0 in SOS header -> InvalidData
  let s0_ilv_off = st.scans[0].header_offset.to_int() + 10
  let bad_ns2_ilv0 = Bytes::makei(
    mixed_coded.length(),
    i => if i == s0_ilv_off { b'\x00' } else { mixed_coded[i] },
  )
  assert_true(
    (Ok(decode_multicomponent(bad_ns2_ilv0)) catch { e => Err(e) })
    is Err(InvalidData(_)),
  )
}
///|
test "ILV=2 run interruption and zero-gradient regular context match independent literals" {
  let cases : Array[(Array[Int32], Int32, Int32, Int32, Bool, Bytes)] = [
    ([201, 9], 2, 0, 1, false, b"\x69\x20"),
    ([200, 7, 55], 2, 0, 1, false, b"\x69\x49\x00"),
    ([200, 7, 55], 2, 1, 1, false, b"\x45\x49\x00"),
    ([200, 7, 55], 2, 2, 1, false, b"\x49\x4a\x00"),
    ([201, 9, 58, 4], 2, 0, 1, false, b"\x69\x52\x50"),
    // Four zero vectors grow RUNindex to 4. The middle residual uses its glimit.
    ([200, 7, 55], 5, 1, 127, true, b"\xf2\x00\x00\x03\xfb\x00"),
  ]
  // T.87 B.3 and A.7.2, independently decoded with CharLS Wasm 0.10.0.
  for entry in cases {
    let (ids, width, breaker, value, end_only, entropy) = entry
    let count = ids.length()
    let frame : FrameInfo = {
      width,
      height: 1,
      bits: 8,
      components: ids.map(id => { id, h_sampling: 1, v_sampling: 1, }),
    }
    let spec : MultiScanSpec = {
      component_ids: ids,
      interleave: 2,
      near: 0,
      point_transform: 0,
      preset: Preset::defaults(),
    }
    let header = BitWriter::with_capacity(64)
    header.frame_header(frame)
    header.scan_header(ids, 0, 2, 0)
    let expected = Bytes::makei(header.end, i => header.pending[i]) +
      entropy +
      b"\xff\xd9"
    let sample = (slot, x) => {
      if slot == breaker && (!end_only || x == width - 1) {
        value
      } else {
        0
      }
    }
    let vector = FixedArray::makei(width * count, i => {
      sample(i % count, i / count)
    })
    let planar = FixedArray::makei(width * count, i => {
      sample(i / width, i % width)
    })
    for span in [1, 7, 4096] {
      let coded = encode_scans_chunks(frame, [spec], vector, span, 1)
      assert_eq(coded, expected)
      let (_, scans, pixels, rows) = decode_chunked(expected, span)
      assert_eq(pixels, planar)
      assert_eq(scans[0].component_ids, ids)
      assert_eq(rows, Array::makei(count, slot => (slot, 0)))
    }
  }
}

///|
test "ILV=2 shared contexts and row groups survive chunk boundaries and scan changes" {
  let frame : FrameInfo = {
    width: 5,
    height: 11,
    bits: 12,
    components: [201, 9, 58, 4, 166].map(id => {
      id,
      h_sampling: 1,
      v_sampling: 1,
    }),
  }
  let scans : Array[MultiScanSpec] = [
    {
      component_ids: [201, 9, 58, 4],
      interleave: 2,
      near: 3,
      point_transform: 0,
      preset: { maxval: 1000, t1: 9, t2: 23, t3: 39, reset: 17, },
    },
    {
      component_ids: [166],
      interleave: 0,
      near: 0,
      point_transform: 0,
      preset: Preset::defaults(),
    },
  ]
  let planes = make_pattern_planes(frame, [1000, 1000, 1000, 1000, 4095])
  let samples = pack_scan_samples(frame, scans, planes)
  let coded = encode_scans(frame, scans, samples)
  for span in [1, 7, 4096] {
    assert_eq(encode_scans_chunks(frame, scans, samples, span, 1), coded)
    let (info, scan_info, actual, rows) = decode_chunked(coded, span)
    assert_eq(info, frame)
    assert_eq(scan_info[0].preset, scans[0].preset)
    assert_eq(scan_info[1].preset, default_preset(4095, 0))
    assert_eq(scan_info[0].rows_decoded, 44)
    assert_eq(scan_info[1].rows_decoded, 11)
    assert_eq(rows.length(), 55)
    for y in 0..<11 {
      for slot in 0..<4 {
        assert_eq(rows[y * 4 + slot], (slot, y))
      }
      assert_eq(rows[44 + y], (4, y))
    }
    for slot in 0..<5 {
      let near = if slot == 4 { 0 } else { 3 }
      for px in 0..<55 {
        assert_true(abs_i32(actual[55 * slot + px] - planes[slot][px]) <= near)
      }
    }
  }
}

///|
test "ILV=2 long runs, narrow 16-bit rows and strict invalid streams" {
  let frame : FrameInfo = {
    width: 515,
    height: 2,
    bits: 16,
    components: [191, 13, 55, 151].map(id => {
      id,
      h_sampling: 1,
      v_sampling: 1,
    }),
  }
  let spec : MultiScanSpec = {
    component_ids: [191, 13, 55, 151],
    interleave: 2,
    near: 0,
    point_transform: 0,
    preset: Preset::defaults(),
  }
  let original = FixedArray::makei(515 * 2 * 4, i => {
    if i == 510 * 4 {
      65535
    } else if i >= 515 * 4 + 2 && i % 4 == 2 {
      32768
    } else {
      0
    }
  })
  let coded = encode_scans(frame, [spec], original)
  let (_, _, actual, _) = decode_chunked(coded, 1)
  for pixel in 0..<1030 {
    for slot in 0..<4 {
      assert_eq(actual[slot * 1030 + pixel], original[pixel * 4 + slot])
    }
  }
  assert_eq(encode_scans_chunks(frame, [spec], original, 7, 1), coded)
  let narrow = { ..frame, width: 1, height: 3, }
  let extremes : FixedArray[Int32] = [
    32768, 65535, 32767, 65535, 0, 32767, 65535, 32768, 65535, 0, 0, 65535,
  ]
  let thin = encode_scans_chunks(narrow, [spec], extremes, 1, 1)
  let (_, _, thin_pixels, _) = decode_chunked(thin, 7)
  assert_eq(
    thin_pixels,
    FixedArray::makei(12, i => extremes[i % 3 * 4 + i / 3]),
  )
  let structure = inspect(coded)
  let sos = structure.scans[0].header_offset.to_int()
  let entropy = structure.scans[0].entropy_offset.to_int()
  let unknown_id = Bytes::makei(coded.length(), i => {
    if i == sos + 7 {
      b'\x80'
    } else {
      coded[i]
    }
  })
  let duplicate_id = Bytes::makei(coded.length(), i => {
    if i == sos + 7 {
      coded[sos + 5]
    } else {
      coded[i]
    }
  })
  let out_of_order = Bytes::makei(coded.length(), i => {
    if i == sos + 5 {
      coded[sos + 7]
    } else if i == sos + 7 {
      coded[sos + 5]
    } else {
      coded[i]
    }
  })
  // Make the first plane twice as wide as the others via its H factor.
  let unequal = Bytes::makei(coded.length(), i => {
    if i == 12 {
      b'\x21'
    } else {
      coded[i]
    }
  })
  for
    malformed in [
      unknown_id,
      duplicate_id,
      out_of_order,
      unequal,
      coded[:entropy].to_owned() + b"\xff\xd9",
      coded + b"\x00",
    ] {
    assert_true(
      (Ok(decode_multicomponent(malformed)) catch { err => Err(err) })
      is Err(InvalidData(_)),
    )
  }
  for cut in 0..<coded.length() {
    assert_true(
      (Ok(decode_multicomponent(coded[:cut].to_owned())) catch {
        err => Err(err)
      })
      is Err(Truncated),
    )
  }
  let uneven_frame = {
    ..frame,
    components: [
      { id: 191, h_sampling: 2, v_sampling: 1, },
      frame.components[1],
      frame.components[2],
      frame.components[3],
    ],
  }
  assert_true(
    (Ok(Encoder::new_scans(uneven_frame, [spec], Limits::default())) catch {
      err => Err(err)
    })
    is Err(
      InvalidArgument(
        "sample-interleaved components must have identical dimensions",
      ),
    ),
  )
}

///|
test "ILV=2 initializes shared state per scan and inherits raw LSE1 defaults" {
  let frame : FrameInfo = {
    width: 7,
    height: 3,
    bits: 12,
    components: [211, 9, 58, 4].map(id => { id, h_sampling: 1, v_sampling: 1, }),
  }
  let preset = { ..Preset::defaults(), maxval: 1000, }
  let specs : Array[MultiScanSpec] = [
    {
      component_ids: [211, 9],
      interleave: 2,
      near: 3,
      point_transform: 0,
      preset,
    },
    {
      component_ids: [58, 4],
      interleave: 2,
      near: 0,
      point_transform: 0,
      preset,
    },
  ]
  let planes = make_pattern_planes(frame, [1000, 1000, 1000, 1000])
  let coded = encode_scans(
    frame,
    specs,
    pack_scan_samples(frame, specs, planes),
  )
  let structure = inspect(coded)
  let first_lse = structure.scans[0].header_offset.to_int() - 15
  let second_lse = structure.scans[1].header_offset.to_int() - 15
  // Keep MAXVAL=1000 and reset all remaining fields to their dynamic defaults.
  // Strip the second LSE so its scan inherits the first marker with a new NEAR.
  let inherited = coded[:first_lse + 7].to_owned() +
    b"\x00\x00\x00\x00\x00\x00\x00\x00" +
    coded[first_lse + 15:second_lse].to_owned() +
    coded[second_lse + 15:].to_owned()
  let (_, parsed, samples, _) = decode_chunked(inherited, 1)
  let (_, _, original, _) = decode_chunked(coded, 7)
  assert_eq(samples, original)
  assert_eq(parsed[0].preset, default_preset(1000, 3))
  assert_eq(parsed[1].preset, default_preset(1000, 0))
}
