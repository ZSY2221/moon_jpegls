///|
priv struct BitWriter {
  pending : FixedArray[Byte]
  mut start : Int32
  mut end : Int32
  mut word : Int32
  mut free : Int32
}

///|
fn BitWriter::with_capacity(capacity : Int32) -> BitWriter {
  {
    pending: FixedArray::make(capacity, b'\x00'),
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
fn BitWriter::frame_header(self : BitWriter, frame : FrameInfo) -> Unit {
  self.word16(0xFFD8)
  self.word16(0xFFF7)
  let count = frame.components.length()
  self.word16(8 + 3 * count)
  self.byte(frame.bits)
  self.word16(frame.height)
  self.word16(frame.width)
  self.byte(count)
  for comp in frame.components {
    self.byte(comp.id)
    self.byte((comp.h_sampling << 4) | comp.v_sampling)
    self.byte(0)
  }
}

///|
fn BitWriter::lse1(self : BitWriter, preset : Preset) -> Unit {
  self.word16(0xFFF8)
  self.word16(13)
  self.byte(1)
  self.word16(preset.maxval)
  self.word16(preset.t1)
  self.word16(preset.t2)
  self.word16(preset.t3)
  self.word16(preset.reset)
}

///|
fn BitWriter::scan_header(
  self : BitWriter,
  component_ids : Array[Int32],
  near : Int32,
  interleave : Int32,
  point_transform : Int32,
) -> Unit {
  let count = component_ids.length()
  self.word16(0xFFDA)
  self.word16(6 + 2 * count)
  self.byte(count)
  for comp_id in component_ids {
    self.byte(comp_id)
    self.byte(0)
  }
  self.byte(near)
  self.byte(interleave)
  self.byte(point_transform)
}

///|
fn BitWriter::finish_scan(self : BitWriter) -> Unit {
  if self.free != 8 {
    // A byte with the stuffed high bit may be required even with no payload.
    self.bits(0, self.free)
  }
  self.word = 0
  self.free = 8
}

///|
fn BitWriter::finish_frame(self : BitWriter) -> Unit {
  self.word16(0xFFD9)
}

///|
fn BitWriter::finish(self : BitWriter) -> Unit {
  self.finish_scan()
  self.finish_frame()
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
fn BitReader::reset(self : BitReader) -> Unit {
  self.word = 0
  self.left = 0
  self.stuffed = false
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
fn GolombReader::reset(self : GolombReader) -> Unit {
  self.zeros = 0
  self.escape = 0
  self.k = 0
  self.qbpp = 0
  self.unary = false
  self.left = 0
  self.value = 0
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
