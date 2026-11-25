///|
test "workspace includes the gradient table for every supported profile" {
  for bits in [8, 12, 16] {
    for near in 0..<=3 {
      let frame : Frame = { width: 7, height: 3, bits, near, }
      // T3 is 21 + 7*NEAR for 8-bit and 276 + 7*NEAR for 12/16-bit.
      // The owned table stores 2*T3+1 signed 32-bit entries.
      let table_bytes = (if bits == 8 { 172 } else { 2212 }) + 56 * near
      let scan_bytes = 8 * frame.width + 5864 + table_bytes
      let encoder = Encoder::new(frame, Limits::default())
      assert_eq(encoder.workspace_bytes(), scan_bytes + 32)

      let decoder = Decoder::new(Limits::default())
      assert_eq(decoder.workspace_bytes(), 791)
      let coded = encode(frame, FixedArray::make(frame.width * frame.height, 0))
      let mut at = 0
      let mut rows = 0
      let mut done = false
      while !done {
        let step = decoder.step(coded, at, coded.length() - at, true)
        at += step.consumed
        // Header scratch remains owned after the scan has been initialized.
        assert_eq(decoder.workspace_bytes(), scan_bytes + 791)
        match step.status {
          RowReady => rows += 1
          Done => done = true
          Failed(error) => raise error
          _ => fail("complete stream must produce a row or finish")
        }
      }
      assert_eq(rows, frame.height)
      assert_eq(at, coded.length())
    }
  }
}

///|
test "workspace follows width and profile rather than frame height" {
  for height in [1, 4096] {
    let frame : Frame = { width: 512, height, bits: 16, near: 0, }
    let encoder = Encoder::new(frame, Limits::default())
    assert_eq(encoder.workspace_bytes(), 12204)
    encoder.cancel()
    assert_eq(encoder.workspace_bytes(), 12204)
  }
  let wider : Frame = { width: 513, height: 1, bits: 16, near: 0, }
  assert_eq(Encoder::new(wider, Limits::default()).workspace_bytes(), 12212)
}

///|
test "high NEAR thresholds fall back and workspace counts the resulting table" {
  let thresholds = [
    (33, 102, 172, 252),
    (34, 105, 177, 177),
    (49, 150, 252, 252),
    (50, 153, 153, 153),
    (84, 255, 255, 255),
    (85, 86, 86, 86),
    (127, 128, 128, 128),
  ]
  for (near, t1, t2, t3) in thresholds {
    let params = Parameters::new(default_preset(255, near), near)
    assert_eq((params.t1, params.t2, params.t3), (t1, t2, t3))
    assert_eq(params.q_lut.length(), 2 * t3 + 1)
  }
  let frame : Frame = { width: 512, height: 1, bits: 16, near: 255, }
  let encoder = Encoder::new(frame, Limits::default())
  assert_eq(encoder.workspace_bytes(), 26484)
  let coded = encode(frame, FixedArray::make(frame.width, 0))
  let decoder = Decoder::new(Limits::default())
  assert_eq(decoder.step(coded, 0, coded.length(), true).status, RowReady)
  assert_eq(decoder.workspace_bytes(), 27243)
  assert_eq(Parameters::new(default_preset(65535, 244), 244).wrap, 66504)
}
