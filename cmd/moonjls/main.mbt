///|
let help : String =
  #|moonjls encode WIDTH HEIGHT BITS NEAR INPUT OUTPUT [raw-le|raw-be] [CHUNK] [--maxval N] [preset flags]
  #|moonjls encode-planar WIDTH HEIGHT BITS COMPONENTS NEAR INPUT OUTPUT [raw-le|raw-be] [CHUNK] [--comp-ids LIST] [--scan-order LIST] [--scan-near LIST] [--maxval N] [preset flags]
  #|moonjls encode-pgm NEAR INPUT OUTPUT [CHUNK] [preset flags]
  #|moonjls encode-pgms NEAR OUTPUT [--chunk N] [preset flags] IN1 [IN2 ...]
  #|moonjls encode-ppm NEAR INPUT OUTPUT [CHUNK] [preset flags]
  #|moonjls decode INPUT OUTPUT [raw-le|raw-be|pgm|ppm] [CHUNK]
  #|moonjls decode-pgms [--chunk N] INPUT OUT1 [OUT2 ...]
  #|moonjls inspect INPUT [CHUNK] [--json]
  #|moonjls verify INPUT [CHUNK] [--json]
  #|
  #|Use - for stdin or stdout. Files are created without overwriting.
  #|Raw samples use one byte for P<=8, two bytes for P>8 (default raw-le).
  #|PGM/PPM use header MAXVAL (P6 RGB uses explicit bounded whole-image conversion).
  #|CHUNK sets the byte buffer size (1–1048576, default 65536).
  #|Inspect and verify each read through EOI and reject trailing bytes.

///|
async fn log_line(message : String) -> Unit {
  @stdio.stderr.text.write("\{message}\n"[:])
}

///|
async fn with_reader(
  path : String,
  action : async (&@io.BinaryReader) -> Unit,
) -> Unit {
  if path == "-" {
    action(@stdio.stdin)
  } else {
    let file = @fs.open(path[:], mode=ReadOnly)
    defer file.close()
    action(file)
  }
}

///|
async fn with_writer(
  path : String,
  action : async (&@io.BinaryWriter) -> Unit,
) -> Unit {
  if path == "-" {
    action(@stdio.stdout)
  } else {
    let file = @fs.open(path[:], mode=WriteOnly, create_mode=CreateNew)
    defer file.close()
    action(file)
  }
}

///|
fn describe(frame : @jls.Frame, preset : @jls.Preset) -> String {
  "width=\{frame.width} height=\{frame.height} bits=\{frame.bits} maxval=\{preset.maxval} near=\{frame.near} t1=\{preset.t1} t2=\{preset.t2} t3=\{preset.t3} reset=\{preset.reset}"
}

///|
fn parse_int_list(arg : String) -> Array[Int32] raise {
  let parts : Array[Int32] = []
  let mut cur = StringBuilder()
  let len = arg.length()
  for i in 0..<len {
    let ch = arg.code_unit_at(i)
    if ch == 44 {
      guard !cur.is_empty() else { raise Usage("empty entry in integer list") }
      parts.push(@string.parse_int(cur.to_string()[:]))
      cur = StringBuilder()
    } else {
      cur.write_char(ch.unsafe_to_char())
    }
  }
  guard !cur.is_empty() else { raise Usage("empty entry in integer list") }
  parts.push(@string.parse_int(cur.to_string()[:]))
  parts
}

///|
async fn encode_with_encoder(
  encoder : @jls.Encoder,
  source : Source,
  sink : &@io.BinaryWriter,
  bits : Int32,
  big : Bool,
  chunk : Int32,
) -> Unit {
  let info = encoder.frame_info()
  let storage = if bits <= 8 { 1 } else { 2 }
  let samples = FixedArray::make(
    if chunk >= storage {
      chunk / storage
    } else {
      1
    },
    0,
  )
  let output = FixedArray::make(chunk, b'\x00')
  let mut position = 0
  let mut length = 0
  let mut eof = false
  let mut bytes = 0L
  let mut high_water = 0
  while true {
    if position == length && !eof {
      length = source.samples(samples, storage == 2, big)
      position = 0
      eof = length < samples.length()
    }
    let step = encoder.step(samples, position, length - position, output, eof)
    position += step.consumed
    if step.produced > 0 {
      let written = Bytes::from_array(output[:step.produced])
      sink.write(written[:])
      bytes += step.produced.to_int64()
      if step.produced > high_water {
        high_water = step.produced
      }
    }
    match step.status {
      Done => break
      Failed(error) => raise error
      NeedInput | NeedOutput | RowReady => ()
    }
  }
  let frame : @jls.Frame = {
    width: info.width,
    height: info.height,
    bits: info.bits,
    near: 0,
  }
  log_line(
    "encoded \{describe(frame, encoder.preset())} components=\{info.components.length()} scans=\{encoder.scan_count()} input_bytes=\{source.byte_count} output_bytes=\{bytes} core_payload_bytes=\{encoder.workspace_bytes()} host_conversion_buffer_bytes=0 input_high_water=\{source.high_water} output_high_water=\{high_water}",
  )
}

///|
async fn encode_stream(
  source : Source,
  sink : &@io.BinaryWriter,
  frame : @jls.Frame,
  big : Bool,
  chunk : Int32,
  preset : @jls.Preset,
) -> Unit {
  let encoder = @jls.Encoder::new(frame, @jls.Limits::default(), preset~)
  encode_with_encoder(encoder, source, sink, frame.bits, big, chunk)
}

///|
async fn encode_ppm_stream(
  source : Source,
  sink : &@io.BinaryWriter,
  frame : @jls.FrameInfo,
  maxval : Int32,
  near : Int32,
  chunk : Int32,
  preset : @jls.Preset,
) -> Unit {
  let scan_preset = if maxval == frame.maxval() {
    preset
  } else {
    { ..preset, maxval, }
  }
  let scans : Array[@jls.ScanSpec] = []
  for comp in frame.components {
    scans.push({ component_id: comp.id, near, preset: scan_preset })
  }
  let encoder = @jls.Encoder::new_multicomponent(
    frame,
    scans,
    @jls.Limits::default(),
  )
  let total = @jls.checked_total_samples(frame.width, frame.height, 3)
  guard total <= 2_147_483_647L else {
    raise @jls.ResourceLimit("PPM conversion buffer exceeds array index limit")
  }
  let plane_len = frame.width * frame.height
  let planar = FixedArray::make(total.to_int(), 0)
  let wide = maxval > 255
  let row_buf = FixedArray::make(frame.width * 3, 0)
  for y in 0..<frame.height {
    let got = source.samples(row_buf, wide, true)
    guard got == row_buf.length() else { raise Input("truncated PPM raster") }
    let row_off = y * frame.width
    for x in 0..<frame.width {
      let idx = x * 3
      planar[row_off + x] = row_buf[idx]
      planar[plane_len + row_off + x] = row_buf[idx + 1]
      planar[2 * plane_len + row_off + x] = row_buf[idx + 2]
    }
  }
  let extra = FixedArray::make(1, 0)
  let extra_read = source.samples(extra, wide, true)
  guard extra_read == 0 && !source.fill() else {
    raise Input("extra bytes after PPM raster")
  }
  let conv_bytes = total * 4L + row_buf.length().to_int64() * 4L
  let output = FixedArray::make(chunk, b'\x00')
  let mut at = 0
  let mut bytes = 0L
  let mut high_water = 0
  while true {
    let step = encoder.step(
      planar,
      at,
      planar.length() - at,
      output,
      true,
    )
    at += step.consumed
    if step.produced > 0 {
      let written = Bytes::from_array(output[:step.produced])
      sink.write(written[:])
      bytes += step.produced.to_int64()
      if step.produced > high_water {
        high_water = step.produced
      }
    }
    match step.status {
      Done => break
      Failed(error) => raise error
      NeedInput => raise @jls.Truncated
      NeedOutput | RowReady => ()
    }
  }
  log_line(
    "encoded-ppm width=\{frame.width} height=\{frame.height} bits=\{frame.bits} maxval=\{maxval} near=\{near} components=3 scans=3 input_bytes=\{source.byte_count} output_bytes=\{bytes} core_payload_bytes=\{encoder.workspace_bytes()} host_conversion_buffer_bytes=\{conv_bytes} input_high_water=\{source.high_water} output_high_water=\{high_water}",
  )
}

///|
async fn buffer_row(
  sink : &@io.BinaryWriter,
  row : FixedArray[Int32],
  buffer : FixedArray[Byte],
  filled : Int32,
  wide : Bool,
  format : Format,
) -> (Int32, Int32, Int32) {
  let big = match format {
    RawLittle => false
    RawBig | Pgm | Ppm => true
  }
  let stride = if wide { 2 } else { 1 }
  let cap = buffer.length()
  let mut out_len = filled
  let mut position = 0
  let mut high_water = 0
  let row_len = row.length()
  while position < row_len {
    let available = row_len - position
    let per_space = (cap - out_len) / stride
    let count = if available < per_space { available } else { per_space }
    if wide {
      if big {
        let end = position + count
        while position < end {
          let sample = row[position]
          buffer[out_len] = (sample >> 8).to_byte()
          buffer[out_len + 1] = (sample & 255).to_byte()
          out_len += 2
          position += 1
        }
      } else {
        let end = position + count
        while position < end {
          let sample = row[position]
          buffer[out_len] = (sample & 255).to_byte()
          buffer[out_len + 1] = (sample >> 8).to_byte()
          out_len += 2
          position += 1
        }
      }
    } else {
      let end = position + count
      while position < end {
        buffer[out_len] = row[position].to_byte()
        out_len += 1
        position += 1
      }
    }
    if cap - out_len < stride {
      let written = Bytes::from_array(buffer[:out_len])
      sink.write(written[:])
      if out_len > high_water {
        high_water = out_len
      }
      out_len = 0
    }
  }
  // RowReady is a delivery boundary. A producer can withhold more input or
  // EOI until it receives this row, so do not retain a partial output block
  // while the decoder waits for another input byte or the host checks EOF.
  if out_len > 0 {
    let written = Bytes::from_array(buffer[:out_len])
    sink.write(written[:])
    if out_len > high_water {
      high_water = out_len
    }
    out_len = 0
  }
  (row_len * stride, out_len, high_water)
}

///|
fn preset_json(p : @jls.Preset) -> String {
  "{\"maxval\":\{p.maxval},\"t1\":\{p.t1},\"t2\":\{p.t2},\"t3\":\{p.t3},\"reset\":\{p.reset}}"
}

///|
fn structure_json(
  st : @jls.StreamStructure,
  frame : @jls.Frame,
  preset : @jls.Preset,
  rows : Int32,
  consumed : Int64,
  workspace : Int32,
  input_peak : Int32,
  first_row_at : Int64,
) -> String {
  let comps = StringBuilder()
  comps.write_char('[')
  for i in 0..<st.frame.components.length() {
    if i > 0 {
      comps.write_char(',')
    }
    let c = st.frame.components[i]
    comps.write_string("{\"id\":\{c.id},\"h\":\{c.h_sampling},\"v\":\{c.v_sampling}}")
  }
  comps.write_char(']')

  let scans = StringBuilder()
  scans.write_char('[')
  for i in 0..<st.scans.length() {
    if i > 0 {
      scans.write_char(',')
    }
    let s = st.scans[i]
    let comp_done = if s.completed { "true" } else { "false" }
    scans.write_string(
      "{\"scanIndex\":\{s.scan_index},\"componentIndex\":\{s.component_index},\"componentId\":\{s.component_id},\"near\":\{s.near},\"interleave\":\{s.interleave},\"pointTransform\":\{s.point_transform},\"preset\":\{preset_json(s.preset)},\"headerOffset\":\{s.header_offset},\"entropyOffset\":\{s.entropy_offset},\"endOffset\":\{s.end_offset},\"rows\":\{s.rows_decoded},\"completed\":\{comp_done}}",
    )
  }
  scans.write_char(']')

  let markers = StringBuilder()
  markers.write_char('[')
  for i in 0..<st.markers.length() {
    if i > 0 {
      markers.write_char(',')
    }
    let m = st.markers[i]
    markers.write_string(
      "{\"code\":\{m.code},\"offset\":\{m.offset},\"length\":\{m.length},\"scanIndex\":\{m.scan_index},\"detail\":\{m.detail}}",
    )
  }
  markers.write_char(']')

  let first_near = if st.scans.length() > 0 { st.scans[0].near } else { frame.near }
  let first_preset = if st.scans.length() > 0 { st.scans[0].preset } else { preset }
  let ilv = if st.scans.length() > 0 { st.scans[0].interleave } else { 0 }
  let pt = if st.scans.length() > 0 { st.scans[0].point_transform } else { 0 }
  "{\"width\":\{st.frame.width},\"height\":\{st.frame.height},\"bits\":\{st.frame.bits}," +
  "\"maxval\":\{first_preset.maxval},\"near\":\{first_near},\"rows\":\{rows}," +
  "\"componentCount\":\{st.frame.components.length()},\"components\":\{comps.to_string()}," +
  "\"scanCount\":\{st.scans.length()},\"interleave\":\{ilv},\"pointTransform\":\{pt}," +
  "\"soiOffset\":\{st.soi_offset},\"sofOffset\":\{st.sof_offset},\"sofLength\":\{st.sof_length},\"eoiOffset\":\{st.eoi_offset}," +
  "\"scans\":\{scans.to_string()},\"markers\":\{markers.to_string()}," +
  "\"preset\":\{preset_json(first_preset)}," +
  "\"inputBytes\":\{consumed},\"corePayloadBytes\":\{workspace}," +
  "\"inputPeakBytes\":\{input_peak},\"firstRowInputConsumed\":\{first_row_at}}\n"
}

///|
async fn decode_stream(
  source : Source,
  sink : &@io.BinaryWriter?,
  format : Format,
  chunk : Int32,
  operation : String,
  json~ : Bool = false,
) -> Unit {
  let decoder = @jls.Decoder::new(@jls.Limits::default())
  let output = FixedArray::make(if chunk < 2 { 2 } else { chunk }, b'\x00')
  let mut out_len = 0
  let mut rows = 0
  let mut bytes = 0L
  let mut consumed = 0L
  let mut first_row_at = 0L
  let mut high_water = 0
  let mut conv_bytes = 0L
  let mut ppm_planes : FixedArray[Int32] = []
  let mut ppm_maxval = 0
  let mut ppm_width = 0
  let mut ppm_height = 0
  let mut input = b""
  let mut position = 0
  let mut eof = false
  let mut can_refill = true
  while true {
    // A row event may leave enough entropy state inside the decoder to emit
    // another row without reading from the source. Refill only after the
    // decoder explicitly reports NeedInput.
    if position == input.length() && !eof && can_refill {
      eof = !source.fill()
      input = Bytes::from_array(source.buffer[:source.length])
      source.position = source.length
      position = 0
    }
    let step = decoder.step(input, position, input.length() - position, eof)
    position += step.consumed
    consumed += step.consumed.to_int64()
    can_refill = step.status is NeedInput
    match step.status {
      RowReady => {
        guard decoder.frame() is Some(frame) else {
          raise Input("missing frame")
        }
        guard decoder.frame_info() is Some(frame_info) else {
          raise Input("missing frame info")
        }
        guard decoder.preset() is Some(preset) else {
          raise Input("missing scan parameters")
        }
        guard decoder.current_scan() is Some(scan_info) else {
          raise Input("missing scan info")
        }
        if rows == 0 {
          first_row_at = consumed
        }
        if sink is Some(sink) {
          let comp_count = frame_info.components.length()
          if rows == 0 {
            if format is Pgm {
              guard comp_count == 1 else {
                raise Input("PGM P5 output requires a single component; use decode-pgms or ppm")
              }
              let header = @utf8.encode(
                "P5\n\{frame.width} \{frame.height}\n\{preset.maxval}\n"[:],
              )
              sink.write(header[:])
              bytes += header.length().to_int64()
            } else if format is Ppm {
              guard comp_count == 3 else {
                raise Input("PPM P6 output requires 3 components")
              }
              let total = @jls.checked_total_samples(frame.width, frame.height, 3)
              guard total <= 2_147_483_647L else {
                raise @jls.ResourceLimit("PPM conversion buffer exceeds array index limit")
              }
              ppm_planes = FixedArray::make(total.to_int(), 0)
              conv_bytes = total * 4L
              ppm_width = frame.width
              ppm_height = frame.height
            }
          }
          if format is Ppm {
            if preset.maxval > ppm_maxval {
              ppm_maxval = preset.maxval
            }
            let row = decoder.row()
            let row_idx = decoder.current_row()
            let base = scan_info.component_index * ppm_width * ppm_height +
              row_idx * ppm_width
            for x in 0..<ppm_width {
              ppm_planes[base + x] = row[x]
            }
          } else {
            let (count, next_len, peak) = buffer_row(
              sink,
              decoder.row(),
              output,
              out_len,
              if format is Pgm { preset.maxval > 255 } else { frame.bits > 8 },
              format,
            )
            out_len = next_len
            bytes += count.to_int64()
            if peak > high_water {
              high_water = peak
            }
          }
        }
        rows += 1
      }
      Done => {
        guard position == input.length() && !source.fill() else {
          raise Input("trailing bytes after EOI")
        }
        if sink is Some(sink) {
          if format is Ppm {
            let maxv = if ppm_maxval > 0 { ppm_maxval } else { 255 }
            let header = @utf8.encode(
              "P6\n\{ppm_width} \{ppm_height}\n\{maxv}\n"[:],
            )
            sink.write(header[:])
            bytes += header.length().to_int64()
            let wide = maxv > 255
            let plane_len = ppm_width * ppm_height
            let inter_row = FixedArray::make(ppm_width * 3, 0)
            conv_bytes += inter_row.length().to_int64() * 4L
            for y in 0..<ppm_height {
              let row_off = y * ppm_width
              for x in 0..<ppm_width {
                let idx = x * 3
                inter_row[idx] = ppm_planes[row_off + x]
                inter_row[idx + 1] = ppm_planes[plane_len + row_off + x]
                inter_row[idx + 2] = ppm_planes[2 * plane_len + row_off + x]
              }
              let (count, next_len, peak) = buffer_row(
                sink, inter_row, output, out_len, wide, Ppm,
              )
              out_len = next_len
              bytes += count.to_int64()
              if peak > high_water {
                high_water = peak
              }
            }
          }
          if out_len > 0 {
            let written = Bytes::from_array(output[:out_len])
            sink.write(written[:])
            if out_len > high_water {
              high_water = out_len
            }
            out_len = 0
          }
        }
        break
      }
      Failed(error) => raise error
      NeedInput => ()
      NeedOutput => raise Input("unexpected decoder status")
    }
  }
  guard decoder.frame() is Some(frame) else { raise Input("missing frame") }
  guard decoder.frame_info() is Some(frame_info) else { raise Input("missing frame info") }
  guard decoder.preset() is Some(preset) else { raise Input("missing scan parameters") }
  guard decoder.structure() is Some(st) else { raise Input("missing stream structure") }
  let workspace = decoder.workspace_bytes()
  if json {
    let report = structure_json(
      st, frame, preset, rows, consumed, workspace, source.high_water, first_row_at,
    )
    @stdio.stdout.text.write(report[:])
  } else {
    log_line(
      "\{operation} \{describe(frame, preset)} components=\{frame_info.components.length()} scans=\{st.scans.length()} rows=\{rows} input_bytes=\{consumed} output_bytes=\{bytes} first_row_at=\{first_row_at} core_payload_bytes=\{workspace} host_conversion_buffer_bytes=\{conv_bytes} input_high_water=\{source.high_water} output_high_water=\{high_water}",
    )
  }
}

///|
fn parse_chunk(args : ArrayView[String], index : Int32) -> Int32 raise {
  if index >= args.length() {
    return 65536
  }
  let chunk = @string.parse_int(args[index][:])
  guard chunk >= 1 && chunk <= 1048576 else {
    raise Usage("CHUNK must be in 1..1048576")
  }
  chunk
}

///|
fn parse_encode_options(
  args : ArrayView[String],
  start : Int32,
  pgm : Bool,
) -> (Format, Int32, @jls.Preset) raise {
  let mut index = start
  let mut format = RawLittle
  if !pgm && index < args.length() && !args[index].has_prefix("--") {
    format = parse_format(args[index])
    index += 1
    guard !(format is Pgm) else { raise Usage("use encode-pgm for P5 input") }
  }
  let mut chunk = 65536
  if index < args.length() && !args[index].has_prefix("--") {
    chunk = parse_chunk(args, index)
    index += 1
  }
  let mut preset = @jls.Preset::defaults()
  let mut seen = 0
  while index < args.length() {
    guard index + 1 < args.length() else { raise Usage("missing preset flag value") }
    let flag = args[index]
    let value = @string.parse_int(args[index + 1][:])
    guard value >= 0 && value <= 65535 else {
      raise @jls.InvalidArgument("preset flag is outside 0..65535")
    }
    let (bit, next) = match flag {
      "--maxval" if !pgm && value > 0 => (1, { ..preset, maxval: value })
      "--t1" => (2, { ..preset, t1: value })
      "--t2" => (4, { ..preset, t2: value })
      "--t3" => (8, { ..preset, t3: value })
      "--reset" => (16, { ..preset, reset: value })
      _ => raise Usage("invalid preset flag or MAXVAL")
    }
    guard (seen & bit) == 0 else { raise Usage("duplicate preset flag") }
    seen = seen | bit
    preset = next
    index += 2
  }
  (format, chunk, preset)
}

///|
async fn dispatch(args : ArrayView[String]) -> Unit {
  match args {
    ["encode", width, height, bits, near, input, output, ..] => {
      let frame : @jls.Frame = {
        width: @string.parse_int(width[:]),
        height: @string.parse_int(height[:]),
        bits: @string.parse_int(bits[:]),
        near: @string.parse_int(near[:]),
      }
      let (format, chunk, preset) = parse_encode_options(args, 7, false)
      guard !(format is Ppm) else { raise Usage("use encode-ppm for P6 input") }
      with_reader(input, reader => {
        with_writer(output, writer => {
          encode_stream(
            Source::new(reader, chunk),
            writer,
            frame,
            format is RawBig,
            chunk,
            preset,
          )
        })
      })
    }
    ["encode-planar", w_s, h_s, b_s, c_s, n_s, input, output, ..] => {
      let width = @string.parse_int(w_s[:])
      let height = @string.parse_int(h_s[:])
      let bits = @string.parse_int(b_s[:])
      let comp_count = @string.parse_int(c_s[:])
      let default_near = @string.parse_int(n_s[:])
      let mut index = 8
      let mut format = RawLittle
      if index < args.length() && !args[index].has_prefix("--") {
        format = parse_format(args[index])
        index += 1
        guard format is RawLittle || format is RawBig else {
          raise Usage("encode-planar requires raw-le or raw-be")
        }
      }
      let mut chunk = 65536
      if index < args.length() && !args[index].has_prefix("--") {
        chunk = parse_chunk(args, index)
        index += 1
      }
      let mut preset = @jls.Preset::defaults()
      let mut comp_ids : Array[Int32]? = None
      let mut scan_order : Array[Int32]? = None
      let mut scan_near : Array[Int32]? = None
      let mut seen = 0
      while index < args.length() {
        guard index + 1 < args.length() else { raise Usage("missing flag value") }
        let flag = args[index]
        let raw_val = args[index + 1]
        match flag {
          "--comp-ids" => comp_ids = Some(parse_int_list(raw_val))
          "--scan-order" => scan_order = Some(parse_int_list(raw_val))
          "--scan-near" => scan_near = Some(parse_int_list(raw_val))
          _ => {
            let value = @string.parse_int(raw_val[:])
            guard value >= 0 && value <= 65535 else {
              raise @jls.InvalidArgument("preset flag is outside 0..65535")
            }
            let (bit, next) = match flag {
              "--maxval" if value > 0 => (1, { ..preset, maxval: value })
              "--t1" => (2, { ..preset, t1: value })
              "--t2" => (4, { ..preset, t2: value })
              "--t3" => (8, { ..preset, t3: value })
              "--reset" => (16, { ..preset, reset: value })
              _ => raise Usage("invalid option for encode-planar")
            }
            guard (seen & bit) == 0 else { raise Usage("duplicate preset flag") }
            seen = seen | bit
            preset = next
          }
        }
        index += 2
      }
      let ids = match comp_ids {
        Some(list) => list
        None => Array::makei(comp_count, i => i + 1)
      }
      guard ids.length() == comp_count else {
        raise @jls.InvalidArgument("component IDs count mismatch")
      }
      let order = match scan_order {
        Some(list) => list
        None => ids
      }
      guard order.length() == comp_count else {
        raise @jls.InvalidArgument("scan order count mismatch")
      }
      let nears = match scan_near {
        Some(list) => list
        None => Array::make(comp_count, default_near)
      }
      guard nears.length() == comp_count else {
        raise @jls.InvalidArgument("scan NEAR count mismatch")
      }
      let components : Array[@jls.ComponentSpec] = []
      for id in ids {
        components.push({ id, h_sampling: 1, v_sampling: 1 })
      }
      let scans : Array[@jls.ScanSpec] = []
      for i in 0..<comp_count {
        scans.push({ component_id: order[i], near: nears[i], preset })
      }
      let frame_info : @jls.FrameInfo = { width, height, bits, components }
      let encoder = @jls.Encoder::new_multicomponent(
        frame_info,
        scans,
        @jls.Limits::default(),
      )
      with_reader(input, reader => {
        with_writer(output, writer => {
          encode_with_encoder(
            encoder,
            Source::new(reader, chunk),
            writer,
            bits,
            format is RawBig,
            chunk,
          )
        })
      })
    }
    ["encode-pgm", near, input, output, ..] => {
      let near = @string.parse_int(near[:])
      let (_, chunk, preset) = parse_encode_options(args, 4, true)
      with_reader(input, reader => {
        let source = Source::new(reader, chunk)
        let (frame, maxval) = read_pgm(source, near)
        let preset = if maxval == frame.maxval() { preset } else { { ..preset, maxval, } }
        with_writer(output, writer => {
          encode_stream(source, writer, frame, true, chunk, preset)
        })
      })
    }
    ["encode-ppm", near_s, input, output, ..] => {
      let near = @string.parse_int(near_s[:])
      let (_, chunk, preset) = parse_encode_options(args, 4, true)
      with_reader(input, reader => {
        let source = Source::new(reader, chunk)
        let (frame_info, maxval) = read_ppm(source, near)
        with_writer(output, writer => {
          encode_ppm_stream(source, writer, frame_info, maxval, near, chunk, preset)
        })
      })
    }
    ["encode-pgms", near_s, output, ..] => {
      let near = @string.parse_int(near_s[:])
      let mut index = 3
      let mut chunk = 65536
      let mut preset = @jls.Preset::defaults()
      let mut seen = 0
      let inputs : Array[String] = []
      while index < args.length() {
        let token = args[index]
        if token.has_prefix("--") {
          guard index + 1 < args.length() else { raise Usage("missing flag value") }
          let value = @string.parse_int(args[index + 1][:])
          match token {
            "--chunk" => {
              guard value >= 1 && value <= 1048576 else {
                raise Usage("CHUNK must be in 1..1048576")
              }
              chunk = value
            }
            "--t1" => {
              guard (seen & 2) == 0 else { raise Usage("duplicate preset flag") }
              seen = seen | 2
              preset = { ..preset, t1: value }
            }
            "--t2" => {
              guard (seen & 4) == 0 else { raise Usage("duplicate preset flag") }
              seen = seen | 4
              preset = { ..preset, t2: value }
            }
            "--t3" => {
              guard (seen & 8) == 0 else { raise Usage("duplicate preset flag") }
              seen = seen | 8
              preset = { ..preset, t3: value }
            }
            "--reset" => {
              guard (seen & 16) == 0 else { raise Usage("duplicate preset flag") }
              seen = seen | 16
              preset = { ..preset, reset: value }
            }
            _ => raise Usage("invalid option for encode-pgms")
          }
          index += 2
        } else {
          inputs.push(token)
          index += 1
        }
      }
      guard inputs.length() >= 1 && inputs.length() <= 255 else {
        raise Usage("encode-pgms requires 1..255 input PGM files")
      }
      // Read headers and stream each plane into Encoder::new_multicomponent
      let sources : Array[(String, @jls.Frame, Int32)] = []
      let components : Array[@jls.ComponentSpec] = []
      let scans : Array[@jls.ScanSpec] = []
      let mut width = 0
      let mut height = 0
      let mut max_bits = 2
      for i in 0..<inputs.length() {
        let path = inputs[i]
        let file = @fs.open(path[:], mode=ReadOnly)
        let (f, mv) = {
          defer file.close()
          let s = Source::new(file, 4096)
          read_pgm(s, near)
        }
        if i == 0 {
          width = f.width
          height = f.height
        } else {
          guard f.width == width && f.height == height else {
            raise Input("component PGM dimensions do not match")
          }
        }
        if f.bits > max_bits {
          max_bits = f.bits
        }
        sources.push((path, f, mv))
        components.push({ id: i + 1, h_sampling: 1, v_sampling: 1 })
      }
      let frame_info : @jls.FrameInfo = { width, height, bits: max_bits, components }
      for i in 0..<sources.length() {
        let (_, _, mv) = sources[i]
        let scan_preset = if mv == frame_info.maxval() {
          preset
        } else {
          { ..preset, maxval: mv }
        }
        scans.push({ component_id: i + 1, near, preset: scan_preset })
      }
      let encoder = @jls.Encoder::new_multicomponent(
        frame_info,
        scans,
        @jls.Limits::default(),
      )
      with_writer(output, writer => {
        let out_buf = FixedArray::make(chunk, b'\x00')
        let mut total_out = 0L
        let mut total_in = 0L
        let mut in_peak = 0
        let mut out_peak = 0
        for i in 0..<sources.length() {
          let (path, f, mv) = sources[i]
          let wide = mv > 255
          let storage = if wide { 2 } else { 1 }
          let samples = FixedArray::make(
            if chunk >= storage { chunk / storage } else { 1 },
            0,
          )
          let file = @fs.open(path[:], mode=ReadOnly)
          defer file.close()
          let src = Source::new(file, chunk)
          let _ = read_pgm(src, near)
          let mut pos = 0
          let mut len = 0
          let mut file_eof = false
          let is_last = i == sources.length() - 1
          let target_scan = i
          let mut remaining_plane = width * height
          while encoder.scan_index() == target_scan {
            if pos == len && !file_eof && remaining_plane > 0 {
              len = src.samples(samples, wide, true)
              pos = 0
              file_eof = len < samples.length()
              if len > remaining_plane {
                raise Input("extra samples in component PGM")
              }
              remaining_plane -= len
            }
            let eof_flag = is_last && file_eof && remaining_plane == 0
            let step = encoder.step(
              samples,
              pos,
              len - pos,
              out_buf,
              eof_flag,
            )
            pos += step.consumed
            if step.produced > 0 {
              let written = Bytes::from_array(out_buf[:step.produced])
              writer.write(written[:])
              total_out += step.produced.to_int64()
              if step.produced > out_peak {
                out_peak = step.produced
              }
            }
            match step.status {
              Done => break
              Failed(err) => raise err
              NeedInput if remaining_plane == 0 && pos == len && !is_last => {
                // Ensure zero extra samples at end of non-final PGM
                if src.samples(FixedArray::make(1, 0), wide, true) != 0 ||
                  src.fill() {
                  raise Input("extra samples in component PGM")
                }
              }
              NeedInput if file_eof && remaining_plane > 0 =>
                raise Input("truncated component PGM")
              NeedInput | NeedOutput | RowReady => ()
            }
          }
          total_in += src.byte_count
          if src.high_water > in_peak {
            in_peak = src.high_water
          }
          ignore(f)
        }
        log_line(
          "encoded-pgms width=\{width} height=\{height} bits=\{max_bits} near=\{near} components=\{sources.length()} scans=\{sources.length()} input_bytes=\{total_in} output_bytes=\{total_out} core_payload_bytes=\{encoder.workspace_bytes()} host_conversion_buffer_bytes=0 input_high_water=\{in_peak} output_high_water=\{out_peak}",
        )
      })
    }
    ["decode", input, output, ..] if args.length() <= 5 => {
      let format = if args.length() > 3 {
        parse_format(args[3])
      } else {
        RawLittle
      }
      let chunk = parse_chunk(args, 4)
      with_reader(input, reader => {
        with_writer(output, writer => {
          decode_stream(
            Source::new(reader, chunk),
            Some(writer),
            format,
            chunk,
            "decoded",
          )
        })
      })
    }
    ["decode-pgms", ..] => {
      let mut index = 1
      let mut chunk = 65536
      let positional : Array[String] = []
      while index < args.length() {
        let token = args[index]
        if token == "--chunk" {
          guard index + 1 < args.length() else { raise Usage("missing --chunk value") }
          chunk = parse_chunk(args, index + 1)
          index += 2
        } else {
          positional.push(token)
          index += 1
        }
      }
      guard positional.length() >= 2 else {
        raise Usage("decode-pgms requires INPUT and OUT1 [OUT2 ...]")
      }
      let input_path = positional[0]
      let out_paths : Array[String] = []
      for i in 1..<positional.length() {
        out_paths.push(positional[i])
      }
      with_reader(input_path, reader => {
        let source = Source::new(reader, chunk)
        let decoder = @jls.Decoder::new(@jls.Limits::default())
        let out_buf = FixedArray::make(if chunk < 2 { 2 } else { chunk }, b'\x00')
        let writers : Array[@fs.File?] = Array::make(out_paths.length(), None)
        defer {
          for i in 0..<writers.length() {
            if writers[i] is Some(f) {
              f.close()
              writers[i] = None
            }
          }
        }
        let wrote_hdr = Array::make(out_paths.length(), false)
        let mut input = b""
        let mut pos = 0
        let mut eof = false
        let mut can_refill = true
        let mut total_in = 0L
        let mut total_out = 0L
        let mut rows = 0
        let mut first_row_at = 0L
        let mut high_water = 0
        while true {
          if pos == input.length() && !eof && can_refill {
            eof = !source.fill()
            input = Bytes::from_array(source.buffer[:source.length])
            source.position = source.length
            pos = 0
          }
          let step = decoder.step(input, pos, input.length() - pos, eof)
          pos += step.consumed
          total_in += step.consumed.to_int64()
          can_refill = step.status is NeedInput
          match step.status {
            RowReady => {
              guard decoder.frame_info() is Some(info) else {
                raise Input("missing frame info")
              }
              guard decoder.current_scan() is Some(scan_info) else {
                raise Input("missing scan info")
              }
              guard info.components.length() == out_paths.length() else {
                raise Input("output PGM count must match component count")
              }
              if rows == 0 {
                first_row_at = total_in
              }
              let ci = scan_info.component_index
              let w = match writers[ci] {
                Some(file) => file
                None => {
                  let f = @fs.open(
                    out_paths[ci][:],
                    mode=WriteOnly,
                    create_mode=CreateNew,
                  )
                  writers[ci] = Some(f)
                  f
                }
              }
              if !wrote_hdr[ci] {
                wrote_hdr[ci] = true
                let hdr = @utf8.encode(
                  "P5\n\{info.width} \{info.height}\n\{scan_info.preset.maxval}\n"[:],
                )
                w.write(hdr[:])
                total_out += hdr.length().to_int64()
              }
              let (cnt, _, peak) = buffer_row(
                w,
                decoder.row(),
                out_buf,
                0,
                scan_info.preset.maxval > 255,
                Pgm,
              )
              total_out += cnt.to_int64()
              if peak > high_water {
                high_water = peak
              }
              rows += 1
            }
            Done => {
              guard pos == input.length() && !source.fill() else {
                raise Input("trailing bytes after EOI")
              }
              break
            }
            Failed(err) => raise err
            NeedInput => ()
            NeedOutput => raise Input("unexpected decoder status")
          }
        }
        guard decoder.frame() is Some(frame) else { raise Input("missing frame") }
        guard decoder.preset() is Some(preset) else { raise Input("missing preset") }
        guard decoder.structure() is Some(st) else { raise Input("missing structure") }
        log_line(
          "decoded-pgms \{describe(frame, preset)} components=\{st.frame.components.length()} scans=\{st.scans.length()} rows=\{rows} input_bytes=\{total_in} output_bytes=\{total_out} first_row_at=\{first_row_at} core_payload_bytes=\{decoder.workspace_bytes()} host_conversion_buffer_bytes=0 input_high_water=\{source.high_water} output_high_water=\{high_water}",
        )
      })
    }
    ["inspect" | "verify" as operation, input, ..] if args.length() <= 4 => {
      let json = args.length() > 2 && args[args.length() - 1] == "--json"
      guard args.length() <= 3 || json else { raise Usage(help) }
      let positional = if json { args[:args.length() - 1] } else { args }
      let chunk = parse_chunk(positional, 2)
      with_reader(input, reader => {
        decode_stream(
          Source::new(reader, chunk),
          None,
          RawLittle,
          chunk,
          operation,
          json~,
        )
      })
    }
    ["--help"] | ["-h"] => @stdio.stdout.text.write("\{help}\n"[:])
    _ => raise Usage(help)
  }
}

///|
async fn main {
  let args = @env.args()
  dispatch(args[1:]) catch {
    error => {
      log_line(error.to_string())
      @env.exit(1)
    }
  }
}
