///|
test "Gray16 rejects an exact inverse point-transform value above its range" {
  // Independent CharLS entropy fixture with SOS Pt=2. The inverse transform yields 65540.
  let jls = b"\xff\xd8\xff\xf7\x00\x0b\x10\x00\x01\x00\x01\x01\x01\x11\x00\xff\xf8\x00\x0d\x01\xff\xff\x00\x18\x00\x4d\x01\x22\x00\x40\xff\xda\x00\x08\x01\x01\x00\x02\x00\x02\x00\x00\x00\x33\x20\xff\xd9"
  let (_, samples) = @jls.decode(jls)
  assert_eq(samples[0], 65540)
  let result = try {
    ignore(decode(jls))
    false
  } catch {
    @jls.UnsupportedFeature(_) => true
    error => raise error
  }
  assert_true(result)
}
