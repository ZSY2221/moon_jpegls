///|
/// Encode MoonImage Gray16 memory using the caller's declared JPEG-LS
/// precision. The raster's unsigned big-endian integers are read directly.
pub fn encode(
  image : @raster.Image,
  bits~ : Int32,
  near~ : Int32,
) -> Bytes raise @jls.CodecError {
  guard image.format == @raster.Gray16 else {
    raise @jls.UnsupportedFeature("expected a Gray16 raster")
  }
  let limits = @jls.Limits::default()
  let { width, height, stride, pixels, .. } = image
  guard width > 0 && height > 0 else {
    raise @jls.InvalidArgument("raster dimensions must be positive")
  }
  guard width <= limits.max_width &&
    height <= limits.max_height &&
    width <= limits.max_pixels / height else {
    raise @jls.ResourceLimit("raster dimensions exceed codec limits")
  }
  let row_bytes = width * 2
  let required = (height - 1).to_int64() * stride.to_int64() +
    row_bytes.to_int64()
  guard stride >= row_bytes && required <= pixels.length().to_int64() else {
    raise @jls.InvalidArgument("raster storage does not cover all rows")
  }
  let samples = FixedArray::make(width * height, 0)
  for y in 0..<height {
    let row = y * stride
    for x in 0..<width {
      let offset = row + 2 * x
      samples[y * width + x] = (pixels[offset].to_int() << 8) |
        pixels[offset + 1].to_int()
    }
  }
  @jls.encode({ width, height, bits, near, }, samples, limits~)
}

///|
/// Materialize the decoded unsigned integers in a tightly packed Gray16 image.
/// Keep the returned Frame to recover the effective stored precision and NEAR.
pub fn decode(input : Bytes) -> (@jls.Frame, @raster.Image) raise Error {
  let (frame, samples) = @jls.decode(input)
  let pixels = FixedArray::make(samples.length() * 2, b'\x00')
  for i in 0..<samples.length() {
    pixels[2 * i] = (samples[i] >> 8).to_byte()
    pixels[2 * i + 1] = (samples[i] & 255).to_byte()
  }
  let image = @raster.Image::of(
    frame.width,
    frame.height,
    Gray16,
    Bytes::from_array(pixels[:]),
  )
  (frame, image)
}
