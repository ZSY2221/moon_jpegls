///|
suberror CommandError {
  Usage(String)
  Input(String)
}

///|
struct Source {
  reader : &@io.BinaryReader
  buffer : FixedArray[Byte]
  mut position : Int32
  mut length : Int32
  mut byte_count : Int64
  mut high_water : Int32
}

///|
fn Source::new(reader : &@io.BinaryReader, chunk : Int32) -> Source {
  {
    reader,
    buffer: FixedArray::make(chunk, b'\x00'),
    position: 0,
    length: 0,
    byte_count: 0L,
    high_water: 0,
  }
}

///|
async fn Source::fill(self : Source) -> Bool {
  if self.position == self.length {
    self.length = self.reader.read_into(self.buffer.mut_view())
    self.position = 0
    self.byte_count += self.length.to_int64()
    if self.length > self.high_water {
      self.high_water = self.length
    }
  }
  self.position < self.length
}

///|
async fn Source::next(self : Source) -> Int32 {
  if !self.fill() {
    return -1
  }
  let byte = self.buffer[self.position].to_int()
  self.position += 1
  byte
}

///|
struct PgmHeader {
  source : Source
  mut bytes : Int32
}

///|
async fn PgmHeader::byte(self : PgmHeader) -> Int32 {
  let byte = self.source.next()
  self.bytes += 1
  guard self.bytes <= 8192 else { raise Input("PGM header exceeds 8192 bytes") }
  guard byte >= 0 else { raise Input("truncated PGM header") }
  byte
}

///|
fn space(byte : Int32) -> Bool {
  byte == 32 || (byte >= 9 && byte <= 13)
}

///|
async fn PgmHeader::token(self : PgmHeader) -> String {
  let mut byte = self.byte()
  while space(byte) || byte == 35 {
    if byte == 35 {
      while byte != 10 && byte != 13 {
        byte = self.byte()
      }
    }
    byte = self.byte()
  }
  let token = StringBuilder()
  let mut length = 0
  while !space(byte) {
    guard byte > 32 && byte < 127 && length < 16 else {
      raise Input("invalid PGM header token")
    }
    token.write_char(byte.unsafe_to_char())
    length += 1
    byte = self.byte()
  }
  token.to_string()
}

///|
async fn read_pnm_header(
  source : Source,
  magic : String,
  label : String,
) -> (Int32, Int32, Int32, Int32) {
  let header : PgmHeader = { source, bytes: 0, }
  guard header.token() == magic else {
    raise Input("expected a binary \{magic} \{label}")
  }
  let width = @string.parse_int(header.token()[:])
  let height = @string.parse_int(header.token()[:])
  let maxval = @string.parse_int(header.token()[:])
  guard maxval >= 1 && maxval <= 65535 else {
    raise Input("\{label} MAXVAL must be in 1..65535")
  }
  let raw_bits = 32 - maxval.clz()
  let bits = if raw_bits < 2 { 2 } else { raw_bits }
  (width, height, bits, maxval)
}

///|
async fn read_pgm(source : Source, near : Int32) -> (@jls.Frame, Int32) {
  let (width, height, bits, maxval) = read_pnm_header(source, "P5", "PGM")
  let frame : @jls.Frame = { width, height, bits, near }
  (frame, maxval)
}

///|
async fn read_ppm(source : Source, near : Int32) -> (@jls.FrameInfo, Int32) {
  ignore(near)
  let (width, height, bits, maxval) = read_pnm_header(source, "P6", "PPM")
  let frame : @jls.FrameInfo = {
    width,
    height,
    bits,
    components: [
      { id: 1, h_sampling: 1, v_sampling: 1 },
      { id: 2, h_sampling: 1, v_sampling: 1 },
      { id: 3, h_sampling: 1, v_sampling: 1 },
    ],
  }
  (frame, maxval)
}

///|
async fn Source::samples(
  self : Source,
  samples : FixedArray[Int32],
  wide : Bool,
  big : Bool,
) -> Int32 {
  let target = samples.length()
  let buf = self.buffer
  let mut out = 0
  if !wide {
    while out < target {
      if self.position == self.length && !self.fill() {
        return out
      }
      let avail = self.length - self.position
      let rem = target - out
      let take = if rem < avail { rem } else { avail }
      let mut p = self.position
      let stop = out + take
      while out < stop {
        samples[out] = buf[p].to_int()
        p += 1
        out += 1
      }
      self.position = p
    }
    return out
  }
  while out < target {
    if self.position == self.length && !self.fill() {
      return out
    }
    let avail = self.length - self.position
    let pairs = avail >> 1
    if pairs > 0 {
      let rem = target - out
      let take = if rem < pairs { rem } else { pairs }
      let mut p = self.position
      let stop = out + take
      if big {
        while out < stop {
          samples[out] = (buf[p].to_int() << 8) | buf[p + 1].to_int()
          p += 2
          out += 1
        }
      } else {
        while out < stop {
          samples[out] = (buf[p + 1].to_int() << 8) | buf[p].to_int()
          p += 2
          out += 1
        }
      }
      self.position = p
    } else {
      let first = buf[self.position].to_int()
      self.position += 1
      let second = self.next()
      guard second >= 0 else { raise Input("incomplete 16-bit sample") }
      samples[out] = if big {
        (first << 8) | second
      } else {
        (second << 8) | first
      }
      out += 1
    }
  }
  out
}

///|
async fn Source::pnm_samples(
  self : Source,
  samples : FixedArray[Int32],
  wide : Bool,
  big : Bool,
  maxval : Int32,
) -> Int32 {
  let count = self.samples(samples, wide, big)
  if maxval < (if wide { 65535 } else { 255 }) {
    for i in 0..<count {
      guard samples[i] <= maxval else { raise Input("sample exceeds PNM MAXVAL") }
    }
  }
  count
}

///|
enum Format {
  RawLittle
  RawBig
  Raw32Little
  Raw32Big
  Pgm
  Ppm
}

///|
fn parse_format(arg : String) -> Format raise CommandError {
  match arg {
    "raw-le" => RawLittle
    "raw-be" => RawBig
    "pgm" => Pgm
    "ppm" => Ppm
    _ => raise Usage("expected raw-le, raw-be, pgm or ppm")
  }
}

///|
fn parse_decode_format(arg : String) -> Format raise CommandError {
  match arg {
    "raw32-le" => Raw32Little
    "raw32-be" => Raw32Big
    _ => parse_format(arg)
  }
}
