///|
fn pattern(frame : Frame) -> FixedArray[Int32] {
  let mut state = 0x1234abcdU
  FixedArray::makei(frame.width * frame.height, i => {
    state = state * 1664525U + 1013904223U
    match i % 13 {
      0 => frame.maxval()
      1 | 2 | 3 | 4 | 5 => 0
      _ => (state >> 16).reinterpret_as_int() & frame.maxval()
    }
  })
}

///|
fn encode_chunks(
  frame : Frame,
  samples : FixedArray[Int32],
  span : Int32,
  capacity : Int32,
) -> Bytes raise {
  let stream = Encoder::new(frame, Limits::default())
  let out = FixedArray::make(capacity, b'\x00')
  let result : Array[Byte] = []
  let mut rows = 0
  let mut at = 0
  while true {
    let size = min(span, samples.length() - at)
    let step = stream.step(
      samples,
      at,
      size,
      out,
      at + size == samples.length(),
    )
    assert_true(step.consumed >= 0 && step.consumed <= size)
    assert_true(step.produced >= 0 && step.produced <= capacity)
    at += step.consumed
    for i in 0..<step.produced {
      result.push(out[i])
    }
    match step.status {
      RowReady => rows += 1
      NeedInput => assert_eq(step.consumed, size)
      NeedOutput => assert_eq(step.produced, capacity)
      Failed(error) => raise error
      Done => {
        assert_eq(rows, frame.height)
        assert_eq(at, samples.length())
        return Bytes::from_array(result[:])
      }
    }
  }
  fail("encoder did not finish")
}

///|
fn decode_chunks(
  input : Bytes,
  boundaries : Array[Int32],
  frame : Frame,
  expected : FixedArray[Int32],
) -> Unit raise {
  let stream = Decoder::new(Limits::default())
  let mut at = 0
  let mut row_number = 0
  let mut done = false
  for end in boundaries {
    while !done {
      let step = stream.step(input, at, end - at, end == input.length())
      assert_true(step.consumed >= 0 && step.consumed <= end - at)
      at += step.consumed
      match step.status {
        RowReady => {
          assert_eq(stream.frame(), Some(frame))
          assert_true(row_number < frame.height)
          let row = stream.row()
          for x in 0..<frame.width {
            assert_eq(row[x], expected[row_number * frame.width + x])
          }
          row_number += 1
        }
        NeedInput => {
          assert_eq(at, end)
          break
        }
        Done => done = true
        Failed(error) => raise error
        NeedOutput => fail("decoder cannot request an output array")
      }
    }
  }
  assert_true(done)
  assert_eq(row_number, frame.height)
  assert_eq(at, input.length())
}

///|
test "all supported precisions and NEAR across dissimilar input and output boundaries" {
  for bits in [8, 12, 16] {
    for near in 0..<=3 {
      let frame : Frame = { width: 29, height: 7, bits, near, }
      let original = pattern(frame)
      let coded = encode(frame, original)
      assert_eq(coded, encode_chunks(frame, original, 1, 1))
      assert_eq(coded, encode_chunks(frame, original, 11, 5))
      let (info, reconstructed) = decode(coded)
      assert_eq(info, frame)
      for i in 0..<original.length() {
        assert_true((original[i] - reconstructed[i]).abs() <= near)
      }
      let single_bytes = Array::makei(coded.length(), i => i + 1)
      decode_chunks(coded, single_bytes, frame, reconstructed)
    }
  }
}

///|
test "enumerate every cut including marker, Golomb escape and stuffing" {
  let frame : Frame = { width: 17, height: 4, bits: 16, near: 0, }
  let original = pattern(frame)
  let coded = encode(frame, original)
  for i in 0..<=coded.length() {
    decode_chunks(coded, [i, coded.length()], frame, original)
  }
}

///|
test "long runs pause at rows, reuse predictions, and retain exact EOI position" {
  let frame : Frame = { width: 32769, height: 4, bits: 8, near: 0, }
  let original = FixedArray::makei(frame.width * frame.height, i => {
    if i == frame.width * 2 - 1 {
      240
    } else {
      0
    }
  })
  let coded = encode_chunks(frame, original, 71, 1)
  let input = coded + b"tail"
  let stream = Decoder::new(Limits::default())
  let mut at = 0
  for y in 0..<frame.height {
    let step = stream.step(input, at, input.length() - at, false)
    assert_eq(step.status, RowReady)
    at += step.consumed
    let row = stream.row()
    for x in 0..<frame.width {
      assert_eq(row[x], original[y * frame.width + x])
    }
  }
  let finish = stream.step(input, at, input.length() - at, false)
  assert_eq(finish.status, Done)
  assert_eq(at + finish.consumed, coded.length())
  let repeated = stream.step(input, at, 0, true)
  assert_eq(repeated.status, Done)
  assert_eq(repeated.consumed, 0)
  assert_true((Ok(decode(input)) catch { e => Err(e) }) is Err(InvalidData(_)))
}

///|
test "explicit EOF, truncation, zero output capacity and cancellation are distinct" {
  let frame : Frame = { width: 1, height: 2, bits: 8, near: 0, }
  let coded = encode(frame, [0, 0])
  for i in 0..<coded.length() {
    let stream = Decoder::new(Limits::default())
    let mut at = 0
    assert_eq(stream.step(b"", 0, 0, false).status, NeedInput)
    while true {
      let report = stream.step(coded, at, i - at, true)
      at += report.consumed
      if report.status != RowReady {
        assert_eq(report.status, Failed(Truncated))
        assert_eq(at, i)
        break
      }
    }
  }
  let encoder = Encoder::new(frame, Limits::default())
  let initial = encoder.step([0, 0], 0, 2, [], false)
  assert_eq(initial.status, NeedOutput)
  assert_eq(initial.consumed, 0)
  assert_true(encoder.pending_bytes() <= 32)
  encoder.cancel()
  let later = encoder.step([0], 0, 1, [0], true)
  assert_eq(later.status, Failed(Cancelled))
  assert_eq(later.produced, 0)
  let decoder = Decoder::new(Limits::default())
  assert_eq(decoder.step(coded, 0, coded.length(), false).status, RowReady)
  decoder.cancel()
  assert_eq(decoder.step(b"", 0, 0, true).status, Failed(Cancelled))
}

///|
test "default LSE forms and invalid RESET" {
  let frame : Frame = { width: 3, height: 1, bits: 16, near: 3, }
  let coded = encode(frame, [32767, 32768, 65535])
  let (_, expected) = decode(coded)
  let omitted = coded[:15].to_owned() + coded[30:].to_owned()
  assert_eq(decode(omitted).1, expected)
  let zero = Bytes::makei(coded.length(), i => {
    if i >= 20 && i < 30 {
      0
    } else {
      coded[i]
    }
  })
  assert_eq(decode(zero).1, expected)
  let illegal = Bytes::makei(coded.length(), i => {
    if i == 29 {
      1
    } else {
      coded[i]
    }
  })
  assert_true(
    (Ok(decode(illegal)) catch { e => Err(e) }) is Err(InvalidData(_)),
  )
}

///|
test "metadata and frame dimensions are checked before scan allocation" {
  let frame : Frame = { width: 4, height: 4, bits: 12, near: 0, }
  let coded = encode(frame, FixedArray::make(16, 0))
  let application = b"\xff\xe2\x00\x05\xff\xda\x00"
  let augmented = coded[:2].to_owned() + application + coded[2:].to_owned()
  assert_eq(decode(augmented).0, frame)
  let limits : Limits = { ..Limits::default(), max_metadata_bytes: 6, }
  assert_true(
    (Ok(decode(augmented, limits~)) catch { e => Err(e) })
    is Err(ResourceLimit(_)),
  )
  let huge = Bytes::makei(coded.length(), i => {
    if i >= 7 && i <= 10 {
      255
    } else {
      coded[i]
    }
  })
  let stream = Decoder::new(Limits::default())
  let workspace = stream.workspace_bytes()
  assert_true(
    stream.step(huge, 0, huge.length(), true).status is Failed(ResourceLimit(_)),
  )
  assert_eq(stream.workspace_bytes(), workspace)
}

///|
test "legal fill and unsupported features remain distinct from malformed markers" {
  let frame : Frame = { width: 1, height: 1, bits: 8, near: 0, }
  let coded = encode(frame, [255])
  let fill = b"\xff" + coded[:coded.length() - 1].to_owned() + b"\xff\xd9"
  decode_chunks(fill, [1, 2, fill.length() - 1, fill.length()], frame, [255])
  let malformed_sampling = Bytes::makei(coded.length(), i => {
    if i == 13 {
      0x51
    } else {
      coded[i]
    }
  })
  assert_true(
    (Ok(decode(malformed_sampling)) catch { e => Err(e) })
    is Err(InvalidData(_)),
  )
  let transformed = Bytes::makei(coded.length(), i => {
    if i == 24 {
      15
    } else {
      coded[i]
    }
  })
  let mapped = Bytes::makei(coded.length(), i => if i == 21 { b'\x01' } else { coded[i] })
  assert_true((Ok(decode(mapped)) catch { e => Err(e) }) is Err(UnsupportedFeature(_)))
  let transform_and_mapping = Bytes::makei(coded.length(), i => {
    if i == 21 {
      1
    } else {
      transformed[i]
    }
  })
  assert_true(
    (Ok(decode(transform_and_mapping)) catch { e => Err(e) })
    is Err(InvalidData(_)),
  )
  let sof57 = b"\xff\xd8\xff\xf9"
  assert_true(
    (Ok(decode(sof57)) catch { e => Err(e) }) is Err(UnsupportedFeature(_)),
  )
}

///|
test "high NEAR streams and out-of-range arguments preserve error categories" {
  for (bits, upper) in [(8, 127), (12, 255), (16, 255)] {
    let frame : Frame = { width: 19, height: 3, bits, near: upper, }
    let original = pattern(frame)
    let coded = encode_chunks(frame, original, 1, 1)
    assert_eq(coded, encode(frame, original))
    let (info, reconstructed) = decode(coded)
    assert_eq(info, frame)
    for i in 0..<original.length() {
      assert_true((original[i] - reconstructed[i]).abs() <= upper)
    }
    let single_bytes = Array::makei(coded.length(), i => i + 1)
    decode_chunks(coded, single_bytes, frame, reconstructed)
    for near in [-1, upper + 1] {
      let invalid : Frame = { ..frame, near, }
      assert_true(
        (Ok(Encoder::new(invalid, Limits::default())) catch { e => Err(e) })
        is Err(InvalidArgument(_)),
      )
    }
  }
}
