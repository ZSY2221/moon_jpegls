///|
test "embedded mapping yields exact samples before EOI is available" {
  // CharLS 3.0.0-dev independently decoded the indices [0, 3, 1, 2]
  // and extracted the single-byte mapping table with selector 7.
  let input = b"\xff\xd8\xff\xf7\x00\x0b\x02\x00\x01\x00\x04\x01\x01\x11\x00\xff\xf8\x00\x09\x02\x07\x01\xc9\xd4\xdf\xea\xff\xda\x00\x08\x01\x01\x07\x00\x00\x00\xa7\x80\xff\xd9"
  let decoder = Decoder::new(Limits::default())
  let mut offset = 0
  let mut rows = 0
  let prefix = input.length() - 2
  while offset < prefix {
    let step = decoder.step(input, offset, 1, false)
    offset += step.consumed
    match step.status {
      NeedInput =>
        assert_eq(decoder.step(input, offset, 0, false).status, NeedInput)
      RowReady => {
        assert_eq(decoder.row(), [201, 234, 212, 223])
        assert_eq(decoder.scan_mapping_selector(0, 0), 7)
        assert_eq(decoder.current_row_mapping_selector(), 7)
        rows += 1
      }
      _ => fail("unexpected early decode status")
    }
  }
  if rows == 0 {
    assert_eq(decoder.step(input, offset, 0, false).status, RowReady)
    assert_eq(decoder.row(), [201, 234, 212, 223])
    rows += 1
  }
  assert_eq(rows, 1)
  assert_eq(decoder.step(input, offset, 0, false).status, NeedInput)
  assert_eq(decoder.step(input, offset, 2, true).status, Done)
}
