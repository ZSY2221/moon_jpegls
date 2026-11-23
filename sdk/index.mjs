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

async function wasmBytes(url) {
  if (url.protocol === 'file:' && globalThis.process?.versions?.node) {
    return (await import('node:fs/promises')).readFile(url);
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not fetch MoonJLS Wasm GC (${response.status})`);
  return response.arrayBuffer();
}

export async function loadCore({ backend = 'wasm-gc', url } = {}) {
  if (backend !== 'js' && backend !== 'wasm-gc') {
    throw new CodecError('InvalidArgument', `Unknown backend ${backend}`);
  }
  const start = performance.now();
  const asset = url === undefined
    ? new URL(backend === 'js' ? './generated/core.mjs' : './generated/core.wasm', import.meta.url)
    : new URL(url, import.meta.url);
  const bindings = backend === 'js'
    ? await import(asset.href)
    : (await WebAssembly.instantiate(await wasmBytes(asset), {}, {
        builtins: ['js-string'], importedStringConstants: '_',
      })).instance.exports;
  return {
    backend,
    loadMs: performance.now() - start,
    createEncoder(frame, options = {}) { return new Session(bindings, frame, options); },
    createDecoder(options = {}) { return new Session(bindings, null, options); },
  };
}

class Session {
  #bindings;
  #port;
  #frame;
  #encoding;
  #capacity;
  #outputCapacity;
  #offset = 0;
  #length = 0;
  #eof = false;
  #status = 'NeedInput';

  constructor(bindings, frame, options) {
    this.#bindings = bindings;
    this.#encoding = frame !== null;
    this.#frame = frame;
    const { inputChunkSize, outputChunkSize } = capacities(options);
    this.#capacity = inputChunkSize;
    this.#outputCapacity = outputChunkSize;
    const budget = limits(options);
    if (this.#encoding) {
      const frameValues = ['width', 'height', 'bits', 'near'].map((key) => integer(frame[key], key, 0));
      this.#port = bindings.encoder_new(...frameValues, inputChunkSize, outputChunkSize, ...budget);
      const code = bindings.encoder_status(this.#port);
      if (code < 0) throw new CodecError(errors[-code], bindings.encoder_message(this.#port));
      this.#frame = Object.freeze({ ...frame });
    } else {
      this.#port = bindings.decoder_new(inputChunkSize, ...budget);
    }
  }

  get frame() { return this.#frame; }
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
    const set = this.#encoding ? bindings.encoder_set : bindings.decoder_set;
    for (let i = 0; i < this.#length; i++) set(this.#port, i, input[i]);
    if (!this.#encoding) bindings.decoder_load(this.#port, this.#length);
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
        this.#frame = Object.freeze({
          width, height: bindings.decoder_frame(port, 1),
          bits: bindings.decoder_frame(port, 2), near: bindings.decoder_frame(port, 3),
        });
      }
    }
    let chunk;
    if (produced > 0) {
      chunk = new Uint8Array(produced);
      for (let i = 0; i < produced; i++) chunk[i] = bindings.encoder_byte(port, i);
    } else if (!this.#encoding && this.#status === 'RowReady') {
      chunk = new Uint16Array(this.#frame.width);
      for (let i = 0; i < chunk.length; i++) chunk[i] = bindings.decoder_sample(port, i);
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
        if (encoding) await wait(() => options.onBytes(next.chunk, snapshot()));
        else if (options.onRow) await wait(() => options.onRow(next.chunk, stats.rows - 1, session.frame, snapshot()));
      }
      checkedAbort(options.signal, session);
      stats.outputQueueBytes = 0;
      if (options.onProgress) await wait(() => options.onProgress(snapshot(), session.frame));
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
        return { frame: session.frame, stats: snapshot() };
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
