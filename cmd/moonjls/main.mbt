///|
let help : String =
  #|moonjls encode WIDTH HEIGHT BITS NEAR INPUT OUTPUT [raw-le|raw-be] [CHUNK] [--pt N] [--maxval N] [preset flags]
  #|moonjls encode-planar WIDTH HEIGHT BITS COMPONENTS NEAR INPUT OUTPUT [raw-le|raw-be] [CHUNK] [--ilv 0|1|2] [--comp-ids LIST] [--scan-order LIST] [--scan-near LIST] [--scan-pt LIST] [--pt N] [--maxval N] [preset flags]
  #|moonjls encode-pgm NEAR INPUT OUTPUT [CHUNK] [--pt N] [preset flags]
  #|moonjls encode-pgms NEAR OUTPUT [--ilv 0|1|2] [--sampling HxV,...] [--chunk N] [--pt N] [preset flags] IN1 [IN2 ...]
  #|moonjls encode-ppm NEAR INPUT OUTPUT [CHUNK] [--ilv 0|1|2] [--pt N] [preset flags]
  #|moonjls decode INPUT OUTPUT [raw-le|raw-be|raw32-le|raw32-be|pgm|ppm] [CHUNK]
  #|moonjls decode-pgms [--chunk N] INPUT OUT1 [OUT2 ...]
  #|moonjls inspect INPUT [CHUNK] [--json]
  #|moonjls verify INPUT [CHUNK] [--json]
  #|
  #|Use - for stdin or stdout. Files are created without overwriting.
  #|Raw samples use one byte for P<=8, two bytes for P>8 (default raw-le).
  #|raw32-le and raw32-be decode each exact sample into four bytes in delivered row order.
  #|PGM/PPM use header MAXVAL. P6 ILV=0 converts the full image. ILV=1 and ILV=2 stream rows.
  #|PGM sampling factors follow input component order. Frame size is the largest input width and height.
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
fn parse_sampling(arg : String) -> Array[(Int32, Int32)] raise {
  let factors : Array[(Int32, Int32)] = []
  guard arg.length() % 4 == 3 else { raise Usage("expected --sampling HxV,...") }
  for i in 0..<((arg.length() + 1) / 4) {
    let pos = i * 4
    let h = arg.code_unit_at(pos).to_int() - 48
    let v = arg.code_unit_at(pos + 2).to_int() - 48
    guard arg.code_unit_at(pos + 1) == 120 &&
      (pos == 0 || arg.code_unit_at(pos - 1) == 44) &&
      h >= 1 && h <= 4 && v >= 1 && v <= 4 else {
      raise Usage("sampling factors must be 1..4 in HxV,... form")
    }
    factors.push((h, v))
  }
  factors
}

///|
async fn encode_input(
  encoder : @jls.Encoder,
  sink : &@io.BinaryWriter,
  input : FixedArray[Int32],
  output : FixedArray[Byte],
  eof : Bool,
) -> (Int64, Int32) {
  let mut pos = 0
  let mut written = 0L
  let mut peak = 0
  while true {
    let step = encoder.step(input, pos, input.length() - pos, output, eof)
    pos += step.consumed
    if step.produced > 0 {
      let bytes = Bytes::from_array(output[:step.produced])
      sink.write(bytes[:])
      written += step.produced.to_int64()
      peak = peak.max(step.produced)
    }
    match step.status {
      Done => break
      Failed(err) => raise err
      NeedInput if eof => raise @jls.Truncated
      NeedInput => break
      NeedOutput | RowReady => ()
    }
  }
  (written, peak)
}

///|
async fn encode_with_encoder(
  encoder : @jls.Encoder,
  source : Source,
  sink : &@io.BinaryWriter,
  bits : Int32,
  big : Bool,
  chunk : Int32,
  near~ : Int32 = 0,
  pt~ : Int32 = 0,
  source_maxval~ : Int32 = 65535,
) -> Unit {
  let info = encoder.frame_info()
  let first_preset = encoder.preset()
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
      length = source.pnm_samples(samples, storage == 2, big, source_maxval)
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
    near,
  }
  log_line(
    "encoded \{describe(frame, first_preset)} components=\{info.components.length()} scans=\{encoder.scan_count()} input_bytes=\{source.byte_count} output_bytes=\{bytes} core_payload_bytes=\{encoder.workspace_bytes()} host_conversion_buffer_bytes=0 input_high_water=\{source.high_water} output_high_water=\{high_water} pt=\{pt}",
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
  pt : Int32,
  source_maxval~ : Int32 = 65535,
) -> Unit {
  let encoder = @jls.Encoder::new(frame, @jls.Limits::default(), preset~, point_transform=pt)
  encode_with_encoder(encoder, source, sink, frame.bits, big, chunk, near=frame.near, pt~, source_maxval~)
}

///|
async fn encode_ppm_stream(
  source : Source,
  sink : &@io.BinaryWriter,
  frame : @jls.FrameInfo,
  maxval : Int32,
  near : Int32,
  chunk : Int32,
  ilv : Int32,
  pt : Int32,
  preset : @jls.Preset,
) -> Unit {
  let scan_preset = if pt != 0 || maxval == frame.maxval() {
    preset
  } else {
    { ..preset, maxval, }
  }
  let scans : Array[@jls.MultiScanSpec] = if ilv == 0 {
    let list : Array[@jls.MultiScanSpec] = []
    for comp in frame.components {
      list.push({
        component_ids: [comp.id],
        interleave: 0,
        near,
        point_transform: pt,
        preset: scan_preset,
      })
    }
    list
  } else {
    [
      {
        component_ids: [1, 2, 3],
        interleave: ilv,
        near,
        point_transform: pt,
        preset: scan_preset,
      },
    ]
  }
  let encoder = @jls.Encoder::new_scans(
    frame,
    scans,
    @jls.Limits::default(),
  )
  let wide = maxval > 255
  let row_buf = FixedArray::make(frame.width * 3, 0)
  let output = FixedArray::make(chunk, b'\x00')
  let mut bytes = 0L
  let mut high_water = 0
  let mut conv_bytes = 0L
  if ilv != 0 {
    let ilv_row = if ilv == 1 {
      FixedArray::make(frame.width * 3, 0)
    } else {
      row_buf
    }
    conv_bytes = row_buf.length().to_int64() * (if ilv == 1 { 8L } else { 4L })
    for y in 0..<frame.height {
      let got = source.pnm_samples(row_buf, wide, true, maxval)
      guard got == row_buf.length() else { raise Input("truncated PPM raster") }
      if ilv == 1 {
        let g_off = frame.width
        let b_off = frame.width * 2
        for x in 0..<frame.width {
          let idx = x * 3
          ilv_row[x] = row_buf[idx]
          ilv_row[g_off + x] = row_buf[idx + 1]
          ilv_row[b_off + x] = row_buf[idx + 2]
        }
      }
      let is_last = y == frame.height - 1
      if is_last {
        let extra = FixedArray::make(1, 0)
        guard source.samples(extra, wide, true) == 0 && !source.fill() else {
          raise Input("extra bytes after PPM raster")
        }
      }
      let mut at = 0
      while at < ilv_row.length() || is_last {
        let step = encoder.step(
          ilv_row,
          at,
          ilv_row.length() - at,
          output,
          is_last,
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
          NeedInput if !is_last && at == ilv_row.length() => break
          NeedInput if is_last => raise @jls.Truncated
          NeedInput | NeedOutput | RowReady => ()
        }
      }
    }
  } else {
    let total = @jls.checked_total_samples(frame.width, frame.height, 3)
    guard total <= 2_147_483_647L else {
      raise @jls.ResourceLimit("PPM conversion buffer exceeds array index limit")
    }
    let plane_len = frame.width * frame.height
    let planar = FixedArray::make(total.to_int(), 0)
    for y in 0..<frame.height {
      let got = source.pnm_samples(row_buf, wide, true, maxval)
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
    conv_bytes = total * 4L + row_buf.length().to_int64() * 4L
    let mut at = 0
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
  }
  log_line(
    "encoded-ppm width=\{frame.width} height=\{frame.height} bits=\{frame.bits} maxval=\{encoder.preset().maxval} near=\{near} pt=\{pt} ilv=\{ilv} components=3 scans=\{encoder.scan_count()} input_bytes=\{source.byte_count} output_bytes=\{bytes} core_payload_bytes=\{encoder.workspace_bytes()} host_conversion_buffer_bytes=\{conv_bytes} input_high_water=\{source.high_water} output_high_water=\{high_water}",
  )
}

///|
async fn buffer_row(
  sink : &@io.BinaryWriter,
  row : FixedArray[Int32],
  buffer : FixedArray[Byte],
  filled : Int32,
  stride : Int32,
  format : Format,
) -> (Int32, Int32, Int32) {
  let big = match format {
    RawLittle | Raw32Little => false
    RawBig | Raw32Big | Pgm | Ppm => true
  }
  let cap = buffer.length()
  let mut out_len = filled
  let mut position = 0
  let mut high_water = 0
  let row_len = row.length()
  while position < row_len {
    let available = row_len - position
    let per_space = (cap - out_len) / stride
    let count = if available < per_space { available } else { per_space }
    let end = position + count
    if stride == 4 {
      while position < end {
        let sample = row[position]
        for offset in 0..<4 {
          let shift = (if big { 3 - offset } else { offset }) * 8
          buffer[out_len + offset] = ((sample >> shift) & 255).to_byte()
        }
        out_len += 4
        position += 1
      }
    } else if stride == 2 {
      if big {
        while position < end {
          let sample = row[position]
          buffer[out_len] = (sample >> 8).to_byte()
          buffer[out_len + 1] = (sample & 255).to_byte()
          out_len += 2
          position += 1
        }
      } else {
        while position < end {
          let sample = row[position]
          buffer[out_len] = (sample & 255).to_byte()
          buffer[out_len + 1] = (sample >> 8).to_byte()
          out_len += 2
          position += 1
        }
      }
    } else {
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
fn reconstruction_maxval(coded_maxval : Int32, pt : Int32) -> Int32 {
  (coded_maxval << pt).min(65535)
}

///|
fn validate_reconstruction(row : FixedArray[Int32], maxval : Int32, pt : Int32) -> Unit raise {
  if pt != 0 {
    for sample in row {
      guard sample <= maxval else {
        raise @jls.UnsupportedFeature("point transform reconstruction exceeds output sample range")
      }
    }
  }
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
    let cw = st.frame.component_width(i)
    let ch = st.frame.component_height(i)
    comps.write_string(
      "{\"id\":\{c.id},\"h\":\{c.h_sampling},\"v\":\{c.v_sampling},\"width\":\{cw},\"height\":\{ch}}",
    )
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
    let cids = StringBuilder()
    cids.write_char('[')
    for ci in 0..<s.component_ids.length() {
      if ci > 0 {
        cids.write_char(',')
      }
      cids.write_string("\{s.component_ids[ci]}")
    }
    cids.write_char(']')
    let cidxs = StringBuilder()
    cidxs.write_char('[')
    for ci in 0..<s.component_indices.length() {
      if ci > 0 {
        cidxs.write_char(',')
      }
      cidxs.write_string("\{s.component_indices[ci]}")
    }
    cidxs.write_char(']')
    scans.write_string(
      "{\"scanIndex\":\{s.scan_index},\"componentIndex\":\{s.component_index},\"componentId\":\{s.component_id},\"componentIndices\":\{cidxs.to_string()},\"componentIds\":\{cids.to_string()},\"near\":\{s.near},\"interleave\":\{s.interleave},\"pointTransform\":\{s.point_transform},\"preset\":\{preset_json(s.preset)},\"headerOffset\":\{s.header_offset},\"entropyOffset\":\{s.entropy_offset},\"endOffset\":\{s.end_offset},\"rows\":\{s.rows_decoded},\"completed\":\{comp_done}}",
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
  "\"samples\":\{st.frame.total_samples()}," +
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
  let raw32 = format is Raw32Little || format is Raw32Big
  let output = FixedArray::make(chunk.max(if raw32 { 4 } else { 2 }), b'\x00')
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
        if rows == 0 {
          first_row_at = consumed
        }
        if sink is Some(sink) {
          let pt = decoder.current_scan().map(scan => scan.point_transform).unwrap_or(0)
          let output_maxval = reconstruction_maxval(preset.maxval, pt)
          let row = decoder.row()
          let sample_bytes = if raw32 {
            4
          } else {
            let destination_maxval = if format is Pgm || format is Ppm {
              output_maxval
            } else if frame.bits > 8 {
              65535
            } else {
              255
            }
            validate_reconstruction(row, destination_maxval, pt)
            if destination_maxval > 255 { 2 } else { 1 }
          }
          let comp_count = frame_info.components.length()
          if rows == 0 {
            if format is Pgm {
              guard comp_count == 1 else {
                raise Input("PGM P5 output requires a single component; use decode-pgms or ppm")
              }
              let header = @utf8.encode(
                "P5\n\{frame.width} \{frame.height}\n\{output_maxval}\n"[:],
              )
              sink.write(header[:])
              bytes += header.length().to_int64()
            } else if format is Ppm {
              guard comp_count == 3 else {
                raise Input("PPM P6 output requires 3 components")
              }
              for ci in 0..<comp_count {
                guard frame_info.component_width(ci) == frame.width &&
                  frame_info.component_height(ci) == frame.height else {
                  raise Input("PPM requires equal-size components. Use decode-pgms for sampled components")
                }
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
            if output_maxval > ppm_maxval {
              ppm_maxval = output_maxval
            }
            let row_idx = decoder.current_row()
            let ci = decoder.current_component_index()
            let base = ci * ppm_width * ppm_height +
              row_idx * ppm_width
            for x in 0..<ppm_width {
              ppm_planes[base + x] = row[x]
            }
          } else {
            let (count, next_len, peak) = buffer_row(
              sink,
              row,
              output,
              out_len,
              sample_bytes,
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
            let stride = if maxv > 255 { 2 } else { 1 }
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
                sink, inter_row, output, out_len, stride, Ppm,
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
    let sample_storage = if raw32 { " output_sample_bytes=4" } else { "" }
    log_line(
      "\{operation} \{describe(frame, preset)} components=\{frame_info.components.length()} scans=\{st.scans.length()} rows=\{rows} input_bytes=\{consumed} output_bytes=\{bytes} first_row_at=\{first_row_at} core_payload_bytes=\{workspace} host_conversion_buffer_bytes=\{conv_bytes} input_high_water=\{source.high_water} output_high_water=\{high_water}\{sample_storage}",
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
  allow_ilv~ : Bool = false,
) -> (Format, Int32, Int32, Int32, @jls.Preset) raise {
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
  let mut ilv = 0
  let mut pt = 0
  let mut preset = @jls.Preset::defaults()
  let mut seen = 0
  while index < args.length() {
    guard index + 1 < args.length() else { raise Usage("missing preset flag value") }
    let flag = args[index]
    let value = @string.parse_int(args[index + 1][:])
    if allow_ilv && flag == "--ilv" {
      guard (seen & 32) == 0 else { raise Usage("duplicate --ilv flag") }
      guard value >= 0 && value <= 2 else { raise Usage("--ilv must be 0, 1 or 2") }
      seen = seen | 32
      ilv = value
      index += 2
      continue
    }
    if flag == "--pt" {
      guard (seen & 64) == 0 else { raise Usage("duplicate --pt flag") }
      guard value >= 0 && value <= 15 else { raise Usage("--pt must be in 0..15") }
      seen = seen | 64
      pt = value
      index += 2
      continue
    }
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
  (format, chunk, ilv, pt, preset)
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
      let (format, chunk, _, pt, preset) = parse_encode_options(args, 7, false)
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
            pt,
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
      let mut ilv = 0
      let mut preset = @jls.Preset::defaults()
      let mut comp_ids : Array[Int32]? = None
      let mut scan_order : Array[Int32]? = None
      let mut scan_near : Array[Int32]? = None
      let mut scan_pt : Array[Int32]? = None
      let mut default_pt = 0
      let mut seen = 0
      while index < args.length() {
        guard index + 1 < args.length() else { raise Usage("missing flag value") }
        let flag = args[index]
        let raw_val = args[index + 1]
        match flag {
          "--comp-ids" => comp_ids = Some(parse_int_list(raw_val))
          "--scan-order" => scan_order = Some(parse_int_list(raw_val))
          "--scan-near" => scan_near = Some(parse_int_list(raw_val))
          "--scan-pt" => {
            guard scan_pt is None else { raise Usage("duplicate --scan-pt flag") }
            scan_pt = Some(parse_int_list(raw_val))
          }
          "--pt" => {
            guard (seen & 64) == 0 else { raise Usage("duplicate --pt flag") }
            seen = seen | 64
            default_pt = @string.parse_int(raw_val[:])
            guard default_pt >= 0 && default_pt <= 15 else { raise Usage("--pt must be in 0..15") }
          }
          "--ilv" => {
            ilv = @string.parse_int(raw_val[:])
            guard ilv >= 0 && ilv <= 2 else { raise Usage("--ilv must be 0, 1 or 2") }
          }
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
      if ilv == 0 {
        guard nears.length() == comp_count else {
          raise @jls.InvalidArgument("scan NEAR count mismatch")
        }
      } else {
        guard nears.length() == 1 || nears.length() == comp_count else {
          raise @jls.InvalidArgument("interleaved scan requires one shared NEAR")
        }
        for value in nears {
          guard value == nears[0] else {
            raise @jls.InvalidArgument("interleaved scan requires one shared NEAR")
          }
        }
      }
      let transforms = match scan_pt {
        Some(list) => list
        None => Array::make(comp_count, default_pt)
      }
      if ilv == 0 {
        guard transforms.length() == comp_count else {
          raise @jls.InvalidArgument("scan Pt count mismatch")
        }
      } else {
        guard transforms.length() == 1 || transforms.length() == comp_count else {
          raise @jls.InvalidArgument("interleaved scan requires one shared Pt")
        }
        for value in transforms {
          guard value == transforms[0] else {
            raise @jls.InvalidArgument("interleaved scan requires one shared Pt")
          }
        }
      }
      let components : Array[@jls.ComponentSpec] = []
      for id in ids {
        components.push({ id, h_sampling: 1, v_sampling: 1 })
      }
      let frame_info : @jls.FrameInfo = { width, height, bits, components }
      if ilv == 0 {
        let scans : Array[@jls.MultiScanSpec] = []
        for i in 0..<comp_count {
          scans.push({
            component_ids: [order[i]],
            interleave: 0,
            near: nears[i],
            point_transform: transforms[i],
            preset,
          })
        }
        let encoder = @jls.Encoder::new_scans(
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
              near=nears[0],
              pt=transforms[0],
            )
          })
        })
      } else {
        let scans : Array[@jls.MultiScanSpec] = [
          {
            component_ids: order,
            interleave: ilv,
            near: nears[0],
            point_transform: transforms[0],
            preset,
          },
        ]
        let encoder = @jls.Encoder::new_scans(
          frame_info,
          scans,
          @jls.Limits::default(),
        )
        let total = frame_info.total_samples()
        guard total <= 2_147_483_647L else {
          raise @jls.ResourceLimit("planar conversion buffer exceeds array index limit")
        }
        let planar = FixedArray::make(total.to_int(), 0)
        with_reader(input, reader => {
          let src = Source::new(reader, chunk)
          let wide = bits > 8
          let big = format is RawBig
          let got = src.samples(planar, wide, big)
          guard got == planar.length() else { raise Input("truncated raw planes") }
          guard src.samples(FixedArray::make(1, 0), wide, big) == 0 && !src.fill() else {
            raise Input("extra samples after raw planes")
          }
          let reordered = FixedArray::make(planar.length(), 0)
          let plane_len = width * height
          let component_offsets = order.map(cid => {
            frame_info.find_component(cid).unwrap() * plane_len
          })
          let mut dst = 0
          for y in 0..<height {
            let row_off = y * width
            if ilv == 1 {
              for comp_off in component_offsets {
                for x in 0..<width {
                  reordered[dst + x] = planar[comp_off + row_off + x]
                }
                dst += width
              }
            } else {
              for x in 0..<width {
                for comp_off in component_offsets {
                  reordered[dst] = planar[comp_off + row_off + x]
                  dst += 1
                }
              }
            }
          }
          with_writer(output, writer => {
            let out_buf = FixedArray::make(chunk, b'\x00')
            let mut at = 0
            let mut out_bytes = 0L
            let mut high_water = 0
            while true {
              let step = encoder.step(
                reordered,
                at,
                reordered.length() - at,
                out_buf,
                true,
              )
              at += step.consumed
              if step.produced > 0 {
                let written = Bytes::from_array(out_buf[:step.produced])
                writer.write(written[:])
                out_bytes += step.produced.to_int64()
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
            let conv_bytes = total * 8L
            log_line(
              "encoded width=\{width} height=\{height} bits=\{bits} maxval=\{encoder.preset().maxval} near=\{nears[0]} pt=\{transforms[0]} ilv=\{ilv} components=\{comp_count} scans=1 input_bytes=\{src.byte_count} output_bytes=\{out_bytes} core_payload_bytes=\{encoder.workspace_bytes()} host_conversion_buffer_bytes=\{conv_bytes} input_high_water=\{src.high_water} output_high_water=\{high_water}",
            )
          })
        })
      }
    }
    ["encode-pgm", near, input, output, ..] => {
      let near = @string.parse_int(near[:])
      let (_, chunk, _, pt, preset) = parse_encode_options(args, 4, true)
      with_reader(input, reader => {
        let source = Source::new(reader, chunk)
        let (frame, maxval) = read_pgm(source, near)
        let preset = if pt != 0 || maxval == frame.maxval() { preset } else { { ..preset, maxval, } }
        with_writer(output, writer => {
          encode_stream(source, writer, frame, true, chunk, preset, pt, source_maxval=maxval)
        })
      })
    }
    ["encode-ppm", near_s, input, output, ..] => {
      let near = @string.parse_int(near_s[:])
      let (_, chunk, ilv, pt, preset) = parse_encode_options(
        args,
        4,
        true,
        allow_ilv=true,
      )
      with_reader(input, reader => {
        let source = Source::new(reader, chunk)
        let (frame_info, maxval) = read_ppm(source, near)
        with_writer(output, writer => {
          encode_ppm_stream(
            source,
            writer,
            frame_info,
            maxval,
            near,
            chunk,
            ilv,
            pt,
            preset,
          )
        })
      })
    }
    ["encode-pgms", near_s, output, ..] => {
      let near = @string.parse_int(near_s[:])
      let mut index = 3
      let mut chunk = 65536
      let mut ilv = 0
      let mut pt = 0
      let mut preset = @jls.Preset::defaults()
      let mut sampling : Array[(Int32, Int32)]? = None
      let mut seen = 0
      let inputs : Array[String] = []
      while index < args.length() {
        let token = args[index]
        if token.has_prefix("--") {
          guard index + 1 < args.length() else { raise Usage("missing flag value") }
          if token == "--sampling" {
            guard sampling is None else { raise Usage("duplicate --sampling") }
            sampling = Some(parse_sampling(args[index + 1]))
            index += 2
            continue
          }
          let value = @string.parse_int(args[index + 1][:])
          match token {
            "--chunk" => {
              guard value >= 1 && value <= 1048576 else {
                raise Usage("CHUNK must be in 1..1048576")
              }
              chunk = value
            }
            "--ilv" => {
              guard value >= 0 && value <= 2 else { raise Usage("--ilv must be 0, 1 or 2") }
              ilv = value
            }
            "--pt" => {
              guard (seen & 64) == 0 else { raise Usage("duplicate --pt flag") }
              guard value >= 0 && value <= 15 else { raise Usage("--pt must be in 0..15") }
              seen = seen | 64
              pt = value
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
      guard ilv == 0 || (inputs.length() >= 2 && inputs.length() <= 4) else {
        raise Usage("interleaved encoding requires 2..4 input PGM files")
      }
      let factors = match sampling {
        Some(values) => values
        None => Array::make(inputs.length(), (1, 1))
      }
      guard factors.length() == inputs.length() else {
        raise Usage("--sampling factor count must match the number of input PGMs")
      }
      let sources : Array[(String, @jls.Frame, Int32)] = []
      let components : Array[@jls.ComponentSpec] = []
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
        guard f.width > 0 && f.width <= 65535 && f.height > 0 && f.height <= 65535 else {
          raise Input("component PGM dimensions must be in 1..65535")
        }
        width = width.max(f.width)
        height = height.max(f.height)
        if f.bits > max_bits {
          max_bits = f.bits
        }
        sources.push((path, f, mv))
        let (h, v) = factors[i]
        components.push({ id: i + 1, h_sampling: h, v_sampling: v })
      }
      let frame_info : @jls.FrameInfo = { width, height, bits: max_bits, components }
      for i in 0..<sources.length() {
        let (path, f, _) = sources[i]
        let cw = frame_info.component_width(i)
        let ch = frame_info.component_height(i)
        guard f.width == cw && f.height == ch else {
          raise Input("component PGM \{path} is \{f.width}x\{f.height}, expected \{cw}x\{ch} from H/V")
        }
      }
      if ilv == 0 {
        let scans : Array[@jls.MultiScanSpec] = []
        for i in 0..<sources.length() {
          let (_, _, mv) = sources[i]
          let scan_preset = if pt != 0 || mv == frame_info.maxval() {
            preset
          } else {
            { ..preset, maxval: mv }
          }
          scans.push({
            component_ids: [i + 1],
            interleave: 0,
            near,
            point_transform: pt,
            preset: scan_preset,
          })
        }
        let encoder = @jls.Encoder::new_scans(
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
            let (path, geometry, mv) = sources[i]
            let wide = mv > 255
            let row = FixedArray::make(geometry.width, 0)
            let file = @fs.open(path[:], mode=ReadOnly)
            defer file.close()
            let src = Source::new(file, chunk)
            let _ = read_pgm(src, near)
            for _ in 0..<geometry.height {
              guard src.pnm_samples(row, wide, true, mv) == row.length() else {
                raise Input("truncated component PGM")
              }
              let (written, peak) = encode_input(
                encoder, writer, row, out_buf, false,
              )
              total_out += written
              out_peak = out_peak.max(peak)
            }
            guard !src.fill() else { raise Input("extra samples in component PGM") }
            total_in += src.byte_count
            if src.high_water > in_peak {
              in_peak = src.high_water
            }
          }
          let (written, peak) = encode_input(encoder, writer, [], out_buf, true)
          total_out += written
          out_peak = out_peak.max(peak)
          log_line(
            "encoded-pgms width=\{width} height=\{height} bits=\{max_bits} near=\{near} pt=\{pt} ilv=0 components=\{sources.length()} scans=\{sources.length()} input_bytes=\{total_in} output_bytes=\{total_out} core_payload_bytes=\{encoder.workspace_bytes()} host_conversion_buffer_bytes=0 host_row_buffer_bytes=\{width.to_int64() * 4L} input_high_water=\{in_peak} output_high_water=\{out_peak}",
          )
        })
      } else {
        let first_mv = sources[0].2
        if ilv == 2 || sampling is Some(_) {
          for source in sources {
            guard source.2 == first_mv else {
              raise Input("interleaved PGM inputs require the same MAXVAL")
            }
          }
        }
        let scan_preset = if pt != 0 || first_mv == frame_info.maxval() {
          preset
        } else {
          { ..preset, maxval: first_mv }
        }
        let ids : Array[Int32] = Array::makei(sources.length(), i => i + 1)
        let encoder = @jls.Encoder::new_scans(
          frame_info,
          [
            {
              component_ids: ids,
              interleave: ilv,
              near,
              point_transform: pt,
              preset: scan_preset,
            },
          ],
          @jls.Limits::default(),
        )
        with_writer(output, writer => {
          let files : Array[@fs.File?] = Array::make(sources.length(), None)
          let srcs : Array[Source] = []
          let row_bufs : Array[FixedArray[Int32]] = []
          let wides : Array[Bool] = []
          defer {
            for i in 0..<files.length() {
              if files[i] is Some(f) {
                f.close()
                files[i] = None
              }
            }
          }
          for i in 0..<sources.length() {
            let (path, geometry, mv) = sources[i]
            let f = @fs.open(path[:], mode=ReadOnly)
            files[i] = Some(f)
            let s = Source::new(f, chunk)
            let _ = read_pgm(s, near)
            srcs.push(s)
            row_bufs.push(FixedArray::make(geometry.width, 0))
            wides.push(mv > 255)
          }
          let out_buf = FixedArray::make(chunk, b'\x00')
          let mut total_out = 0L
          let mut out_peak = 0
          let packed = if ilv == 2 {
            FixedArray::make(sources[0].1.width * sources.length(), 0)
          } else {
            []
          }
          if ilv == 1 {
            let max_v = frame_info.max_v_sampling()
            let groups = (height + max_v - 1) / max_v
            for mcu in 0..<groups {
              for ci in 0..<sources.length() {
                let row = row_bufs[ci]
                let v = components[ci].v_sampling
                let first = mcu * v
                let last = (first + v).min(sources[ci].1.height)
                for _ in first..<last {
                  guard srcs[ci].pnm_samples(row, wides[ci], true, sources[ci].2) == row.length() else {
                    raise Input("truncated component PGM")
                  }
                  let (written, peak) = encode_input(
                    encoder, writer, row, out_buf, false,
                  )
                  total_out += written
                  out_peak = out_peak.max(peak)
                }
              }
            }
          } else {
            let geometry = sources[0].1
            for _ in 0..<geometry.height {
              for ci in 0..<sources.length() {
                let row = row_bufs[ci]
                guard srcs[ci].pnm_samples(row, wides[ci], true, sources[ci].2) == row.length() else {
                  raise Input("truncated component PGM")
                }
              }
              for x in 0..<geometry.width {
                for ci in 0..<sources.length() {
                  packed[x * sources.length() + ci] = row_bufs[ci][x]
                }
              }
              let (written, peak) = encode_input(
                encoder, writer, packed, out_buf, false,
              )
              total_out += written
              out_peak = out_peak.max(peak)
            }
          }
          for s in srcs {
            guard !s.fill() else { raise Input("extra samples in component PGM") }
          }
          let (written, peak) = encode_input(encoder, writer, [], out_buf, true)
          total_out += written
          out_peak = out_peak.max(peak)
          let mut total_in = 0L
          let mut in_peak = 0
          for s in srcs {
            total_in += s.byte_count
            if s.high_water > in_peak {
              in_peak = s.high_water
            }
          }
          let conv_bytes = packed.length().to_int64() * 4L
          let mut row_bytes = 0L
          for row in row_bufs {
            row_bytes += row.length().to_int64() * 4L
          }
          log_line(
            "encoded-pgms width=\{width} height=\{height} bits=\{max_bits} near=\{near} pt=\{pt} ilv=\{ilv} components=\{sources.length()} scans=1 input_bytes=\{total_in} output_bytes=\{total_out} core_payload_bytes=\{encoder.workspace_bytes()} host_conversion_buffer_bytes=\{conv_bytes} host_row_buffer_bytes=\{row_bytes} input_high_water=\{in_peak} output_high_water=\{out_peak}",
          )
        })
      }
    }
    ["decode", input, output, ..] if args.length() <= 5 => {
      let format = if args.length() > 3 {
        parse_decode_format(args[3])
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
              guard decoder.preset() is Some(preset) else {
                raise Input("missing scan preset")
              }
              guard info.components.length() == out_paths.length() else {
                raise Input("output PGM count must match component count")
              }
              if rows == 0 {
                first_row_at = total_in
              }
              let pt = decoder.current_scan().map(scan => scan.point_transform).unwrap_or(0)
              let output_maxval = reconstruction_maxval(preset.maxval, pt)
              let row = decoder.row()
              validate_reconstruction(row, output_maxval, pt)
              let ci = decoder.current_component_index()
              let cw = info.component_width(ci)
              let ch = info.component_height(ci)
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
                  "P5\n\{cw} \{ch}\n\{output_maxval}\n"[:],
                )
                w.write(hdr[:])
                total_out += hdr.length().to_int64()
              }
              let (cnt, _, peak) = buffer_row(
                w,
                row,
                out_buf,
                0,
                if output_maxval > 255 { 2 } else { 1 },
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
      let category = error.to_string()
      match error {
        Input(message) | Usage(message) | @jls.InvalidData(message) |
        @jls.InvalidArgument(message) | @jls.UnsupportedFeature(message) |
        @jls.ResourceLimit(message) => log_line("\{category}: \{message}")
        _ => log_line(category)
      }
      @env.exit(1)
    }
  }
}
