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
  encoder_new_with_preset(
    width, height, bits, near, input_capacity, output_capacity,
    max_width, max_height, max_pixels, max_metadata, 0, 0, 0, 0, 0,
  )
}

///|
#export_name("encoder_new_with_preset")
pub fn encoder_new_with_preset(
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
  maxval : Int32,
  t1 : Int32,
  t2 : Int32,
  t3 : Int32,
  reset : Int32,
) -> EncodePort {
  let frame : @jls.Frame = { width, height, bits, near, }
  let budget = limits(max_width, max_height, max_pixels, max_metadata)
  let preset : @jls.Preset = { maxval, t1, t2, t3, reset, }
  try {
    let codec = @jls.Encoder::new(frame, budget, preset~)
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
fn get_preset_field(preset : @jls.Preset, near : Int32, field : Int32) -> Int32 {
  match field {
    0 => preset.maxval
    1 => preset.t1
    2 => preset.t2
    3 => preset.t3
    4 => preset.reset
    _ => if preset.has_custom_thresholds(near) { 1 } else { 0 }
  }
}

///|
#export_name("encoder_preset")
pub fn encoder_preset(port : EncodePort, near : Int32, field : Int32) -> Int32 {
  match port.codec {
    Some(codec) => get_preset_field(codec.preset(), near, field)
    None => 0
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
#export_name("encoder_set8")
pub fn encoder_set8(
  port : EncodePort,
  offset : Int32,
  p0 : Int32,
  p1 : Int32,
  p2 : Int32,
  p3 : Int32,
  p4 : Int32,
  p5 : Int32,
  p6 : Int32,
  p7 : Int32,
) -> Unit {
  let inp = port.input
  let u0 = p0.reinterpret_as_uint()
  let u1 = p1.reinterpret_as_uint()
  let u2 = p2.reinterpret_as_uint()
  let u3 = p3.reinterpret_as_uint()
  let u4 = p4.reinterpret_as_uint()
  let u5 = p5.reinterpret_as_uint()
  let u6 = p6.reinterpret_as_uint()
  let u7 = p7.reinterpret_as_uint()
  inp[offset] = (u0 & 0xFFFFU).reinterpret_as_int()
  inp[offset + 1] = (u0 >> 16).reinterpret_as_int()
  inp[offset + 2] = (u1 & 0xFFFFU).reinterpret_as_int()
  inp[offset + 3] = (u1 >> 16).reinterpret_as_int()
  inp[offset + 4] = (u2 & 0xFFFFU).reinterpret_as_int()
  inp[offset + 5] = (u2 >> 16).reinterpret_as_int()
  inp[offset + 6] = (u3 & 0xFFFFU).reinterpret_as_int()
  inp[offset + 7] = (u3 >> 16).reinterpret_as_int()
  inp[offset + 8] = (u4 & 0xFFFFU).reinterpret_as_int()
  inp[offset + 9] = (u4 >> 16).reinterpret_as_int()
  inp[offset + 10] = (u5 & 0xFFFFU).reinterpret_as_int()
  inp[offset + 11] = (u5 >> 16).reinterpret_as_int()
  inp[offset + 12] = (u6 & 0xFFFFU).reinterpret_as_int()
  inp[offset + 13] = (u6 >> 16).reinterpret_as_int()
  inp[offset + 14] = (u7 & 0xFFFFU).reinterpret_as_int()
  inp[offset + 15] = (u7 >> 16).reinterpret_as_int()
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
#export_name("encoder_word")
pub fn encoder_word(port : EncodePort, offset : Int32) -> Int32 {
  let out = port.output
  out[offset].to_int() |
  (out[offset + 1].to_int() << 8) |
  (out[offset + 2].to_int() << 16) |
  (out[offset + 3].to_int() << 24)
}

///|
#export_name("encoder_pack6")
pub fn encoder_pack6(port : EncodePort, offset : Int32) -> Double {
  let out = port.output
  let lo = out[offset].to_int() |
    (out[offset + 1].to_int() << 8) |
    (out[offset + 2].to_int() << 16)
  let hi = out[offset + 3].to_int() |
    (out[offset + 4].to_int() << 8) |
    (out[offset + 5].to_int() << 16)
  lo.to_double() + hi.to_double() * 16777216.0
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
  mut row : FixedArray[Int32]
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
    row: [],
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
#export_name("decoder_set8")
pub fn decoder_set8(
  port : DecodePort,
  offset : Int32,
  w0 : Int32,
  w1 : Int32,
  w2 : Int32,
  w3 : Int32,
  w4 : Int32,
  w5 : Int32,
  w6 : Int32,
  w7 : Int32,
) -> Unit {
  let st = port.staging
  let u0 = w0.reinterpret_as_uint()
  let u1 = w1.reinterpret_as_uint()
  let u2 = w2.reinterpret_as_uint()
  let u3 = w3.reinterpret_as_uint()
  let u4 = w4.reinterpret_as_uint()
  let u5 = w5.reinterpret_as_uint()
  let u6 = w6.reinterpret_as_uint()
  let u7 = w7.reinterpret_as_uint()
  st[offset] = (u0 & 255U).to_byte()
  st[offset + 1] = ((u0 >> 8) & 255U).to_byte()
  st[offset + 2] = ((u0 >> 16) & 255U).to_byte()
  st[offset + 3] = (u0 >> 24).to_byte()
  st[offset + 4] = (u1 & 255U).to_byte()
  st[offset + 5] = ((u1 >> 8) & 255U).to_byte()
  st[offset + 6] = ((u1 >> 16) & 255U).to_byte()
  st[offset + 7] = (u1 >> 24).to_byte()
  st[offset + 8] = (u2 & 255U).to_byte()
  st[offset + 9] = ((u2 >> 8) & 255U).to_byte()
  st[offset + 10] = ((u2 >> 16) & 255U).to_byte()
  st[offset + 11] = (u2 >> 24).to_byte()
  st[offset + 12] = (u3 & 255U).to_byte()
  st[offset + 13] = ((u3 >> 8) & 255U).to_byte()
  st[offset + 14] = ((u3 >> 16) & 255U).to_byte()
  st[offset + 15] = (u3 >> 24).to_byte()
  st[offset + 16] = (u4 & 255U).to_byte()
  st[offset + 17] = ((u4 >> 8) & 255U).to_byte()
  st[offset + 18] = ((u4 >> 16) & 255U).to_byte()
  st[offset + 19] = (u4 >> 24).to_byte()
  st[offset + 20] = (u5 & 255U).to_byte()
  st[offset + 21] = ((u5 >> 8) & 255U).to_byte()
  st[offset + 22] = ((u5 >> 16) & 255U).to_byte()
  st[offset + 23] = (u5 >> 24).to_byte()
  st[offset + 24] = (u6 & 255U).to_byte()
  st[offset + 25] = ((u6 >> 8) & 255U).to_byte()
  st[offset + 26] = ((u6 >> 16) & 255U).to_byte()
  st[offset + 27] = (u6 >> 24).to_byte()
  st[offset + 28] = (u7 & 255U).to_byte()
  st[offset + 29] = ((u7 >> 8) & 255U).to_byte()
  st[offset + 30] = ((u7 >> 16) & 255U).to_byte()
  st[offset + 31] = (u7 >> 24).to_byte()
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
  if step.status is RowReady {
    port.row = port.codec.row()
  }
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
#export_name("decoder_preset")
pub fn decoder_preset(port : DecodePort, near : Int32, field : Int32) -> Int32 {
  match port.codec.preset() {
    Some(preset) => get_preset_field(preset, near, field)
    None => 0
  }
}

///|
#export_name("decoder_sample")
pub fn decoder_sample(port : DecodePort, index : Int32) -> Int32 {
  port.row[index]
}

///|
#export_name("decoder_pair")
pub fn decoder_pair(port : DecodePort, offset : Int32) -> Int32 {
  let r = port.row
  r[offset] | (r[offset + 1] << 16)
}

///|
#export_name("decoder_pack3")
pub fn decoder_pack3(port : DecodePort, offset : Int32) -> Double {
  let r = port.row
  r[offset].to_double() +
  r[offset + 1].to_double() * 65536.0 +
  r[offset + 2].to_double() * 4294967296.0
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
