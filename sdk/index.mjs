const states = ['NeedInput', 'NeedOutput', 'RowReady', 'Done'];
const errors = [null, 'InvalidData', 'UnsupportedFeature', 'ResourceLimit', 'Truncated', 'InvalidArgument', 'Cancelled'];
const maximumCapacity = 1024 * 1024;
const usualChunk = 32 * 1024;

export class CodecError extends Error {
  constructor(code, message, progress = undefined) {
    super(message);
    this.name = 'CodecError';
    this.code = code;
    this.progress = progress;
  }
}

function integer(value, label, minimum, maximum = 0x7fffffff) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new CodecError('InvalidArgument', `${label} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

function capacities(options) {
  return {
    inputChunkSize: integer(options.inputChunkSize ?? usualChunk, 'inputChunkSize', 1, maximumCapacity),
    outputChunkSize: integer(options.outputChunkSize ?? usualChunk, 'outputChunkSize', 1, maximumCapacity),
  };
}

function limits(options) {
  const fields = ['maxWidth', 'maxHeight', 'maxPixels', 'maxMetadataBytes'];
  return fields.map((name) => options.limits?.[name] === undefined
    ? -1 : integer(options.limits[name], name, 0));
}

function requestedPreset(frame) {
  const thresholds = frame.preset ?? {};
  if (typeof thresholds !== 'object' || Array.isArray(thresholds)) {
    throw new CodecError('InvalidArgument', 'preset must be an object');
  }
  return [
    integer(frame.maxval ?? 0, 'maxval', 0, 65535),
    ...['t1', 't2', 't3', 'reset'].map((field) => integer(thresholds[field] ?? 0, field, 0, 65535)),
  ];
}

function resolvedFrame(frame, read, port) {
  if (!read) return { frame: Object.freeze({ ...frame }), preset: null };
  const [maxval, t1, t2, t3, reset, custom] = Array.from({ length: 6 }, (_, field) => read(port, frame.near, field));
  const { maxval: _requestedMaxval, preset: _requestedThresholds, ...resolved } = frame;
  if (maxval !== 2 ** frame.bits - 1) resolved.maxval = maxval;
  if (custom) resolved.preset = Object.freeze({ t1, t2, t3, reset });
  return { frame: Object.freeze(resolved), preset: Object.freeze({ maxval, t1, t2, t3, reset }) };
}

async function wasmBytes(url) {
  if (url.protocol === 'file:' && globalThis.process?.versions?.node) {
    return (await import('node:fs/promises')).readFile(url);
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not fetch MoonJLS Wasm GC (${response.status})`);
  return response.arrayBuffer();
}

const WASM_IMPORT_OPTIONS = { builtins: ['js-string'], importedStringConstants: '_' };
const INV_2_32 = 1 / 4294967296;

export async function loadCore({ backend = 'wasm-gc', url, module: compiledModule, bytes } = {}) {
  if (backend !== 'js' && backend !== 'wasm-gc') {
    throw new CodecError('InvalidArgument', `Unknown backend ${backend}`);
  }
  const start = performance.now();
  let bindings;
  if (backend === 'js') {
    const asset = url === undefined ? new URL('./generated/core.mjs', import.meta.url) : new URL(url, import.meta.url);
    bindings = await import(asset.href);
  } else if (compiledModule instanceof WebAssembly.Module) {
    bindings = (await WebAssembly.instantiate(compiledModule, {})).exports;
  } else {
    const raw = bytes ?? await wasmBytes(url === undefined ? new URL('./generated/core.wasm', import.meta.url) : new URL(url, import.meta.url));
    bindings = (await WebAssembly.instantiate(raw, {}, WASM_IMPORT_OPTIONS)).instance.exports;
  }
  return {
    backend,
    loadMs: performance.now() - start,
    createEncoder(frame, options = {}) { return new Session(bindings, frame, options, backend); },
    createDecoder(options = {}) { return new Session(bindings, null, options, backend); },
  };
}

class Session {
  #bindings;
  #backend;
  #port;
  #frame;
  #preset = null;
  #encoding;
  #capacity;
  #outputCapacity;
  #offset = 0;
  #length = 0;
  #eof = false;
  #status = 'NeedInput';

  constructor(bindings, frame, options, backend = 'wasm-gc') {
    this.#bindings = bindings;
    this.#backend = backend;
    this.#encoding = frame !== null;
    this.#frame = frame;
    const { inputChunkSize, outputChunkSize } = capacities(options);
    this.#capacity = inputChunkSize;
    this.#outputCapacity = outputChunkSize;
    const budget = limits(options);
    if (this.#encoding) {
      const frameValues = ['width', 'height', 'bits'].map((key) => integer(frame[key], key, 0));
      const near = integer(frame.near, 'near', 0, 255);
      const preset = requestedPreset(frame);
      const args = [...frameValues, near, inputChunkSize, outputChunkSize, ...budget];
      if (bindings.encoder_new_with_preset) {
        this.#port = bindings.encoder_new_with_preset(...args, ...preset);
      } else {
        if (preset.some(Boolean)) throw new CodecError('UnsupportedFeature', 'Codec artifact does not support custom presets');
        this.#port = bindings.encoder_new(...args);
      }
      const code = bindings.encoder_status(this.#port);
      if (code < 0) throw new CodecError(errors[-code], bindings.encoder_message(this.#port));
      const resolved = resolvedFrame(frame, bindings.encoder_preset, this.#port);
      this.#frame = resolved.frame;
      this.#preset = resolved.preset;
    } else {
      this.#port = bindings.decoder_new(inputChunkSize, ...budget);
    }
  }

  get frame() { return this.#frame; }
  get preset() { return this.#preset; }
  get remaining() { return this.#length - this.#offset; }
  get coreWorkspaceBytes() {
    return this.#encoding
      ? this.#bindings.encoder_workspace(this.#port)
      : this.#bindings.decoder_workspace(this.#port);
  }

  get bridgeBufferBytes() {
    return this.#encoding ? this.#capacity * 4 + this.#outputCapacity : this.#capacity + this.#length;
  }

  stage(input) {
    if (this.#status !== 'NeedInput' || this.remaining !== 0 || this.#eof) {
      throw new CodecError('InvalidArgument', 'The current input must be consumed before staging another chunk');
    }
    const expected = this.#encoding ? Uint16Array : Uint8Array;
    if (input !== null && (!(input instanceof expected) || input.length > this.#capacity)) {
      throw new CodecError('InvalidArgument', `Expected at most ${this.#capacity} ${expected.name} elements`);
    }
    this.#offset = 0;
    this.#length = input?.length ?? 0;
    this.#eof = input === null;
    const bindings = this.#bindings;
    const length = this.#length;
    if (this.#encoding) {
      let i = 0;
      const set8 = bindings.encoder_set8;
      if (set8) {
        const port = this.#port;
        for (; i + 15 < length; i += 16) {
          set8(
            port, i,
            input[i] | (input[i + 1] << 16),
            input[i + 2] | (input[i + 3] << 16),
            input[i + 4] | (input[i + 5] << 16),
            input[i + 6] | (input[i + 7] << 16),
            input[i + 8] | (input[i + 9] << 16),
            input[i + 10] | (input[i + 11] << 16),
            input[i + 12] | (input[i + 13] << 16),
            input[i + 14] | (input[i + 15] << 16),
          );
        }
      }
      const set = bindings.encoder_set;
      for (; i < length; i++) set(this.#port, i, input[i]);
    } else {
      let i = 0;
      const set8 = bindings.decoder_set8;
      if (set8) {
        const port = this.#port;
        for (; i + 31 < length; i += 32) {
          set8(
            port, i,
            input[i] | (input[i + 1] << 8) | (input[i + 2] << 16) | (input[i + 3] << 24),
            input[i + 4] | (input[i + 5] << 8) | (input[i + 6] << 16) | (input[i + 7] << 24),
            input[i + 8] | (input[i + 9] << 8) | (input[i + 10] << 16) | (input[i + 11] << 24),
            input[i + 12] | (input[i + 13] << 8) | (input[i + 14] << 16) | (input[i + 15] << 24),
            input[i + 16] | (input[i + 17] << 8) | (input[i + 18] << 16) | (input[i + 19] << 24),
            input[i + 20] | (input[i + 21] << 8) | (input[i + 22] << 16) | (input[i + 23] << 24),
            input[i + 24] | (input[i + 25] << 8) | (input[i + 26] << 16) | (input[i + 27] << 24),
            input[i + 28] | (input[i + 29] << 8) | (input[i + 30] << 16) | (input[i + 31] << 24),
          );
        }
      }
      const set = bindings.decoder_set;
      for (; i < length; i++) set(this.#port, i, input[i]);
      bindings.decoder_load(this.#port, length);
    }
    this.#status = 'Staged';
  }

  step() {
    const bindings = this.#bindings;
    const port = this.#port;
    const eof = this.#eof ? 1 : 0;
    const code = this.#encoding
      ? bindings.encoder_step(port, this.#offset, this.remaining, eof)
      : bindings.decoder_step(port, this.#offset, this.remaining, eof);
    const consumed = this.#encoding ? bindings.encoder_consumed(port) : bindings.decoder_consumed(port);
    const produced = this.#encoding ? bindings.encoder_produced(port) : 0;
    this.#offset += consumed;
    if (code < 0) {
      this.#status = 'Error';
      const message = this.#encoding ? bindings.encoder_message(port) : bindings.decoder_message(port);
      throw new CodecError(errors[-code], message, { consumed, produced });
    }
    this.#status = states[code];
    if (!this.#encoding && this.#frame === null) {
      const width = bindings.decoder_frame(port, 0);
      if (width !== 0) {
        const resolved = resolvedFrame({
          width, height: bindings.decoder_frame(port, 1),
          bits: bindings.decoder_frame(port, 2), near: bindings.decoder_frame(port, 3),
        }, bindings.decoder_preset, port);
        this.#frame = resolved.frame;
        this.#preset = resolved.preset;
      }
    }
    let chunk;
    if (produced > 0) {
      chunk = new Uint8Array(produced);
      let i = 0;
      if (this.#backend === 'wasm-gc' && bindings.encoder_pack6) {
        const pack6 = bindings.encoder_pack6;
        for (; i + 5 < produced; i += 6) {
          const d = pack6(port, i);
          const lo = d | 0;
          const hi = ((d - (lo >>> 0)) * INV_2_32) | 0;
          chunk[i] = lo & 255;
          chunk[i + 1] = (lo >>> 8) & 255;
          chunk[i + 2] = (lo >>> 16) & 255;
          chunk[i + 3] = lo >>> 24;
          chunk[i + 4] = hi & 255;
          chunk[i + 5] = hi >>> 8;
        }
      } else if (bindings.encoder_word) {
        const word = bindings.encoder_word;
        for (; i + 3 < produced; i += 4) {
          const w = word(port, i);
          chunk[i] = w & 255;
          chunk[i + 1] = (w >>> 8) & 255;
          chunk[i + 2] = (w >>> 16) & 255;
          chunk[i + 3] = w >>> 24;
        }
      }
      const getByte = bindings.encoder_byte;
      for (; i < produced; i++) chunk[i] = getByte(port, i);
    } else if (!this.#encoding && this.#status === 'RowReady') {
      const width = this.#frame.width;
      chunk = new Uint16Array(width);
      let i = 0;
      if (bindings.decoder_pack3) {
        const pack3 = bindings.decoder_pack3;
        for (; i + 2 < width; i += 3) {
          const d = pack3(port, i);
          const lo = d | 0;
          chunk[i] = lo & 0xffff;
          chunk[i + 1] = lo >>> 16;
          chunk[i + 2] = ((d - (lo >>> 0)) * INV_2_32) | 0;
        }
      } else if (bindings.decoder_pair) {
        const pair = bindings.decoder_pair;
        for (; i + 1 < width; i += 2) {
          const p = pair(port, i);
          chunk[i] = p & 0xffff;
          chunk[i + 1] = p >>> 16;
        }
      }
      const getSample = bindings.decoder_sample;
      for (; i < width; i++) chunk[i] = getSample(port, i);
    }
    return { status: this.#status, consumed, produced: chunk?.length ?? 0, chunk };
  }

  cancel() {
    const cancel = this.#encoding ? this.#bindings.encoder_cancel : this.#bindings.decoder_cancel;
    cancel(this.#port);
  }
}

function checkedAbort(signal, session) {
  if (signal?.aborted) {
    session.cancel();
    throw new CodecError('Cancelled', 'Operation cancelled');
  }
}

function interruptible(invoke, signal) {
  if (!signal) return invoke();
  if (signal.aborted) throw new CodecError('Cancelled', 'Operation cancelled');
  const value = invoke();
  if (!value || typeof value.then !== 'function') return value;
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new CodecError('Cancelled', 'Operation cancelled'));
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    Promise.resolve(value).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

async function stream(core, options, encoding) {
  const start = performance.now();
  const session = encoding ? core.createEncoder(options.frame, options) : core.createDecoder(options);
  const { inputChunkSize } = capacities(options);
  const stats = {
    inputUnit: encoding ? 'samples' : 'bytes',
    outputUnit: encoding ? 'bytes' : 'samples',
    inputConsumed: 0, outputProduced: 0, rows: 0,
    coreWorkspaceBytes: 0, bridgeBufferPeakBytes: 0,
    inputQueueBytes: 0, outputQueueBytes: 0, inputPeakBytes: 0, outputPeakBytes: 0,
    firstRowInputConsumed: null, firstRowMs: null, elapsedMs: 0,
  };
  const snapshot = () => ({ ...stats, elapsedMs: performance.now() - start });
  const wait = (callback) => interruptible(callback, options.signal);
  const elementBytes = encoding ? 2 : 1;
  const recordBuffers = () => {
    stats.inputQueueBytes = session.remaining * elementBytes;
    stats.coreWorkspaceBytes = Math.max(stats.coreWorkspaceBytes, session.coreWorkspaceBytes);
    stats.bridgeBufferPeakBytes = Math.max(stats.bridgeBufferPeakBytes, session.bridgeBufferBytes);
  };
  try {
    for (;;) {
      checkedAbort(options.signal, session);
      const next = session.step();
      stats.inputConsumed += next.consumed;
      stats.outputProduced += next.produced;
      recordBuffers();
      stats.outputQueueBytes = next.chunk?.byteLength ?? 0;
      stats.outputPeakBytes = Math.max(stats.outputPeakBytes, stats.outputQueueBytes);
      if (next.status === 'RowReady') {
        if (stats.rows === 0) {
          stats.firstRowInputConsumed = stats.inputConsumed;
          stats.firstRowMs = performance.now() - start;
        }
        stats.rows++;
      }
      if (next.chunk !== undefined) {
        if (encoding) await wait(() => options.onBytes(next.chunk, snapshot(), session.preset));
        else if (options.onRow) await wait(() => options.onRow(next.chunk, stats.rows - 1, session.frame, snapshot(), session.preset));
      }
      checkedAbort(options.signal, session);
      stats.outputQueueBytes = 0;
      if (options.onProgress) await wait(() => options.onProgress(snapshot(), session.frame, session.preset));
      if (next.status === 'Done') {
        if (!encoding && options.trailing !== 'allow') {
          if (session.remaining !== 0) throw new CodecError('TrailingData', 'Unexpected data after EOI');
          let tail;
          do {
            checkedAbort(options.signal, session);
            tail = await wait(() => options.read(1));
          } while (tail !== null && tail.length === 0);
          if (tail !== null) throw new CodecError('TrailingData', 'Unexpected data after EOI');
        }
        return { frame: session.frame, preset: session.preset, stats: snapshot() };
      }
      if (next.status === 'NeedInput') {
        const chunk = await wait(() => options.read(inputChunkSize));
        checkedAbort(options.signal, session);
        session.stage(chunk);
        recordBuffers();
        stats.inputPeakBytes = Math.max(stats.inputPeakBytes, chunk?.byteLength ?? 0);
      }
    }
  } catch (error) {
    session.cancel();
    throw error;
  }
}

export function encodeStream(core, options) { return stream(core, options, true); }
export function decodeStream(core, options) { return stream(core, options, false); }

function readArray(array) {
  let offset = 0;
  return (size) => {
    if (offset === array.length) return null;
    const start = offset;
    offset = Math.min(offset + size, array.length);
    return array.subarray(start, offset);
  };
}

export async function encodeImage(core, frame, samples, options = {}) {
  if (!(samples instanceof Uint16Array)) throw new CodecError('InvalidArgument', 'Expected Uint16Array samples');
  const chunks = [];
  const result = await encodeStream(core, {
    ...options, frame, read: readArray(samples), onBytes: (chunk) => chunks.push(chunk),
  });
  const bytes = new Uint8Array(result.stats.outputProduced);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { ...result, bytes };
}

export async function decodeImage(core, bytes, options = {}) {
  if (!(bytes instanceof Uint8Array)) throw new CodecError('InvalidArgument', 'Expected Uint8Array input');
  let samples;
  const result = await decodeStream(core, {
    ...options, read: readArray(bytes), onRow: (row, index, frame) => {
      samples ??= new Uint16Array(frame.width * frame.height);
      samples.set(row, index * frame.width);
    },
  });
  return { ...result, samples };
}
