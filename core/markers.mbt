///|
priv enum HeaderPhase {
  StartPrefix
  StartCode
  MarkerPrefix
  MarkerCode
  LengthHigh
  LengthLow
  Payload
}

///|
priv struct HeaderParser {
  limits : Limits
  segment : FixedArray[Byte]
  mut phase : HeaderPhase
  mut marker : Int32
  mut length : Int32
  mut index : Int32
  mut skipped : Int32
  mut width : Int32
  mut height : Int32
  mut bits : Int32
  mut component : Int32
  preset : FixedArray[Int32]
}

///|
fn HeaderParser::new(limits : Limits) -> HeaderParser {
  {
    limits,
    segment: FixedArray::make(771, b'\x00'),
    phase: StartPrefix,
    marker: 0,
    length: 0,
    index: 0,
    skipped: 0,
    width: 0,
    height: 0,
    bits: 0,
    component: 0,
    preset: FixedArray::make(5, 0),
  }
}

///|
fn HeaderParser::at(self : HeaderParser, index : Int32) -> Int32 {
  self.segment[index].to_int()
}

///|
fn HeaderParser::word(self : HeaderParser, index : Int32) -> Int32 {
  (self.at(index) << 8) | self.at(index + 1)
}

///|
fn is_metadata(code : Int32) -> Bool {
  code == 0xFE || (code >= 0xE0 && code <= 0xEF)
}

///|
fn HeaderParser::frame_segment(self : HeaderParser) -> Unit raise CodecError {
  guard self.bits == 0 else { raise InvalidData("duplicate SOF55") }
  let count = self.at(5)
  let bits = self.at(0)
  guard count > 0 && self.length == 6 + 3 * count && bits >= 2 && bits <= 16 else {
    raise InvalidData("SOF55 fields or length")
  }
  for index in 0..<count {
    let pos = 6 + 3 * index
    let id = self.at(pos)
    let sampling = self.at(pos + 1)
    let h = sampling >> 4
    let v = sampling & 15
    guard h >= 1 && h <= 4 && v >= 1 && v <= 4 && self.at(pos + 2) == 0 else {
      raise InvalidData("SOF55 component fields")
    }
    for earlier in 0..<index {
      guard id != self.at(6 + 3 * earlier) else {
        raise InvalidData("duplicate SOF55 component identifier")
      }
    }
  }
  guard count == 1 else {
    raise UnsupportedFeature("multiple frame components")
  }
  guard self.at(7) == 0x11 else {
    raise UnsupportedFeature("component subsampling")
  }
  let height = self.word(1)
  let width = self.word(3)
  guard width != 0 && height != 0 else {
    raise UnsupportedFeature("deferred or extended dimensions")
  }
  validate_dimensions(width, height, self.limits)
  self.width = width
  self.height = height
  self.bits = bits
  self.component = self.at(6)
}

///|
fn HeaderParser::preset_segment(self : HeaderParser) -> Unit raise CodecError {
  match self.at(0) {
    1 => {
      guard self.length == 11 else { raise InvalidData("LSE preset length") }
      // An ID=1 segment replaces the active values, including zeros.
      for index in 0..<5 {
        self.preset[index] = self.word(1 + 2 * index)
      }
    }
    0 => raise InvalidData("LSE identifier zero")
    2 => {
      guard self.length >= 4 &&
        self.at(1) > 0 &&
        self.at(2) > 0 &&
        (self.length - 3) % self.at(2) == 0 else {
        raise InvalidData("mapping table fields or length")
      }
      raise UnsupportedFeature("mapping table")
    }
    3 => raise InvalidData("mapping table continuation without a specification")
    4 => {
      let bytes = self.at(1)
      guard bytes >= 2 && bytes <= 4 && self.length == 2 + 2 * bytes else {
        raise InvalidData("extended dimensions length")
      }
      let mut has_width = false
      for index in (2 + bytes)..<self.length {
        has_width = has_width || self.at(index) != 0
      }
      guard has_width else { raise InvalidData("extended width is zero") }
      raise UnsupportedFeature("extended dimensions")
    }
    _ => raise UnsupportedFeature("LSE identifier")
  }
}

///|
fn HeaderParser::scan_segment(
  self : HeaderParser,
) -> (Frame, Parameters) raise CodecError {
  guard self.bits > 0 else { raise InvalidData("SOS precedes SOF55") }
  let count = self.at(0)
  guard count > 0 && count <= 4 && self.length == 4 + 2 * count else {
    raise InvalidData("SOS length or component count")
  }
  guard count == 1 && self.at(1) == self.component else {
    raise InvalidData("SOS component selector")
  }
  let near = self.at(3)
  let ilv = self.at(4)
  let transform = self.at(5)
  let mapping = self.at(2)
  guard ilv == 0 && transform >> 4 == 0 && (transform == 0 || mapping == 0) else {
    raise InvalidData("single-component SOS fields")
  }
  let frame : Frame = { width: self.width, height: self.height, bits: self.bits, near }
  let requested : Preset = {
    maxval: self.preset[0],
    t1: self.preset[1],
    t2: self.preset[2],
    t3: self.preset[3],
    reset: self.preset[4],
  }
  let effective = resolve_preset(frame, requested) catch {
    InvalidArgument(message) => raise InvalidData(message)
    error => raise error
  }
  guard mapping == 0 && transform == 0 else {
    raise UnsupportedFeature("mapping selector or point transform")
  }
  (frame, Parameters::new(effective, near))
}

///|
fn HeaderParser::finish_segment(
  self : HeaderParser,
) -> (Frame, Parameters)? raise CodecError {
  self.phase = MarkerPrefix
  match self.marker {
    0xF7 => self.frame_segment()
    0xF8 => self.preset_segment()
    0xDA => return Some(self.scan_segment())
    0xDD => {
      let mut nonzero = false
      for index in 0..<self.length {
        nonzero = nonzero || self.at(index) != 0
      }
      guard !nonzero else { raise UnsupportedFeature("restart interval") }
    }
    _ => ()
  }
  None
}

///|
fn HeaderParser::accept(
  self : HeaderParser,
  byte : Int32,
) -> (Frame, Parameters)? raise CodecError {
  match self.phase {
    StartPrefix => {
      guard byte == 0xFF else { raise InvalidData("missing SOI prefix") }
      self.phase = StartCode
    }
    StartCode => {
      if byte == 0xFF {
        return None
      }
      guard byte == 0xD8 else { raise InvalidData("missing SOI") }
      self.phase = MarkerPrefix
    }
    MarkerPrefix => {
      guard byte == 0xFF else { raise InvalidData("missing marker prefix") }
      self.phase = MarkerCode
    }
    MarkerCode => {
      if byte == 0xFF {
        return None
      }
      if !is_metadata(byte) {
        match byte {
          0xF7 | 0xF8 | 0xDA | 0xDD => ()
          0xDC | 0xF9 =>
            raise UnsupportedFeature("marker outside JPEG-LS baseline subset")
          0xC0..<=0xCF if self.bits == 0 =>
            raise UnsupportedFeature("JPEG stream uses a different frame type")
          _ => raise InvalidData("unexpected marker before scan")
        }
      }
      self.marker = byte
      self.phase = LengthHigh
    }
    LengthHigh => {
      self.length = byte << 8
      self.phase = LengthLow
    }
    LengthLow => {
      self.length = self.length + byte - 2
      self.index = 0
      guard self.length >= 0 else {
        raise InvalidData("segment length below 2")
      }
      if is_metadata(self.marker) {
        let cost = self.length + 4
        guard cost <= self.limits.max_metadata_bytes - self.skipped else {
          raise ResourceLimit("metadata skip budget")
        }
        self.skipped += cost
      } else {
        let valid = match self.marker {
          0xF7 => self.length >= 9 && self.length <= 771
          0xF8 => self.length >= 1 && self.length <= 65533
          0xDA => self.length >= 6 && self.length <= 12
          _ => self.length >= 2 && self.length <= 4
        }
        guard valid else { raise InvalidData("invalid segment length") }
      }
      if self.length == 0 {
        return self.finish_segment()
      }
      self.phase = Payload
    }
    Payload => {
      if !is_metadata(self.marker) && self.index < self.segment.length() {
        self.segment[self.index] = byte.to_byte()
      }
      self.index += 1
      if self.index == self.length {
        return self.finish_segment()
      }
    }
  }
  None
}
