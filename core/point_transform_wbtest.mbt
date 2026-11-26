///|
test "point transform applies before a hand-derived all-zero run" {
  let frame : Frame = { width: 3, height: 1, bits: 8, near: 0, }
  // Three J[RUNindex]=0 run decisions, padded by zeros to E0.
  let fixture = b"\xff\xd8\xff\xf7\x00\x0b\x08\x00\x01\x00\x03\x01\x01\x11\x00\xff\xda\x00\x08\x01\x01\x00\x00\x00\x02\xe0\xff\xd9"
  assert_eq(encode(frame, [0, 1, 3], point_transform=2), fixture)
  let (_, preset, decoded) = decode_with_preset(fixture)
  assert_eq(preset.maxval, 255)
  assert_eq(decoded, [0, 0, 0])
  for pt in [8, 15] {
    let literal = Bytes::makei(fixture.length(), i => {
      if i == 24 {
        pt.to_byte()
      } else {
        fixture[i]
      }
    })
    assert_eq(encode(frame, [255, 254, 0], point_transform=pt), literal)
    assert_eq(decode(literal).1, [0, 0, 0])
  }
  let mapped = Bytes::makei(fixture.length(), i => {
    if i == 21 {
      b'\x01'
    } else {
      fixture[i]
    }
  })
  assert_true((Ok(decode(mapped)) catch { e => Err(e) }) is Err(InvalidData(_)))
  for pt in [-1, 16] {
    assert_true(
      (Ok(encode(frame, [0, 0, 0], point_transform=pt)) catch { e => Err(e) })
      is Err(InvalidArgument(_)),
    )
  }
  for sample in [-1, 256] {
    assert_true(
      (Ok(encode(frame, [0, 0, sample], point_transform=2)) catch {
        e => Err(e)
      })
      is Err(InvalidArgument(_)),
    )
  }
  let preset = { ..Preset::defaults(), maxval: 15, }
  assert_eq(decode(encode(frame, [0, 59, 63], preset~, point_transform=2)).1, [
    0, 56, 60,
  ])
  assert_true(
    (Ok(encode(frame, [0, 0, 64], preset~, point_transform=2)) catch {
      e => Err(e)
    })
    is Err(InvalidArgument(_)),
  )
}

///|
test "streamed point transform preserves a reconstruction above unsigned sixteen bits" {
  // CharLS 0.10.0 coded-domain fixture with Al set independently. The
  // eighth reconstructed q is 32768, whose exact multiplication is 65536.
  let fixture = b"\xff\xd8\xff\xf7\x00\x0b\x10\x00\x02\x00\x08\x01\x01\x11\x00\xff\xda\x00\x08\x01\x01\x00\x03\x00\x01\xf4\x00\x00\xa3\x80\x00\x14\x98\x00\x81\x91\xe0\x09\x21\x90\x08\xff\xd9"
  let expected : FixedArray[Int32] = [
    0, 0, 0, 0, 0, 32760, 65534, 65536, 0, 65520, 2, 2, 2, 2, 65534, 65534,
  ]
  assert_eq(decode(fixture).1, expected)
  let decoder = Decoder::new(Limits::default())
  let mut offset = 0
  let mut samples = 0
  let mut rows = 0
  while true {
    let length = min(1, fixture.length() - offset)
    let result = decoder.step(fixture, offset, length, length == 0)
    offset += result.consumed
    match result.status {
      RowReady => {
        let row = decoder.row()
        assert_eq(decoder.current_row(), rows)
        assert_eq(row.length(), 8)
        for value in row {
          assert_eq(value, expected[samples])
          samples += 1
        }
        rows += 1
      }
      NeedInput =>
        assert_eq(decoder.step(fixture, offset, 0, false).status, NeedInput)
      Done => break
      _ => fail("unexpected streaming status")
    }
  }
  assert_eq(samples, expected.length())
  assert_eq(rows, 2)
  assert_eq(offset, fixture.length())
  assert_eq(decoder.scans()[0].point_transform, 1)
  assert_eq(decoder.scans()[0].preset.maxval, 65535)
}
