///|
fn make_lse1(preset : Preset) -> Bytes {
  Bytes::from_array([
    b'\xFF',
    b'\xF8',
    b'\x00',
    b'\x0D',
    b'\x01',
    (preset.maxval >> 8).to_byte(),
    (preset.maxval & 255).to_byte(),
    (preset.t1 >> 8).to_byte(),
    (preset.t1 & 255).to_byte(),
    (preset.t2 >> 8).to_byte(),
    (preset.t2 & 255).to_byte(),
    (preset.t3 >> 8).to_byte(),
    (preset.t3 & 255).to_byte(),
    (preset.reset >> 8).to_byte(),
    (preset.reset & 255).to_byte(),
  ])
}

///|
fn multi_pattern(
  frame : FrameInfo,
  scans : Array[ScanSpec],
  maxvals : Array[Int32],
) -> FixedArray[Int32] {
  let plane = frame.width * frame.height
  let total = plane * frame.components.length()
  let out = FixedArray::make(total, 0)
  let mut state = 0x51a7beefU
  for s in 0..<scans.length() {
    let comp_idx = frame.find_component(scans[s].component_id).unwrap()
    let maxval = maxvals[s]
    let base = s * plane
    for y in 0..<frame.height {
      for x in 0..<frame.width {
        let i = y * frame.width + x
        state = state * 1664525U + 1013904223U
        out[base + i] = match (i + comp_idx) % 11 {
          0 => maxval
          1 | 2 | 3 => 0
          _ =>
            ((state >> 16).reinterpret_as_int() + comp_idx * 17) %
            (maxval + 1)
        }
      }
    }
  }
  out
}

///|
fn encode_multi_chunks(
  frame : FrameInfo,
  scans : Array[ScanSpec],
  samples : FixedArray[Int32],
  span : Int32,
  capacity : Int32,
) -> Bytes raise {
  let enc = Encoder::new_multicomponent(frame, scans, Limits::default())
  let out = FixedArray::make(capacity, b'\x00')
  let result : Array[Byte] = []
  let mut at = 0
  let mut rows = 0
  while true {
    let size = min(span, samples.length() - at)
    let step = enc.step(samples, at, size, out, at + size == samples.length())
    at += step.consumed
    for i in 0..<step.produced {
      result.push(out[i])
    }
    match step.status {
      RowReady => rows += 1
      NeedInput => assert_eq(step.consumed, size)
      NeedOutput => assert_eq(step.produced, capacity)
      Failed(err) => raise err
      Done => {
        assert_eq(rows, frame.height * scans.length())
        assert_eq(at, samples.length())
        return Bytes::from_array(result[:])
      }
    }
  }
  fail("encoder did not finish")
}

///|
test "multi-component 2/3/4 planes, precisions, non-contiguous IDs and reordered scans" {
  let configs : Array[(Int32, Int32, Array[Int32], Array[Int32], Int32, Int32)] = [
    (2, 8, [0, 255], [255, 0], 13, 5),
    (3, 8, [10, 200, 5], [200, 5, 10], 17, 6),
    (4, 16, [1, 2, 3, 4], [4, 2, 1, 3], 11, 4),
    (3, 12, [7, 19, 42], [19, 42, 7], 9, 5),
    (2, 2, [3, 9], [9, 3], 5, 3),
  ]
  for cfg in configs {
    let (comp_count, bits, ids, order, width, height) = cfg
    let components : Array[ComponentSpec] = []
    for id in ids {
      components.push({ id, h_sampling: 1, v_sampling: 1 })
    }
    let frame : FrameInfo = { width, height, bits, components }
    let full = frame.maxval()
    let scans : Array[ScanSpec] = []
    let maxvals : Array[Int32] = []
    for i in 0..<comp_count {
      let id = order[i]
      let near = min(i, full / 2)
      let maxval = if bits == 12 && i == 1 { 1000 } else { full }
      let preset : Preset = if i == 1 && maxval >= 20 && near < 4 {
        { maxval, t1: near + 2, t2: near + 5, t3: min(maxval, near + 12), reset: 31 }
      } else {
        { ..Preset::defaults(), maxval: if maxval == full { 0 } else { maxval } }
      }
      scans.push({ component_id: id, near, preset })
      maxvals.push(maxval)
    }
    let samples = multi_pattern(frame, scans, maxvals)
    let coded = encode_multicomponent(frame, scans, samples)
    assert_eq(coded, encode_multi_chunks(frame, scans, samples, 1, 1))
    assert_eq(coded, encode_multi_chunks(frame, scans, samples, 19, 7))
    assert_true((Ok(decode(coded)) catch { e => Err(e) }) is Err(UnsupportedFeature(_)))

    let (dec_info, dec_scans, planar) = decode_multicomponent(coded)
    assert_eq(dec_info, frame)
    assert_eq(dec_scans.length(), comp_count)
    let plane_size = width * height
    for s in 0..<comp_count {
      let si = dec_scans[s]
      assert_eq(si.scan_index, s)
      assert_eq(si.component_id, order[s])
      assert_true(si.completed)
      assert_eq(si.rows_decoded, height)
      assert_eq(si.near, scans[s].near)
      assert_true(coded[si.header_offset.to_int()] == b'\xFF')
      assert_true(coded[si.header_offset.to_int() + 1] == b'\xDA')
      let ci = si.component_index
      assert_eq(ci, frame.find_component(order[s]).unwrap())
      for p in 0..<plane_size {
        let orig = samples[s * plane_size + p]
        let rec = planar[ci * plane_size + p]
        assert_true((orig - rec).abs() <= scans[s].near)
        assert_true(rec >= 0 && rec <= maxvals[s])
      }
    }
    let st = inspect(coded)
    assert_eq(st.soi_offset, 0L)
    assert_eq(st.eoi_offset, (coded.length() - 2).to_int64())
    assert_eq(coded[st.eoi_offset.to_int()], b'\xFF')
    assert_eq(coded[st.eoi_offset.to_int() + 1], b'\xD9')
  }
}

///|
test "LSE1 cross-scan inheritance, zero-default re-resolution, reset and invalid NEAR" {
  let frame : FrameInfo = {
    width: 11,
    height: 4,
    bits: 8,
    components: [
      { id: 1, h_sampling: 1, v_sampling: 1 },
      { id: 2, h_sampling: 1, v_sampling: 1 },
    ],
  }
  let s0 : ScanSpec = {
    component_id: 1,
    near: 0,
    preset: { maxval: 255, t1: 5, t2: 11, t3: 25, reset: 17 },
  }
  let s1 : ScanSpec = { component_id: 2, near: 3, preset: Preset::defaults() }
  let scans = [s0, s1]
  let samples = multi_pattern(frame, scans, [255, 255])

  // Baseline: scan 0 NEAR=0 default, scan 1 NEAR=3 default (no LSE1 at all).
  let default_coded = encode_multicomponent(
    frame,
    [{ ..s0, preset: Preset::defaults() }, s1],
    samples,
  )
  let (_, def_scans, _) = decode_multicomponent(default_coded)
  assert_eq(def_scans[0].preset, default_preset(255, 0))
  assert_eq(def_scans[1].preset, default_preset(255, 3))

  // Redefined default via explicit zero LSE1 before scan 1 (resets prior custom LSE1).
  let custom_coded = encode_multicomponent(frame, [s0, { ..s1, near: 0, preset: s0.preset }], samples)
  let st = inspect(custom_coded)
  assert_eq(st.scans.length(), 2)
  assert_eq(st.scans[0].preset, s0.preset)
  assert_eq(st.scans[1].preset, s0.preset)
  // Custom LSE1 before scan 0 inherited into scan 1 without a second LSE1!
  let mut lse_count = 0
  for m in st.markers {
    if m.code == 0xF8 {
      lse_count += 1
    }
  }
  assert_eq(lse_count, 1)

  // Now inject an all-zero LSE1 before scan 1 AND set scan 1 NEAR=3: zero fields must re-resolve
  // to default_preset(255, 3), NOT stay at scan 0's (5, 11, 25, 17).
  let s1_off = st.scans[1].header_offset.to_int()
  let mut modified = custom_coded[:s1_off].to_owned() +
    make_lse1(Preset::defaults()) +
    custom_coded[s1_off:].to_owned()
  // Set scan 1 NEAR byte in SOS payload: FF DA 00 08 01 <Cs> <Tm> <NEAR>
  let sos2_near = s1_off + 15 + 7
  modified = Bytes::makei(modified.length(), i => {
    if i == sos2_near {
      b'\x03'
    } else {
      modified[i]
    }
  })
  // Even though scan 1 entropy came from near=0, effective preset at scan 1 must be default_preset(255, 3)!
  // Let's also verify valid inter-scan COM + DRI=0 + valid LSE1 with exact re-encoded scan 1 near=3.
  let near3_full = encode_multicomponent(
    frame,
    [s0, { component_id: 2, near: 3, preset: { maxval: 255, t1: 12, t2: 22, t3: 42, reset: 64 } }],
    samples,
  )
  let st3 = inspect(near3_full)
  let scan2_hdr = st3.scans[1].header_offset.to_int()
  let with_zero_reset = near3_full[:scan2_hdr - 15].to_owned() +
    b"\xff\xfe\x00\x05abc" +
    b"\xff\xdd\x00\x04\x00\x00" +
    make_lse1(Preset::defaults()) +
    near3_full[scan2_hdr:].to_owned()
  let (_, zero_scans, zero_pixels) = decode_multicomponent(with_zero_reset)
  assert_eq(zero_scans[0].preset, s0.preset)
  assert_eq(zero_scans[1].preset, default_preset(255, 3))
  assert_eq(zero_pixels, decode_multicomponent(near3_full).2)
  ignore(modified)

  // Invalid inherited T1 <= NEAR_2: Scan 0 uses explicit T1=2 (valid for NEAR=0),
  // Scan 1 uses NEAR=2 with no intervening LSE1 -> MUST raise InvalidData!
  let s0_small_t1 : Preset = { maxval: 255, t1: 2, t2: 7, t3: 21, reset: 64 }
  let bad_inherit_base = encode_multicomponent(
    frame,
    [
      { component_id: 1, near: 0, preset: s0_small_t1 },
      { component_id: 2, near: 0, preset: s0_small_t1 },
    ],
    samples,
  )
  let bad_st = inspect(bad_inherit_base)
  let bad_near_off = bad_st.scans[1].header_offset.to_int() + 7
  let bad_inherit = Bytes::makei(bad_inherit_base.length(), i => {
    if i == bad_near_off {
      b'\x02'
    } else {
      bad_inherit_base[i]
    }
  })
  assert_true(
    (Ok(decode_multicomponent(bad_inherit)) catch { e => Err(e) })
    is Err(InvalidData(_)),
  )
}

///|
test "early row delivery before scan 2, scan-boundary stuffing, cuts and negative structures" {
  // Narrow 1x4 3-component image with long runs + 0xFF boundary check
  let frame : FrameInfo = {
    width: 1,
    height: 4,
    bits: 8,
    components: [
      { id: 1, h_sampling: 1, v_sampling: 1 },
      { id: 2, h_sampling: 1, v_sampling: 1 },
      { id: 3, h_sampling: 1, v_sampling: 1 },
    ],
  }
  let scans : Array[ScanSpec] = [
    { component_id: 1, near: 0, preset: Preset::defaults() },
    { component_id: 2, near: 0, preset: Preset::defaults() },
    { component_id: 3, near: 0, preset: Preset::defaults() },
  ]
  let samples : FixedArray[Int32] = [0, 0, 0, 0, 255, 255, 255, 255, 128, 128, 128, 128]
  let coded = encode_multicomponent(frame, scans, samples)
  let st = inspect(coded)
  assert_eq(st.scans.length(), 3)

  // Early delivery: send ONLY up to end of scan 0 (withholding scan 1 SOS and EOI)
  let dec = Decoder::new(Limits::default())
  let cut0 = st.scans[0].end_offset.to_int()
  let mut at = 0
  let mut delivered_c0 = 0
  while true {
    let step = dec.step(coded, at, cut0 - at, false)
    at += step.consumed
    match step.status {
      RowReady => {
        assert_eq(dec.current_component_id(), 1)
        assert_eq(dec.row()[0], 0)
        delivered_c0 += 1
      }
      NeedInput => break
      _ => fail("unexpected status before scan 2")
    }
  }
  assert_eq(delivered_c0, 4)

  // Feed remaining bytes and verify completion
  let mut total_rows = delivered_c0
  let mut done = false
  while !done {
    let step = dec.step(coded, at, coded.length() - at, true)
    at += step.consumed
    match step.status {
      RowReady => total_rows += 1
      Done => done = true
      _ => fail("unexpected status completing multi-scan")
    }
  }
  assert_eq(total_rows, 12)
  assert_eq(at, coded.length())

  // Truncation at every single byte cut
  for cut in 0..<coded.length() {
    assert_true(
      (Ok(decode_multicomponent(coded[:cut].to_owned())) catch { e => Err(e) })
      is Err(Truncated),
    )
  }

  // Premature EOI right after scan 1 of 3
  let premature = coded[:st.scans[0].end_offset.to_int()].to_owned() + b"\xff\xd9"
  assert_true(
    (Ok(decode_multicomponent(premature)) catch { e => Err(e) })
    is Err(InvalidData(_)),
  )

  // Duplicate component ID in scan 1
  let dup_id_off = st.scans[1].header_offset.to_int() + 5
  let dup_scan = Bytes::makei(coded.length(), i => if i == dup_id_off { b'\x01' } else { coded[i] })
  let bad_dec = Decoder::new(Limits::default())
  let mut dup_at = 0
  let mut dup_status : Status = NeedInput
  while true {
    let s = bad_dec.step(dup_scan, dup_at, dup_scan.length() - dup_at, true)
    dup_at += s.consumed
    match s.status {
      RowReady => ()
      Failed(_) => {
        dup_status = s.status
        break
      }
      _ => fail("expected duplicate component failure")
    }
  }
  assert_true(dup_status is Failed(InvalidData(_)))
  match bad_dec.error_location() {
    Some(loc) => {
      assert_eq(loc.component_id, 1)
      assert_eq(loc.marker, 0xDA)
      assert_eq(loc.offset, st.scans[1].header_offset)
    }
    None => fail("expected error location on duplicate scan")
  }

  // Scan-boundary 0xFF -> stuffed 0x00 immediately before next SOS (12x1 all zeros produces 8 one bits = 0xFF, padded with 7 zeros = 0x00)
  let wide_frame : FrameInfo = {
    width: 12,
    height: 1,
    bits: 8,
    components: [
      { id: 1, h_sampling: 1, v_sampling: 1 },
      { id: 2, h_sampling: 1, v_sampling: 1 },
      { id: 3, h_sampling: 1, v_sampling: 1 },
    ],
  }
  let all_zero = FixedArray::make(36, 0)
  let ff_coded = encode_multicomponent(wide_frame, scans, all_zero)
  let ff_st = inspect(ff_coded)
  let s0_end = ff_st.scans[0].end_offset.to_int()
  assert_eq(ff_coded[s0_end - 2], b'\xFF')
  assert_eq(ff_coded[s0_end - 1], b'\x00')
  assert_eq(ff_coded[s0_end], b'\xFF')
  assert_eq(ff_coded[s0_end + 1], b'\xDA')
  // Decode at every single-byte cut through the stuffed FF 00 boundary
  for cut in 1..<=ff_coded.length() {
    let split_dec = Decoder::new(Limits::default())
    let r1 = split_dec.step(ff_coded, 0, cut, false)
    let mut at2 = r1.consumed
    let mut rows2 = if r1.status is RowReady { 1 } else { 0 }
    if cut < ff_coded.length() && r1.status is RowReady {
      // finish first half
      while true {
        let s = split_dec.step(ff_coded, at2, cut - at2, false)
        at2 += s.consumed
        match s.status {
          RowReady => rows2 += 1
          NeedInput => break
          _ => fail("unexpected mid-stream status")
        }
      }
    }
    let mut done2 = r1.status is Done
    while !done2 {
      let s = split_dec.step(ff_coded, at2, ff_coded.length() - at2, true)
      at2 += s.consumed
      match s.status {
        RowReady => rows2 += 1
        Done => done2 = true
        Failed(err) => raise err
        _ => fail("unexpected end status")
      }
    }
    assert_eq(rows2, 3)
  }

  // Unknown component selector in scan 1
  let unknown_scan = Bytes::makei(coded.length(), i => if i == dup_id_off { b'\x09' } else { coded[i] })
  assert_true(
    (Ok(decode_multicomponent(unknown_scan)) catch { e => Err(e) })
    is Err(InvalidData(_)),
  )

  // Trailing byte rejected in whole-image decode
  assert_true(
    (Ok(decode_multicomponent(coded + b"\x00")) catch { e => Err(e) })
    is Err(InvalidData(_)),
  )

  // Checked width * height * components resource limit
  let budget : Limits = { ..Limits::default(), max_pixels: 100 }
  let ok_1c = FrameInfo::{ width: 10, height: 10, bits: 8, components: [{ id: 1, h_sampling: 1, v_sampling: 1 }] }
  ignore(Encoder::new_multicomponent(ok_1c, [{ component_id: 1, near: 0, preset: Preset::defaults() }], budget))
  let too_big_2c = FrameInfo::{
    width: 10,
    height: 10,
    bits: 8,
    components: [{ id: 1, h_sampling: 1, v_sampling: 1 }, { id: 2, h_sampling: 1, v_sampling: 1 }],
  }
  assert_true(
    (Ok(
      Encoder::new_multicomponent(
        too_big_2c,
        [
          { component_id: 1, near: 0, preset: Preset::defaults() },
          { component_id: 2, near: 0, preset: Preset::defaults() },
        ],
        budget,
      ),
    ) catch {
      e => Err(e)
    })
    is Err(ResourceLimit(_)),
  )
  let small_coded = encode_multicomponent(frame, scans, samples)
  let dec_limit : Limits = { ..Limits::default(), max_pixels: 11 }
  assert_true(
    (Ok(decode_multicomponent(small_coded, limits=dec_limit)) catch { e => Err(e) })
    is Err(ResourceLimit(_)),
  )
}
