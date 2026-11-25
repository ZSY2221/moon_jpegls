///|
test "coded precision, MAXVAL and NEAR remain separate across 2..16 bits" {
  for bits in 2..<=16 {
    let full = (1 << bits) - 1
    for maxval in [1, 2, full / 2, full - 1, full] {
      let upper = min(255, maxval / 2)
      for near in [0, upper] {
        let frame : Frame = { width: 15, height: 4, bits, near }
        let original = FixedArray::makei(60, i => if i < 15 { 0 } else { (i * 391 + i * i) % (maxval + 1) })
        let requested : Preset = { ..Preset::defaults(), maxval }
        let encoded = encode(frame, original, preset=requested)
        let (decoded, effective, reconstructed) = decode_with_preset(encoded)
        assert_eq(decoded, frame)
        assert_eq(effective, default_preset(maxval, near))
        assert_eq(reconstructed.length(), original.length())
        for i in 0..<original.length() {
          assert_true((original[i] - reconstructed[i]).abs() <= near)
          assert_true(reconstructed[i] >= 0 && reconstructed[i] <= maxval)
        }
      }
    }
  }
}

///|
test "custom LSE thresholds drive the coded scan and latest preset marker wins" {
  let frame : Frame = { width: 29, height: 13, bits: 8, near: 2 }
  let original = pattern(frame)
  let preset : Preset = { maxval: 255, t1: 3, t2: 19, t3: 65, reset: 3 }
  let encoded = encode(frame, original, preset~)
  let default_encoded = encode(frame, original)
  assert_true(encoded[40:].to_owned() != default_encoded[25:].to_owned())
  let (decoded, effective, reconstructed) = decode_with_preset(encoded)
  assert_eq(decoded, frame)
  assert_eq(effective, preset)
  let earlier = b"\xff\xf8\x00\x0d\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00"
  let stacked = encoded[:15].to_owned() + earlier + encoded[15:].to_owned()
  assert_eq(decode_with_preset(stacked), (frame, preset, reconstructed))
  let before_frame = encoded[:2].to_owned() + encoded[15:30].to_owned() +
    encoded[2:15].to_owned() + encoded[30:].to_owned()
  assert_eq(decode_with_preset(before_frame), (frame, preset, reconstructed))
  let fresh = Decoder::new(Limits::default())
  assert_eq(fresh.preset(), None)
  assert_eq(decode_with_preset(default_encoded).1, default_preset(255, 2))
}

///|
test "invalid MAXVAL, NEAR, threshold order, RESET and marker lengths are typed" {
  let frame : Frame = { width: 2, height: 1, bits: 8, near: 0 }
  let defaults = Preset::defaults()
  for preset in [
    { ..defaults, maxval: 256 },
    { ..defaults, maxval: -1 },
    { ..defaults, t1: 6, t2: 5 },
    { ..defaults, t2: 25 },
    { ..defaults, t3: 256 },
    { ..defaults, reset: 2 },
    { ..defaults, reset: 256 },
  ] {
    assert_true((Ok(Encoder::new(frame, Limits::default(), preset~)) catch { e => Err(e) }) is Err(InvalidArgument(_)))
  }
  let preset : Preset = { ..defaults, maxval: 1 }
  assert_true((Ok(encode(frame, [0, 2], preset~)) catch { e => Err(e) }) is Err(InvalidArgument(_)))
  let excess_near : Frame = { ..frame, near: 1 }
  assert_true((Ok(encode(excess_near, [0, 1], preset~)) catch { e => Err(e) }) is Err(InvalidArgument(_)))
  let coded = encode(frame, [0, 1], preset~)
  assert_true((Ok(decode(coded[:27].to_owned())) catch { e => Err(e) }) is Err(Truncated))
  let bad_length = Bytes::makei(coded.length(), i => if i == 18 { 12 } else { coded[i] })
  assert_true((Ok(decode(bad_length)) catch { e => Err(e) }) is Err(InvalidData(_)))
  let wrong_position = coded + coded[15:30].to_owned()
  assert_true((Ok(decode(wrong_position)) catch { e => Err(e) }) is Err(InvalidData(_)))
}

///|
test "Golomb order and RESET handle the unsigned accumulator range" {
  assert_eq(golomb_order(2147483648U, 65535), 16)
  let frame : Frame = { width: 1, height: 1, bits: 16, near: 0 }
  let preset : Preset = { ..Preset::defaults(), reset: 65535 }
  let effective = resolve_preset(frame, preset)
  let scan = Scan::new(1, Parameters::new(effective, 0))
  scan.ctx_a[0] = 2147450880U
  scan.ctx_n[0] = 65535
  scan.update_regular(0, -32768)
  assert_eq(scan.ctx_a[0], 1073741824U)
  assert_eq(scan.ctx_n[0], 32768)
}
