///|
/// Single-component frame geometry, coded precision and NEAR. See Preset for the active MAXVAL.
#derive(Eq, Debug)
pub(all) struct Frame {
  width : Int32
  height : Int32
  bits : Int32
  near : Int32
}

///|
/// Component specification declared in SOF55.
#derive(Eq, Debug)
pub(all) struct ComponentSpec {
  id : Int32
  h_sampling : Int32
  v_sampling : Int32
}

///|
/// Frame-level geometry, precision, and component table independent of per-scan NEAR/presets.
#derive(Eq, Debug)
pub(all) struct FrameInfo {
  width : Int32
  height : Int32
  bits : Int32
  components : Array[ComponentSpec]
}

///|
/// Requested scan encoding parameters for one non-interleaved component scan.
#derive(Eq, Debug)
pub(all) struct ScanSpec {
  component_id : Int32
  near : Int32
  preset : Preset
}

///|
/// Decoded or encoded metadata for one JPEG-LS scan segment and its byte boundaries.
#derive(Eq, Debug)
pub(all) struct ScanInfo {
  scan_index : Int32
  component_index : Int32
  component_id : Int32
  near : Int32
  interleave : Int32
  point_transform : Int32
  preset : Preset
  header_offset : Int64
  entropy_offset : Int64
  end_offset : Int64
  rows_decoded : Int32
  completed : Bool
}

///|
/// Parsed marker record with exact codestream byte offset and segment length (including marker bytes).
#derive(Eq, Debug)
pub(all) struct MarkerRecord {
  code : Int32
  offset : Int64
  length : Int32
  scan_index : Int32
  detail : Int32
}

///|
/// Structured error location pointing at the active scan, component, marker, or offset.
#derive(Eq, Debug)
pub(all) struct ErrorLocation {
  scan_index : Int32
  component_id : Int32
  marker : Int32
  offset : Int64
}

///|
/// Complete parsed frame, scan, and marker layout for a JPEG-LS interchange stream.
#derive(Eq, Debug)
pub(all) struct StreamStructure {
  soi_offset : Int64
  sof_offset : Int64
  sof_length : Int32
  eoi_offset : Int64
  frame : FrameInfo
  scans : Array[ScanInfo]
  markers : Array[MarkerRecord]
}

///|
/// Coding parameters for the current scan. Zero fields request the defaults in T.87 Table C.2.
#derive(Eq, Debug)
pub(all) struct Preset {
  maxval : Int32
  t1 : Int32
  t2 : Int32
  t3 : Int32
  reset : Int32
}

///|
pub fn Preset::defaults() -> Preset {
  { maxval: 0, t1: 0, t2: 0, t3: 0, reset: 0 }
}

///|
pub(all) struct Limits {
  max_width : Int32
  max_height : Int32
  max_pixels : Int32
  max_metadata_bytes : Int32
}

///|
pub fn Limits::default() -> Limits {
  {
    max_width: 65535,
    max_height: 65535,
    max_pixels: 100_000_000,
    max_metadata_bytes: 1_048_576,
  }
}

///|
#derive(Eq, Debug)
pub(all) suberror CodecError {
  InvalidData(String)
  UnsupportedFeature(String)
  ResourceLimit(String)
  Truncated
  InvalidArgument(String)
  Cancelled
}

///|
#derive(Eq, Debug)
pub(all) enum Status {
  NeedInput
  NeedOutput
  RowReady
  Done
  Failed(CodecError)
}

///|
pub(all) struct EncodeStep {
  consumed : Int32
  produced : Int32
  status : Status
}

///|
pub(all) struct DecodeStep {
  consumed : Int32
  status : Status
}

///|
/// Full-scale default for this precision. Use the active scan Preset for the effective value.
pub fn Frame::maxval(self : Frame) -> Int32 {
  (1 << self.bits) - 1
}

///|
/// Full-scale default for FrameInfo precision.
pub fn FrameInfo::maxval(self : FrameInfo) -> Int32 {
  (1 << self.bits) - 1
}

///|
pub fn FrameInfo::component_count(self : FrameInfo) -> Int32 {
  self.components.length()
}

///|
pub fn FrameInfo::find_component(self : FrameInfo, id : Int32) -> Int32? {
  for index in 0..<self.components.length() {
    if self.components[index].id == id {
      return Some(index)
    }
  }
  None
}

///|
pub fn checked_total_samples(
  width : Int32,
  height : Int32,
  components : Int32,
) -> Int64 {
  width.to_int64() * height.to_int64() * components.to_int64()
}

///|
pub fn checked_raw_bytes(
  width : Int32,
  height : Int32,
  components : Int32,
  bits : Int32,
) -> Int64 {
  let bytes_per_sample = if bits <= 8 { 1L } else { 2L }
  checked_total_samples(width, height, components) * bytes_per_sample
}

///|
fn validate_limits(limits : Limits) -> Unit raise CodecError {
  guard limits.max_width > 0 &&
    limits.max_height > 0 &&
    limits.max_pixels > 0 &&
    limits.max_metadata_bytes >= 0 else {
    raise InvalidArgument("invalid resource limits")
  }
}

///|
fn validate_frame_dimensions(
  width : Int32,
  height : Int32,
  components : Int32,
  limits : Limits,
) -> Unit raise CodecError {
  guard width > 0 && height > 0 && width <= 65535 && height <= 65535 else {
    raise InvalidArgument("dimensions must be in 1..65535")
  }
  guard components > 0 && components <= 255 else {
    raise InvalidArgument("component count must be in 1..255")
  }
  let total_samples = checked_total_samples(width, height, components)
  guard width <= limits.max_width &&
    height <= limits.max_height &&
    total_samples <= limits.max_pixels.to_int64() else {
    raise ResourceLimit("frame dimensions exceed limits")
  }
}

///|
priv struct Parameters {
  maxval : Int32
  near : Int32
  step : Int32
  range : Int32
  half_range : Int32
  min_err : Int32
  max_err : Int32
  wrap : Int32
  maxval_plus_near : Int32
  neg_near : Int32
  qbpp : Int32
  limit : Int32
  escape_limit : Int32
  t1 : Int32
  t2 : Int32
  t3 : Int32
  reset : Int32
  q_lut : FixedArray[Int32]
}

///|
fn ceil_log2(value : Int32) -> Int32 {
  let mut power = 0
  let mut bound = 1
  while bound < value {
    bound = bound << 1
    power += 1
  }
  power
}

///|
fn min(a : Int32, b : Int32) -> Int32 {
  if a < b {
    a
  } else {
    b
  }
}

///|
fn max(a : Int32, b : Int32) -> Int32 {
  if a > b {
    a
  } else {
    b
  }
}

///|
fn clamp_default(value : Int32, lower : Int32, upper : Int32) -> Int32 {
  if value < lower || value > upper {
    lower
  } else {
    value
  }
}

///|
fn default_preset(maxval : Int32, near : Int32) -> Preset {
  let (base1, base2, base3) = if maxval >= 128 {
    let factor = (min(maxval, 4095) + 128) / 256
    (
      factor + 2 + 3 * near,
      4 * factor + 3 + 5 * near,
      17 * factor + 4 + 7 * near,
    )
  } else {
    let factor = 256 / (maxval + 1)
    (
      max(2, 3 / factor + 3 * near),
      max(3, 7 / factor + 5 * near),
      max(4, 21 / factor + 7 * near),
    )
  }
  let t1 = clamp_default(base1, near + 1, maxval)
  let t2 = clamp_default(base2, t1, maxval)
  let t3 = clamp_default(base3, t2, maxval)
  { maxval, t1, t2, t3, reset: 64 }
}

///|
/// Tests a resolved preset against the default thresholds for its MAXVAL and NEAR.
pub fn Preset::has_custom_thresholds(self : Preset, near : Int32) -> Bool {
  self.maxval > 0 && self != default_preset(self.maxval, near)
}

///|
fn resolve_preset(frame : Frame, requested : Preset) -> Preset raise CodecError {
  guard frame.bits >= 2 && frame.bits <= 16 else {
    raise InvalidArgument("sample precision must be in 2..16")
  }
  let full_range = frame.maxval()
  let maxval = if requested.maxval == 0 { full_range } else { requested.maxval }
  guard maxval >= 1 && maxval <= full_range else {
    raise InvalidArgument("MAXVAL is outside the coded precision")
  }
  let near = frame.near
  guard near >= 0 && near <= min(255, maxval / 2) else {
    raise InvalidArgument("NEAR is outside the range for MAXVAL")
  }
  let defaults = default_preset(maxval, near)
  let t1 = if requested.t1 == 0 { defaults.t1 } else { requested.t1 }
  let t2 = if requested.t2 == 0 { defaults.t2 } else { requested.t2 }
  let t3 = if requested.t3 == 0 { defaults.t3 } else { requested.t3 }
  let reset = if requested.reset == 0 { defaults.reset } else { requested.reset }
  guard near < t1 && t1 <= t2 && t2 <= t3 && t3 <= maxval else {
    raise InvalidArgument("LSE thresholds must satisfy NEAR < T1 <= T2 <= T3 <= MAXVAL")
  }
  guard reset >= 3 && reset <= max(255, maxval) else {
    raise InvalidArgument("LSE RESET is outside the legal range")
  }
  { maxval, t1, t2, t3, reset }
}

///|
fn Parameters::preset(self : Parameters) -> Preset {
  { maxval: self.maxval, t1: self.t1, t2: self.t2, t3: self.t3, reset: self.reset }
}

///|
fn Parameters::new(preset : Preset, near : Int32) -> Parameters {
  let { maxval, t1, t2, t3, reset } = preset
  let step = 2 * near + 1
  let range = (maxval + 2 * near) / step + 1
  let bpp = max(2, ceil_log2(maxval + 1))
  let qbpp = ceil_log2(range)
  let limit = 2 * (bpp + max(8, bpp))
  let q_lut = FixedArray::makei(2 * t3 + 1, i => {
    let g = i - t3
    let mag = g.abs()
    let bucket = if mag >= t3 {
      4
    } else if mag >= t2 {
      3
    } else if mag >= t1 {
      2
    } else if mag > near {
      1
    } else {
      0
    }
    if g < 0 {
      -bucket
    } else {
      bucket
    }
  })
  {
    maxval,
    near,
    step,
    range,
    half_range: (range + 1) >> 1,
    min_err: -(range >> 1),
    max_err: (range - 1) >> 1,
    wrap: range * step,
    maxval_plus_near: maxval + near,
    neg_near: -near,
    qbpp,
    limit,
    escape_limit: limit - qbpp - 1,
    t1,
    t2,
    t3,
    reset,
    q_lut,
  }
}
