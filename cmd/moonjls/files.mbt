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
async fn read_pgm(source : Source, near : Int32) -> @jls.Frame {
  let header : PgmHeader = { source, bytes: 0, }
  guard header.token() == "P5" else { raise Input("expected a binary P5 PGM") }
  let width = @string.parse_int(header.token()[:])
  let height = @string.parse_int(header.token()[:])
  let maxval = @string.parse_int(header.token()[:])
  let bits = match maxval {
    255 => 8
    4095 => 12
    65535 => 16
    _ =>
      raise @jls.UnsupportedFeature("PGM MAXVAL; expected 255, 4095 or 65535")
  }
  { width, height, bits, near, }
}

///|
async fn Source::samples(
  self : Source,
  samples : FixedArray[Int32],
  wide : Bool,
  big : Bool,
) -> Int32 {
  for index in 0..<samples.length() {
    let first = self.next()
    if first < 0 {
      return index
    }
    if wide {
      let second = self.next()
      guard second >= 0 else { raise Input("incomplete 16-bit sample") }
      samples[index] = if big {
        (first << 8) | second
      } else {
        (second << 8) | first
      }
    } else {
      samples[index] = first
    }
  }
  samples.length()
}

///|
enum Format {
  RawLittle
  RawBig
  Pgm
}

///|
fn parse_format(arg : String) -> Format raise CommandError {
  match arg {
    "raw-le" => RawLittle
    "raw-be" => RawBig
    "pgm" => Pgm
    _ => raise Usage("expected raw-le, raw-be or pgm")
  }
}
