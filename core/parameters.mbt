///|
/// Single-component frame. MAXVAL is `(1 << bits) - 1`.
#derive(Eq, Debug)
pub(all) struct Frame {
  width : Int32
  height : Int32
  bits : Int32
  near : Int32
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
pub fn Frame::maxval(self : Frame) -> Int32 {
  (1 << self.bits) - 1
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
fn validate_dimensions(
  width : Int32,
  height : Int32,
  limits : Limits,
) -> Unit raise CodecError {
  guard width > 0 && height > 0 && width <= 65535 && height <= 65535 else {
    raise InvalidArgument("dimensions must be in 1..65535")
  }
  guard width <= limits.max_width &&
    height <= limits.max_height &&
    width <= limits.max_pixels / height else {
    raise ResourceLimit("frame dimensions exceed limits")
  }
}

///|
fn validate_profile(
  bits : Int32,
  near : Int32,
  maxval : Int32,
) -> Unit raise CodecError {
  guard bits == 8 || bits == 12 || bits == 16 else {
    raise UnsupportedFeature("sample precision")
  }
  guard near <= 3 else { raise UnsupportedFeature("NEAR greater than 3") }
  guard maxval == (1 << bits) - 1 else {
    raise UnsupportedFeature("custom MAXVAL")
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
fn default_parameters(maxval : Int32, near : Int32) -> Parameters {
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
    reset: 64,
    q_lut,
  }
}
