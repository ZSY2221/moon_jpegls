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
  components : Array[ComponentSpec]
  seen_components : Array[Bool]
  mut scanned_count : Int32
  mut scan_count : Int32
  mut soi_offset : Int64
  mut sof_offset : Int64
  mut sof_length : Int32
  mut marker_offset : Int64
  mut eoi_offset : Int64
  markers : Array[MarkerRecord]
  mut last_component_id : Int32
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
    components: [],
    seen_components: [],
    scanned_count: 0,
    scan_count: 0,
    soi_offset: -1L,
    sof_offset: -1L,
    sof_length: 0,
    marker_offset: 0L,
    eoi_offset: -1L,
    markers: [],
    last_component_id: -1,
    preset: FixedArray::make(5, 0),
  }
}

///|
fn HeaderParser::frame_info(self : HeaderParser) -> FrameInfo {
  {
    width: self.width,
    height: self.height,
    bits: self.bits,
    components: self.components.copy(),
  }
}

///|
fn HeaderParser::all_components_scanned(self : HeaderParser) -> Bool {
  self.bits > 0 && self.scanned_count == self.components.length()
}

///|
fn HeaderParser::find_component(self : HeaderParser, id : Int32) -> Int32? {
  for index in 0..<self.components.length() {
    if self.components[index].id == id {
      return Some(index)
    }
  }
  None
}

///|
fn HeaderParser::record_marker(
  self : HeaderParser,
  code : Int32,
  offset : Int64,
  length : Int32,
  scan_index : Int32,
  detail : Int32,
) -> Unit {
  self.markers.push({ code, offset, length, scan_index, detail })
}

///|
fn HeaderParser::begin_inter_scan(
  self : HeaderParser,
  marker_offset : Int64,
) -> Unit {
  self.phase = MarkerCode
  self.marker_offset = marker_offset
  self.marker = 0
  self.length = 0
  self.index = 0
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
  let parsed : Array[ComponentSpec] = []
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
      guard id != parsed[earlier].id else {
        raise InvalidData("duplicate SOF55 component identifier")
      }
    }
    parsed.push({ id, h_sampling: h, v_sampling: v, })
  }
  let height = self.word(1)
  let width = self.word(3)
  guard width != 0 && height != 0 else {
    raise UnsupportedFeature("deferred or extended dimensions")
  }
  validate_frame_dimensions(
    { width, height, bits, components: parsed, },
    self.limits,
  )
  self.width = width
  self.height = height
  self.bits = bits
  for comp in parsed {
    self.components.push(comp)
    self.seen_components.push(false)
  }
  self.sof_offset = self.marker_offset
  self.sof_length = self.length + 4
  self.record_marker(0xF7, self.marker_offset, self.length + 4, -1, count)
}

///|
fn HeaderParser::preset_segment(self : HeaderParser) -> Unit raise CodecError {
  match self.at(0) {
    1 => {
      guard self.length == 11 else { raise InvalidData("LSE preset length") }
      // An ID=1 segment replaces the raw values, including zeros, preserving default semantics across scans.
      for index in 0..<5 {
        self.preset[index] = self.word(1 + 2 * index)
      }
      let scan_hint = if self.bits == 0 { -1 } else { self.scan_count }
      self.record_marker(0xF8, self.marker_offset, self.length + 4, scan_hint, 1)
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
  entropy_offset : Int64,
) -> (Frame, Parameters, ScanInfo) raise CodecError {
  guard self.bits > 0 else { raise InvalidData("SOS precedes SOF55") }
  let count = self.at(0)
  guard count > 0 && count <= 4 && self.length == 4 + 2 * count else {
    raise InvalidData("SOS length or component count")
  }
  let mut any_mapping = false
  let selected : Array[Int32] = []
  let comp_ids : Array[Int32] = []
  for i in 0..<count {
    let cs = self.at(1 + 2 * i)
    let tm = self.at(2 + 2 * i)
    self.last_component_id = cs
    guard self.find_component(cs) is Some(comp_idx) else {
      raise InvalidData("SOS component selector")
    }
    for earlier in selected {
      guard comp_idx != earlier else {
        raise InvalidData("duplicate component selector in SOS")
      }
    }
    selected.push(comp_idx)
    comp_ids.push(cs)
    if tm != 0 {
      any_mapping = true
    }
  }
  let tail = 1 + 2 * count
  let near = self.at(tail)
  let ilv = self.at(tail + 1)
  let transform = self.at(tail + 2)
  guard ilv >= 0 &&
    ilv <= 2 &&
    ((count == 1 && ilv == 0) || (count > 1 && ilv > 0)) &&
    transform >> 4 == 0 else {
    raise InvalidData("SOS scan parameters")
  }
  guard transform == 0 || !any_mapping else {
    raise InvalidData("point transform requires zero mapping selectors")
  }
  if ilv == 2 {
    let frame = self.frame_info()
    let first = selected[0]
    let width = frame.component_width(first)
    let height = frame.component_height(first)
    for i in 1..<selected.length() {
      let ci = selected[i]
      self.last_component_id = comp_ids[i]
      guard ci > selected[i - 1] else {
        raise InvalidData(
          "sample-interleaved components must follow frame order",
        )
      }
      guard frame.component_width(ci) == width &&
        frame.component_height(ci) == height else {
        raise InvalidData(
          "sample-interleaved components must have identical dimensions",
        )
      }
    }
  }
  for comp_idx in selected {
    guard !self.seen_components[comp_idx] else {
      self.last_component_id = self.components[comp_idx].id
      raise InvalidData("duplicate scan for component")
    }
  }
  let comp_idx = selected[0]
  let comp_id = comp_ids[0]
  self.last_component_id = comp_id
  let frame : Frame = {
    width: self.width,
    height: self.height,
    bits: self.bits,
    near,
  }
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
  guard !any_mapping else { raise UnsupportedFeature("mapping selector") }
  let scan_index = self.scan_count
  for ci in selected {
    self.seen_components[ci] = true
  }
  self.scanned_count += count
  self.scan_count += 1
  self.record_marker(
    0xDA,
    self.marker_offset,
    self.length + 4,
    scan_index,
    comp_id,
  )
  let scan_info : ScanInfo = {
    scan_index,
    component_index: comp_idx,
    component_id: comp_id,
    component_indices: selected,
    component_ids: comp_ids,
    near,
    interleave: ilv,
    point_transform: transform,
    preset: effective,
    header_offset: self.marker_offset,
    entropy_offset,
    end_offset: -1L,
    rows_decoded: 0,
    completed: false,
  }
  (frame, Parameters::new(effective, near), scan_info)
}

///|
fn HeaderParser::finish_segment(
  self : HeaderParser,
  stream_pos : Int64,
) -> (Frame, Parameters, ScanInfo)? raise CodecError {
  self.phase = MarkerPrefix
  match self.marker {
    0xF7 => self.frame_segment()
    0xF8 => self.preset_segment()
    0xDA => return Some(self.scan_segment(stream_pos))
    0xDD => {
      let interval = self.word(0)
      let mut nonzero = false
      for index in 0..<self.length {
        nonzero = nonzero || self.at(index) != 0
      }
      guard !nonzero else { raise UnsupportedFeature("restart interval") }
      let scan_hint = if self.bits == 0 { -1 } else { self.scan_count }
      self.record_marker(0xDD, self.marker_offset, self.length + 4, scan_hint, interval)
    }
    code if is_metadata(code) => {
      let scan_hint = if self.bits == 0 { -1 } else { self.scan_count }
      self.record_marker(code, self.marker_offset, self.length + 4, scan_hint, self.length)
    }
    _ => ()
  }
  None
}

///|
fn HeaderParser::accept(
  self : HeaderParser,
  byte : Int32,
  stream_pos : Int64,
) -> (Frame, Parameters, ScanInfo)? raise CodecError {
  match self.phase {
    StartPrefix => {
      guard byte == 0xFF else { raise InvalidData("missing SOI prefix") }
      self.marker_offset = stream_pos - 1L
      self.phase = StartCode
    }
    StartCode => {
      if byte == 0xFF {
        return None
      }
      guard byte == 0xD8 else { raise InvalidData("missing SOI") }
      self.soi_offset = stream_pos - 2L
      self.record_marker(0xD8, self.soi_offset, 2, -1, 0)
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
      self.marker_offset = stream_pos - 2L
      if !is_metadata(byte) {
        match byte {
          0xF7 | 0xF8 | 0xDA | 0xDD => ()
          0xD9 =>
            if self.bits > 0 {
              raise InvalidData("premature EOI: missing frame components")
            } else {
              raise InvalidData("unexpected EOI before frame")
            }
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
        return self.finish_segment(stream_pos)
      }
      self.phase = Payload
    }
    Payload => {
      if !is_metadata(self.marker) && self.index < self.segment.length() {
        self.segment[self.index] = byte.to_byte()
      }
      self.index += 1
      if self.index == self.length {
        return self.finish_segment(stream_pos)
      }
    }
  }
  None
}
