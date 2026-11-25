///|
/// Convenience multi-component encoder. Input samples are planar in scan order
/// (scan 0 full component plane, followed by scan 1 full component plane, etc.).
pub fn encode_multicomponent(
  frame : FrameInfo,
  scans : Array[ScanSpec],
  samples : FixedArray[Int32],
  limits~ : Limits = Limits::default(),
) -> Bytes raise CodecError {
  let encoder = Encoder::new_multicomponent(frame, scans, limits)
  let total = checked_total_samples(
    frame.width,
    frame.height,
    frame.components.length(),
  )
  guard samples.length().to_int64() == total else {
    raise InvalidArgument("incorrect number of samples")
  }
  let block = FixedArray::make(4096, b'\x00')
  let result : Array[Byte] = []
  let mut position = 0
  while true {
    let report = encoder.step(
      samples,
      position,
      samples.length() - position,
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
/// Convenience multi-component decoder returning FrameInfo, per-scan info, and planar Int32 samples
/// ordered by declared component index (comp 0 plane, comp 1 plane, ...).
pub fn decode_multicomponent(
  input : Bytes,
  limits~ : Limits = Limits::default(),
) -> (FrameInfo, Array[ScanInfo], FixedArray[Int32]) raise CodecError {
  let decoder = Decoder::new(limits)
  let mut position = 0
  let mut pixels : FixedArray[Int32] = []
  let mut plane_size = 0
  while true {
    let report = decoder.step(input, position, input.length() - position, true)
    position += report.consumed
    match report.status {
      RowReady => {
        guard decoder.frame_info() is Some(info) else {
          raise InvalidData("missing frame")
        }
        guard decoder.current_scan() is Some(scan_info) else {
          raise InvalidData("missing scan info")
        }
        if pixels.length() == 0 {
          plane_size = info.width * info.height
          let total = checked_total_samples(
            info.width,
            info.height,
            info.components.length(),
          )
          guard total <= 2_147_483_647L else {
            raise ResourceLimit("frame buffer exceeds array index limit")
          }
          pixels = FixedArray::make(total.to_int(), 0)
        }
        let row = decoder.row()
        let row_idx = decoder.current_row()
        let base = scan_info.component_index * plane_size + row_idx * info.width
        for x in 0..<row.length() {
          pixels[base + x] = row[x]
        }
      }
      Done => {
        guard position == input.length() else {
          raise InvalidData("trailing bytes after EOI")
        }
        guard decoder.frame_info() is Some(info) else {
          raise InvalidData("missing frame")
        }
        return (info, decoder.scans(), pixels)
      }
      Failed(error) => raise error
      NeedInput | NeedOutput => raise Truncated
    }
  }
  raise Truncated
}

///|
/// Decodes and validates a full JPEG-LS stream, returning parsed frame, scan, and marker offsets.
pub fn inspect(
  input : Bytes,
  limits~ : Limits = Limits::default(),
) -> StreamStructure raise CodecError {
  let decoder = Decoder::new(limits)
  let mut position = 0
  while true {
    let report = decoder.step(input, position, input.length() - position, true)
    position += report.consumed
    match report.status {
      RowReady => ()
      Done => {
        guard position == input.length() else {
          raise InvalidData("trailing bytes after EOI")
        }
        guard decoder.structure() is Some(structure) else {
          raise InvalidData("missing stream structure")
        }
        return structure
      }
      Failed(error) => raise error
      NeedInput | NeedOutput => raise Truncated
    }
  }
  raise Truncated
}

///|
/// Convenience encoder. The returned compressed image is collected in memory.
pub fn encode(
  frame : Frame,
  pixels : FixedArray[Int32],
  limits~ : Limits = Limits::default(),
  preset~ : Preset = Preset::defaults(),
) -> Bytes raise CodecError {
  encode_multicomponent(
    {
      width: frame.width,
      height: frame.height,
      bits: frame.bits,
      components: [{ id: 1, h_sampling: 1, v_sampling: 1 }],
    },
    [{ component_id: 1, near: frame.near, preset }],
    pixels,
    limits~,
  )
}

///|
/// Convenience decoder. Allocates an entire reconstructed image and rejects trailing bytes.
pub fn decode(
  input : Bytes,
  limits~ : Limits = Limits::default(),
) -> (Frame, FixedArray[Int32]) raise CodecError {
  let (frame, _, pixels) = decode_with_preset(input, limits~)
  (frame, pixels)
}

///|
/// Whole-image decode with the effective scan parameters (single-component streams).
pub fn decode_with_preset(
  input : Bytes,
  limits~ : Limits = Limits::default(),
) -> (Frame, Preset, FixedArray[Int32]) raise CodecError {
  let decoder = Decoder::new(limits)
  let mut position = 0
  let mut rows = 0
  let mut pixels : FixedArray[Int32] = []
  while true {
    let report = decoder.step(input, position, input.length() - position, true)
    position += report.consumed
    match report.status {
      RowReady => {
        guard decoder.frame_info() is Some(info) else {
          raise InvalidData("missing frame")
        }
        guard info.components.length() == 1 else {
          raise UnsupportedFeature("multi-component stream requires decode_multicomponent")
        }
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
        guard decoder.preset() is Some(preset) else {
          raise InvalidData("missing scan parameters")
        }
        return (frame, preset, pixels)
      }
      Failed(error) => raise error
      NeedInput | NeedOutput => raise Truncated
    }
  }
  raise Truncated
}
