fn main {
  let cases : Array[(Int32, Int32, FixedArray[Int32])] = [
    (12, 4093, [0, 1, 2047, 2048, 4092, 4093]),
    (16, 50000, [0, 1, 32767, 32768, 49999, 50000]),
  ]
  for (bits, maxval, original) in cases {
    for near in [0, 255] {
      let frame : @jls.Frame = { width: 3, height: 2, bits, near }
      let preset : @jls.Preset = { maxval, t1: near + 1, t2: near + 9, t3: near + 27, reset: 511 }
      let coded = @jls.encode(frame, original, preset~)
      let (decoded, effective, samples) = @jls.decode_with_preset(coded)
      assert_eq(decoded, frame)
      assert_eq(effective, preset)
      let encoder = @jls.Encoder::new(frame, @jls.Limits::default(), preset~)
      let output = FixedArray::make(1, b'\x00')
      let bytes : Array[Byte] = []
      let mut sample_offset = 0
      while true {
        let step = encoder.step(original, sample_offset, original.length() - sample_offset, output, true)
        sample_offset += step.consumed
        if step.produced == 1 {
          bytes.push(output[0])
        }
        match step.status {
          Done => break
          NeedOutput | RowReady => ()
          _ => abort("unexpected consumer encoder status")
        }
      }
      assert_eq(sample_offset, original.length())
      assert_eq(Bytes::from_array(bytes[:]), coded)
      let mut maximum = 0
      for i in 0..<samples.length() {
        let error = (samples[i] - original[i]).abs()
        assert_true(error <= near && samples[i] <= maxval)
        if error > maximum { maximum = error }
        println("sample bits=\{bits} near=\{near} index=\{i} original=\{original[i]} reconstructed=\{samples[i]}")
      }
      let decoder = @jls.Decoder::new(@jls.Limits::default())
      let mut offset = 0
      let mut rows = 0
      while true {
        let step = decoder.step(coded, offset, coded.length() - offset, true)
        offset += step.consumed
        match step.status {
          RowReady => {
            assert_eq(decoder.frame(), Some(frame))
            assert_eq(decoder.preset(), Some(preset))
            let row = decoder.row()
            for x in 0..<row.length() {
              assert_eq(row[x], samples[rows * frame.width + x])
            }
            rows += 1
          }
          Done => break
          _ => abort("unexpected consumer decoder status")
        }
      }
      assert_eq(offset, coded.length())
      assert_eq(rows, frame.height)
      println("case bits=\{bits} near=\{near} rows=\{rows} bytes=\{coded.length()} maxError=\{maximum} maxval=\{maxval} reset=\{preset.reset}")
    }
  }
}
