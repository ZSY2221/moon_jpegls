fn check_gray() -> Unit raise Error {
  let source : FixedArray[Int32] = [0, 1, 32767, 32768, 65534, 65535]
  for near in [0, 3] {
    let frame : @jls.Frame = { width: 3, height: 2, bits: 16, near }
    let coded = @jls.encode(frame, source)
    let (parsed, reconstructed) = @jls.decode(coded)
    assert_eq(parsed, frame)
    assert_eq(reconstructed.length(), source.length())
    let mut measured = 0
    for i in 0..<source.length() {
      let difference = (reconstructed[i] - source[i]).abs()
      assert_true(difference <= near)
      measured = measured.max(difference)
    }

    // Withhold EOI so every RowReady must be provisional. Then deliver EOI.
    let decoder = @jls.Decoder::new(@jls.Limits::default())
    let prefix = coded.length() - 2
    let mut offset = 0
    let mut rows = 0
    while true {
      let step = decoder.step(coded, offset, prefix - offset, false)
      offset += step.consumed
      match step.status {
        RowReady => {
          let row = decoder.row()
          assert_eq(rows, decoder.current_row())
          for x in 0..<row.length() {
            assert_eq(row[x], reconstructed[rows * frame.width + x])
          }
          rows += 1
        }
        NeedInput => break
        _ => abort("unexpected result before EOI")
      }
    }
    assert_eq(rows, frame.height)
    assert_eq(offset, prefix)
    assert_eq(decoder.step(coded, offset, 2, true).status, Done)
    let trailing = try {
      ignore(@jls.decode(coded + b"\x00"))
      false
    } catch {
      @jls.InvalidData(message) => message == "trailing bytes after EOI"
      _ => false
    }
    assert_true(trailing)
    println("gray bits=16 near=\{near} samples=\{source.length()} rows_before_eoi=\{rows} max_error=\{measured} strict_tail=passed")
  }
}

fn check_multicomponent() -> Unit raise Error {
  let interleaved : @jls.FrameInfo = {
    width: 2,
    height: 2,
    bits: 16,
    components: [
      { id: 2, h_sampling: 1, v_sampling: 1 },
      { id: 7, h_sampling: 1, v_sampling: 1 },
    ],
  }
  let ilv2 : @jls.MultiScanSpec = {
    component_ids: [2, 7],
    interleave: 2,
    near: 0,
    point_transform: 0,
    preset: @jls.Preset::defaults(),
  }
  let input : FixedArray[Int32] = [0, 65535, 1, 32768, 32767, 17, 65534, 9]
  let (frame2, scan2, plane2) = @jls.decode_multicomponent(@jls.encode_scans(interleaved, [ilv2], input))
  assert_eq(frame2, interleaved)
  assert_eq(scan2[0].interleave, 2)
  assert_eq(plane2, [0, 1, 32767, 65534, 65535, 32768, 17, 9])
  println("ilv2 planes=\{frame2.component_count()} samples=\{plane2.length()}")

  let sampled : @jls.FrameInfo = {
    width: 5,
    height: 3,
    bits: 8,
    components: [
      { id: 2, h_sampling: 2, v_sampling: 2 },
      { id: 7, h_sampling: 1, v_sampling: 1 },
    ],
  }
  let ilv1 = { ..ilv2, interleave: 1 }
  let mcu_rows : FixedArray[Int32] = [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 100, 101, 102,
    10, 11, 12, 13, 14, 103, 104, 105,
  ]
  let (frame1, scan1, plane1) = @jls.decode_multicomponent(@jls.encode_scans(sampled, [ilv1], mcu_rows))
  assert_eq(frame1, sampled)
  assert_eq(frame1.component_width(1), 3)
  assert_eq(frame1.component_height(1), 2)
  assert_eq(scan1[0].interleave, 1)
  assert_eq(scan1[0].rows_decoded, 5)
  assert_eq(plane1, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 100, 101, 102, 103, 104, 105])
  println("sampled first=\{frame1.component_width(0)}x\{frame1.component_height(0)} second=\{frame1.component_width(1)}x\{frame1.component_height(1)} rows=\{scan1[0].rows_decoded} samples=\{plane1.length()}")
}

fn check_wide_and_mapped() -> Unit raise Error {
  // Independent CharLS coded-domain sample, with SOS Al set to 2.
  let wide = b"\xff\xd8\xff\xf7\x00\x0b\x10\x00\x01\x00\x01\x01\x01\x11\x00\xff\xf8\x00\x0d\x01\xff\xff\x00\x18\x00\x4d\x01\x22\x00\x40\xff\xda\x00\x08\x01\x01\x00\x02\x00\x02\x00\x00\x00\x33\x20\xff\xd9"
  let (frame, wide_pixels) = @jls.decode(wide)
  let wide_scan = @jls.inspect(wide).scans[0]
  assert_eq(frame.near, 2)
  assert_eq(wide_scan.point_transform, 2)
  assert_eq(wide_pixels, [65540])
  println("wide point_transform=\{wide_scan.point_transform} sample=\{wide_pixels[0]}")

  let mapped = b"\xff\xd8\xff\xf7\x00\x0b\x02\x00\x01\x00\x04\x01\x01\x11\x00\xff\xf8\x00\x09\x02\x07\x01\xc9\xd4\xdf\xea\xff\xda\x00\x08\x01\x01\x07\x00\x00\x00\xa7\x80\xff\xd9"
  let decoder = @jls.Decoder::new(@jls.Limits::default())
  let step = decoder.step(mapped, 0, mapped.length() - 2, false)
  assert_eq(step.status, RowReady)
  assert_eq(decoder.scan_mapping_selector(0, 0), 7)
  assert_eq(decoder.current_row_mapping_selector(), 7)
  assert_eq(decoder.row(), [201, 234, 212, 223])
  println("mapping selector=\{decoder.current_row_mapping_selector()} samples=\{decoder.row()[0]},\{decoder.row()[1]},\{decoder.row()[2]},\{decoder.row()[3]}")
  assert_eq(decoder.step(mapped, step.consumed, mapped.length() - step.consumed, true).status, Done)

  let first = Bytes::makei(65530, i => ((11 * i + 201) & 255).to_byte())
  let last = Bytes::makei(6, i => ((11 * (65530 + i) + 201) & 255).to_byte())
  let coded = b"\xff\xd8\xff\xf7\x00\x0b\x10\x00\x01\x00\x07\x01\x01\x11\x00\xff\xf8\xff\xff\x02\x07\x01" +
    first + b"\xff\xf8\x00\x0b\x03\x07\x01" + last +
    b"\xff\xda\x00\x08\x01\x01\x07\x00\x00\x00\xa0\x04\x23\x86\x50\x02\x00\x80\x00\xff\xd9"
  let (_, continued) = @jls.decode(coded)
  assert_eq(continued, [201, 190, 132, 113, 124, 135, 146])
  println("mapping_lse3 entries=\{first.length() + last.length()} samples=\{continued.length()} last=\{continued[6]}")
}

fn main {
  try {
    check_gray()
    check_multicomponent()
    check_wide_and_mapped()
  } catch {
    error => abort("consumer verification failed: \{error}")
  }
}
