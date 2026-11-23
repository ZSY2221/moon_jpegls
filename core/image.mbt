///|
/// Convenience encoder. The returned compressed image is collected in memory.
pub fn encode(
  frame : Frame,
  pixels : FixedArray[Int32],
  limits~ : Limits = Limits::default(),
) -> Bytes raise CodecError {
  let encoder = Encoder::new(frame, limits)
  guard pixels.length() == frame.width * frame.height else {
    raise InvalidArgument("incorrect number of samples")
  }
  let block = FixedArray::make(4096, b'\x00')
  let result : Array[Byte] = []
  let mut position = 0
  while true {
    let report = encoder.step(
      pixels,
      position,
      pixels.length() - position,
      block,
      true,
    )
    position += report.consumed
    for index in 0..<report.produced {
      result.push(block[index])
    }
    match report.status {
      RowReady | NeedOutput => ()
      Done => return Bytes::from_array(result[:])
      Failed(error) => raise error
      NeedInput => raise Truncated
    }
  }
  raise Truncated
}

///|
/// Convenience decoder. Allocates an entire reconstructed image and rejects trailing bytes.
pub fn decode(
  input : Bytes,
  limits~ : Limits = Limits::default(),
) -> (Frame, FixedArray[Int32]) raise CodecError {
  let decoder = Decoder::new(limits)
  let mut position = 0
  let mut rows = 0
  let mut pixels : FixedArray[Int32] = []
  while true {
    let report = decoder.step(input, position, input.length() - position, true)
    position += report.consumed
    match report.status {
      RowReady => {
        guard decoder.frame() is Some(frame) else {
          raise InvalidData("missing frame")
        }
        if rows == 0 {
          pixels = FixedArray::make(frame.width * frame.height, 0)
        }
        let row = decoder.row()
        for x in 0..<row.length() {
          pixels[rows * frame.width + x] = row[x]
        }
        rows += 1
      }
      Done => {
        guard position == input.length() else {
          raise InvalidData("trailing bytes after EOI")
        }
        guard decoder.frame() is Some(frame) else {
          raise InvalidData("missing frame")
        }
        return (frame, pixels)
      }
      Failed(error) => raise error
      NeedInput | NeedOutput => raise Truncated
    }
  }
  raise Truncated
}
