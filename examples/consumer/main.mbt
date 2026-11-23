///|
fn main {
  try {
    let original : FixedArray[Int32] = [0, 1, 2047, 2048, 4094, 4095]
    let frame : @jls.Frame = { width: 3, height: 2, bits: 12, near: 0, }
    let encoded = @jls.encode(frame, original)
    let (decoded_frame, reconstructed) = @jls.decode(encoded)
    assert_eq(decoded_frame.width, frame.width)
    assert_eq(decoded_frame.height, frame.height)
    assert_eq(decoded_frame.bits, frame.bits)
    assert_eq(reconstructed, original)
    println(
      "MoonJLS 12-bit 3x2 lossless verified, \{encoded.length()} encoded bytes",
    )

    let padded = b"\x00\x00\xff\xff\xa5\xa5\xa5\x80\x00\x7f\xff"
    let source = @raster.Image::of(2, 2, Gray16, padded, stride=7)
    let jls = @gray16.encode(source, bits=16, near=0)
    let (metadata, rebuild) = @gray16.decode(jls)
    assert_eq(metadata.bits, 16)
    assert_eq(rebuild.pixels, b"\x00\x00\xff\xff\x80\x00\x7f\xff")
    println(
      "MoonImage Gray16 2x2 lossless verified, \{jls.length()} encoded bytes",
    )
  } catch {
    error => abort("consumer example failed: \{error}")
  }
}
