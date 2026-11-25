///|
let help : String =
  #|moonjls encode WIDTH HEIGHT BITS NEAR INPUT OUTPUT [raw-le|raw-be] [CHUNK]
  #|moonjls encode-pgm NEAR INPUT OUTPUT [CHUNK]
  #|moonjls decode INPUT OUTPUT [raw-le|raw-be|pgm] [CHUNK]
  #|moonjls inspect INPUT [CHUNK] [--json]
  #|moonjls verify INPUT [CHUNK] [--json]
  #|
  #|Use - for stdin or stdout. Files are created without overwriting.
  #|Raw samples use one byte at 8 bits and two bytes at 12/16 bits (default raw-le).
  #|CHUNK sets the byte buffer size (1–1048576, default 65536).
  #|Inspect and verify each read through EOI and reject trailing bytes.
  #|With --json, inspect and verify write successful decoding statistics to stdout.

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
fn describe(frame : @jls.Frame) -> String {
  "width=\{frame.width} height=\{frame.height} bits=\{frame.bits} maxval=\{frame.maxval()} near=\{frame.near}"
}

///|
async fn encode_stream(
  source : Source,
  sink : &@io.BinaryWriter,
  frame : @jls.Frame,
  big : Bool,
  chunk : Int32,
) -> Unit {
  let encoder = @jls.Encoder::new(frame, @jls.Limits::default())
  let storage = if frame.bits == 8 { 1 } else { 2 }
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
  log_line(
    "encoded \{describe(frame)} input_bytes=\{source.byte_count} output_bytes=\{bytes} core_payload_bytes=\{encoder.workspace_bytes()} input_high_water=\{source.high_water} output_high_water=\{high_water}",
  )
}

///|
async fn buffer_row(
  sink : &@io.BinaryWriter,
  row : FixedArray[Int32],
  buffer : FixedArray[Byte],
  filled : Int32,
  frame : @jls.Frame,
  format : Format,
) -> (Int32, Int32, Int32) {
  let wide = frame.bits > 8
  let big = match format {
    RawLittle => false
    RawBig | Pgm => true
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
        if rows == 0 {
          first_row_at = consumed
        }
        if sink is Some(sink) {
          if rows == 0 && format is Pgm {
            let header = @utf8.encode(
              "P5\n\{frame.width} \{frame.height}\n\{frame.maxval()}\n"[:],
            )
            sink.write(header[:])
            bytes += header.length().to_int64()
          }
          let (count, next_len, peak) = buffer_row(
            sink,
            decoder.row(),
            output,
            out_len,
            frame,
            format,
          )
          out_len = next_len
          bytes += count.to_int64()
          if peak > high_water {
            high_water = peak
          }
        }
        rows += 1
      }
      Done => {
        guard position == input.length() && !source.fill() else {
          raise Input("trailing bytes after EOI")
        }
        if sink is Some(sink) && out_len > 0 {
          let written = Bytes::from_array(output[:out_len])
          sink.write(written[:])
          if out_len > high_water {
            high_water = out_len
          }
          out_len = 0
        }
        break
      }
      Failed(error) => raise error
      NeedInput => ()
      NeedOutput => raise Input("unexpected decoder status")
    }
  }
  guard decoder.frame() is Some(frame) else { raise Input("missing frame") }
  let workspace = decoder.workspace_bytes()
  if json {
    let report = "{\"width\":\{frame.width},\"height\":\{frame.height},\"bits\":\{frame.bits}," +
      "\"maxval\":\{frame.maxval()},\"near\":\{frame.near},\"rows\":\{rows}," +
      "\"inputBytes\":\{consumed},\"corePayloadBytes\":\{workspace}," +
      "\"inputPeakBytes\":\{source.high_water},\"firstRowInputConsumed\":\{first_row_at}}\n"
    @stdio.stdout.text.write(report[:])
  } else {
    log_line(
      "\{operation} \{describe(frame)} rows=\{rows} input_bytes=\{consumed} output_bytes=\{bytes} first_row_at=\{first_row_at} core_payload_bytes=\{workspace} input_high_water=\{source.high_water} output_high_water=\{high_water}",
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
async fn dispatch(args : ArrayView[String]) -> Unit {
  match args {
    ["encode", width, height, bits, near, input, output, ..] if args.length() <=
      9 => {
      let frame : @jls.Frame = {
        width: @string.parse_int(width[:]),
        height: @string.parse_int(height[:]),
        bits: @string.parse_int(bits[:]),
        near: @string.parse_int(near[:]),
      }
      let format = if args.length() > 7 {
        parse_format(args[7])
      } else {
        RawLittle
      }
      guard !(format is Pgm) else { raise Usage("use encode-pgm for P5 input") }
      let chunk = parse_chunk(args, 8)
      with_reader(input, reader => {
        with_writer(output, writer => {
          encode_stream(
            Source::new(reader, chunk),
            writer,
            frame,
            format is RawBig,
            chunk,
          )
        })
      })
    }
    ["encode-pgm", near, input, output, ..] if args.length() <= 5 => {
      let near = @string.parse_int(near[:])
      let chunk = parse_chunk(args, 4)
      with_reader(input, reader => {
        let source = Source::new(reader, chunk)
        let frame = read_pgm(source, near)
        with_writer(output, writer => {
          encode_stream(source, writer, frame, true, chunk)
        })
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
