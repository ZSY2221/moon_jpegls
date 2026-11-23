///|
fn limits(
  width : Int32,
  height : Int32,
  pixels : Int32,
  metadata : Int32,
) -> @jls.Limits {
  let defaults = @jls.Limits::default()
  {
    max_width: if width < 0 {
      defaults.max_width
    } else {
      width
    },
    max_height: if height < 0 {
      defaults.max_height
    } else {
      height
    },
    max_pixels: if pixels < 0 {
      defaults.max_pixels
    } else {
      pixels
    },
    max_metadata_bytes: if metadata < 0 {
      defaults.max_metadata_bytes
    } else {
      metadata
    },
  }
}

///|
fn status_code(status : @jls.Status) -> Int32 {
  match status {
    NeedInput => 0
    NeedOutput => 1
    RowReady => 2
    Done => 3
    Failed(InvalidData(_)) => -1
    Failed(UnsupportedFeature(_)) => -2
    Failed(ResourceLimit(_)) => -3
    Failed(Truncated) => -4
    Failed(InvalidArgument(_)) => -5
    Failed(Cancelled) => -6
  }
}

///|
fn status_message(status : @jls.Status) -> String {
  match status {
    Failed(InvalidData(detail))
    | Failed(UnsupportedFeature(detail))
    | Failed(ResourceLimit(detail))
    | Failed(InvalidArgument(detail)) => detail
    Failed(Truncated) => "Unexpected end of input"
    Failed(Cancelled) => "Operation cancelled"
    _ => ""
  }
}

///|
pub struct EncodePort {
  codec : @jls.Encoder?
  input : FixedArray[Int32]
  output : FixedArray[Byte]
  mut consumed : Int32
  mut produced : Int32
  mut status : @jls.Status
}

///|
#export_name("encoder_new")
pub fn encoder_new(
  width : Int32,
  height : Int32,
  bits : Int32,
  near : Int32,
  input_capacity : Int32,
  output_capacity : Int32,
  max_width : Int32,
  max_height : Int32,
  max_pixels : Int32,
  max_metadata : Int32,
) -> EncodePort {
  let frame : @jls.Frame = { width, height, bits, near, }
  let budget = limits(max_width, max_height, max_pixels, max_metadata)
  try {
    let codec = @jls.Encoder::new(frame, budget)
    {
      codec: Some(codec),
      input: FixedArray::make(input_capacity, 0),
      output: FixedArray::make(output_capacity, 0),
      consumed: 0,
      produced: 0,
      status: NeedInput,
    }
  } catch {
    error =>
      {
        codec: None,
        input: [],
        output: [],
        consumed: 0,
        produced: 0,
        status: Failed(error),
      }
  }
}

///|
#export_name("encoder_status")
pub fn encoder_status(port : EncodePort) -> Int32 {
  status_code(port.status)
}

///|
#export_name("encoder_message")
pub fn encoder_message(port : EncodePort) -> String {
  status_message(port.status)
}

///|
#export_name("encoder_set")
pub fn encoder_set(port : EncodePort, index : Int32, value : Int32) -> Unit {
  port.input[index] = value
}

///|
#export_name("encoder_step")
pub fn encoder_step(
  port : EncodePort,
  offset : Int32,
  count : Int32,
  eof : Int32,
) -> Int32 {
  if port.codec is Some(codec) {
    let step = codec.step(port.input, offset, count, port.output, eof != 0)
    port.consumed = step.consumed
    port.produced = step.produced
    port.status = step.status
  }
  status_code(port.status)
}

///|
#export_name("encoder_consumed")
pub fn encoder_consumed(port : EncodePort) -> Int32 {
  port.consumed
}

///|
#export_name("encoder_produced")
pub fn encoder_produced(port : EncodePort) -> Int32 {
  port.produced
}

///|
#export_name("encoder_byte")
pub fn encoder_byte(port : EncodePort, index : Int32) -> Int32 {
  port.output[index].to_int()
}

///|
#export_name("encoder_workspace")
pub fn encoder_workspace(port : EncodePort) -> Int32 {
  match port.codec {
    Some(codec) => codec.workspace_bytes()
    None => 0
  }
}

///|
#export_name("encoder_cancel")
pub fn encoder_cancel(port : EncodePort) -> Unit {
  if port.codec is Some(codec) {
    codec.cancel()
  }
}

///|
pub struct DecodePort {
  codec : @jls.Decoder
  staging : FixedArray[Byte]
  mut input : Bytes
  mut consumed : Int32
  mut status : @jls.Status
}

///|
#export_name("decoder_new")
pub fn decoder_new(
  input_capacity : Int32,
  max_width : Int32,
  max_height : Int32,
  max_pixels : Int32,
  max_metadata : Int32,
) -> DecodePort {
  {
    codec: @jls.Decoder::new(
      limits(max_width, max_height, max_pixels, max_metadata),
    ),
    staging: FixedArray::make(input_capacity, 0),
    input: b"",
    consumed: 0,
    status: NeedInput,
  }
}

///|
#export_name("decoder_set")
pub fn decoder_set(port : DecodePort, index : Int32, value : Int32) -> Unit {
  port.staging[index] = value.to_byte()
}

///|
#export_name("decoder_load")
pub fn decoder_load(port : DecodePort, count : Int32) -> Unit {
  port.input = Bytes::from_array(port.staging[:count])
}

///|
#export_name("decoder_step")
pub fn decoder_step(
  port : DecodePort,
  offset : Int32,
  count : Int32,
  eof : Int32,
) -> Int32 {
  let step = port.codec.step(port.input, offset, count, eof != 0)
  port.consumed = step.consumed
  port.status = step.status
  status_code(port.status)
}

///|
#export_name("decoder_message")
pub fn decoder_message(port : DecodePort) -> String {
  status_message(port.status)
}

///|
#export_name("decoder_consumed")
pub fn decoder_consumed(port : DecodePort) -> Int32 {
  port.consumed
}

///|
#export_name("decoder_frame")
pub fn decoder_frame(port : DecodePort, field : Int32) -> Int32 {
  match port.codec.frame() {
    None => 0
    Some(frame) =>
      match field {
        0 => frame.width
        1 => frame.height
        2 => frame.bits
        _ => frame.near
      }
  }
}

///|
#export_name("decoder_sample")
pub fn decoder_sample(port : DecodePort, index : Int32) -> Int32 {
  port.codec.row()[index]
}

///|
#export_name("decoder_workspace")
pub fn decoder_workspace(port : DecodePort) -> Int32 {
  port.codec.workspace_bytes()
}

///|
#export_name("decoder_cancel")
pub fn decoder_cancel(port : DecodePort) -> Unit {
  port.codec.cancel()
}
