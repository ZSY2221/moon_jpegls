///|
priv struct BitWriter {
  pending : FixedArray[Byte]
  mut start : Int32
  mut end : Int32
  mut word : Int32
  mut free : Int32
}

///|
fn BitWriter::new() -> BitWriter {
  {
    pending: FixedArray::make(32, b'\x00'),
    start: 0,
    end: 0,
    word: 0,
    free: 8,
  }
}

///|
fn BitWriter::byte(self : BitWriter, value : Int32) -> Unit {
  self.pending[self.end] = value.to_byte()
  self.end += 1
}

///|
fn BitWriter::word16(self : BitWriter, value : Int32) -> Unit {
  self.byte(value >> 8)
  self.byte(value & 255)
}

///|
fn BitWriter::bits(self : BitWriter, value : Int32, count : Int32) -> Unit {
  let mut left = count
  while left > 0 {
    let take = min(left, self.free)
    left -= take
    self.free -= take
    self.word = self.word | (((value >> left) & ((1 << take) - 1)) << self.free)
    if self.free == 0 {
      self.byte(self.word)
      self.free = if self.word == 255 { 7 } else { 8 }
      self.word = 0
    }
  }
}

///|
fn BitWriter::symbol(
  self : BitWriter,
  mapped : Int32,
  k : Int32,
  limit : Int32,
  qbpp : Int32,
) -> Unit {
  let unary = mapped >> k
  let escape = limit - qbpp - 1
  if unary < escape {
    self.bits(0, unary)
    self.bits(1, 1)
    self.bits(mapped, k)
  } else {
    self.bits(0, escape)
    self.bits(1, 1)
    self.bits(mapped - 1, qbpp)
  }
}

///|
fn BitWriter::header(
  self : BitWriter,
  frame : Frame,
  preset : Preset?,
) -> Unit {
  self.word16(0xFFD8)
  self.word16(0xFFF7)
  self.word16(11)
  self.byte(frame.bits)
  self.word16(frame.height)
  self.word16(frame.width)
  self.byte(1)
  self.byte(1)
  self.byte(0x11)
  self.byte(0)
  if preset is Some(params) {
    self.word16(0xFFF8)
    self.word16(13)
    self.byte(1)
    self.word16(params.maxval)
    self.word16(params.t1)
    self.word16(params.t2)
    self.word16(params.t3)
    self.word16(params.reset)
  }
}

///|
fn BitWriter::scan_header(self : BitWriter, near : Int32) -> Unit {
  self.word16(0xFFDA)
  self.word16(8)
  self.byte(1)
  self.byte(1)
  self.byte(0)
  self.byte(near)
  self.byte(0)
  self.byte(0)
}

///|
fn BitWriter::finish(self : BitWriter) -> Unit {
  if self.free != 8 {
    // A byte with the stuffed high bit may be required even with no payload.
    self.bits(0, self.free)
  }
  self.word16(0xFFD9)
}

///|
fn BitWriter::drain(
  self : BitWriter,
  output : FixedArray[Byte],
  offset : Int32,
) -> Int32 {
  let count = min(self.end - self.start, output.length() - offset)
  for index in 0..<count {
    output[offset + index] = self.pending[self.start + index]
  }
  self.start += count
  if self.start == self.end {
    self.start = 0
    self.end = 0
  }
  count
}

///|
priv struct BitReader {
  mut word : Int32
  mut left : Int32
  mut stuffed : Bool
}

///|
fn BitReader::new() -> BitReader {
  { word: 0, left: 0, stuffed: false, }
}

///|
fn BitReader::byte(self : BitReader, byte : Int32) -> Int32 {
  if self.stuffed && byte >= 128 {
    return if byte >= 0xD0 && byte <= 0xD7 { 1 } else { 2 }
  }
  self.word = byte
  self.left = if self.stuffed { 7 } else { 8 }
  self.stuffed = byte == 255
  0
}

///|
fn BitReader::take(self : BitReader, count : Int32) -> Int32 {
  self.left -= count
  (self.word >> self.left) & ((1 << count) - 1)
}

///|
priv struct GolombReader {
  mut zeros : Int32
  mut escape : Int32
  mut k : Int32
  mut qbpp : Int32
  mut unary : Bool
  mut left : Int32
  mut value : Int32
}

///|
fn GolombReader::new() -> GolombReader {
  { zeros: 0, escape: 0, k: 0, qbpp: 0, unary: false, left: 0, value: 0, }
}

///|
fn GolombReader::start(
  self : GolombReader,
  k : Int32,
  limit : Int32,
  qbpp : Int32,
) -> Unit {
  self.zeros = 0
  self.escape = limit - qbpp - 1
  self.k = k
  self.qbpp = qbpp
  self.unary = true
  self.left = 0
  self.value = 0
}

///|
fn GolombReader::read(
  self : GolombReader,
  bits : BitReader,
) -> Int32 {
  while self.unary {
    if bits.left == 0 {
      return -1
    }
    if bits.take(1) == 1 {
      self.unary = false
      self.left = if self.zeros == self.escape { self.qbpp } else { self.k }
    } else {
      self.zeros += 1
      if self.zeros > self.escape {
        return -2
      }
    }
  }
  let count = min(self.left, bits.left)
  self.value = (self.value << count) | bits.take(count)
  self.left -= count
  if self.left > 0 {
    -1
  } else if self.zeros == self.escape {
    self.value + 1
  } else {
    (self.zeros << self.k) | self.value
  }
}
