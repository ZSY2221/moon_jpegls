const states = ['NeedInput', 'NeedOutput', 'RowReady', 'Done'];
const errors = [null, 'InvalidData', 'UnsupportedFeature', 'ResourceLimit', 'Truncated', 'InvalidArgument', 'Cancelled'];
const maximumCapacity = 1024 * 1024;
const usualChunk = 32 * 1024;

export class CodecError extends Error {
  constructor(code, message, progress = undefined, location = undefined) {
    super(message);
    this.name = 'CodecError';
    this.code = code;
    this.progress = progress;
    if (location) this.location = location;
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

function normalizePresetObj(thresholds) {
  if (thresholds === undefined) return {};
  if (typeof thresholds !== 'object' || thresholds === null || Array.isArray(thresholds)) {
    throw new CodecError('InvalidArgument', 'preset must be an object');
  }
  return thresholds;
}

function requestedPreset(frame) {
  const thresholds = normalizePresetObj(frame.preset);
  return [
    integer(frame.maxval ?? 0, 'maxval', 0, 65535),
    ...['t1', 't2', 't3', 'reset'].map((field) => integer(thresholds[field] ?? 0, field, 0, 65535)),
  ];
}

function ceilDiv(num, den) {
  return Math.floor((num + den - 1) / den);
}

export function componentDimensions(frame) {
  const comps = frame?.components ?? [{ id: 1, hSampling: 1, vSampling: 1 }];
  let maxH = 1;
  let maxV = 1;
  for (const c of comps) {
    const h = c.hSampling ?? 1;
    const v = c.vSampling ?? 1;
    if (h > maxH) maxH = h;
    if (v > maxV) maxV = v;
  }
  const widths = comps.map((c) => {
    const h = c.hSampling ?? 1;
    return h === maxH ? frame.width : ceilDiv(frame.width * h, maxH);
  });
  const heights = comps.map((c) => {
    const v = c.vSampling ?? 1;
    return v === maxV ? frame.height : ceilDiv(frame.height * v, maxV);
  });
  const offsets = [];
  let total = 0;
  for (let i = 0; i < comps.length; i++) {
    offsets.push(total);
    total += widths[i] * heights[i];
  }
  return { maxH, maxV, widths, heights, offsets, total };
}

function normalizeMultiEncode(frame) {
  const rawComps = frame.components ?? [1];
  const components = rawComps.map((entry, idx) => {
    const obj = typeof entry === 'number' ? { id: entry } : entry;
    if (!obj || typeof obj !== 'object') {
      throw new CodecError('InvalidArgument', `components[${idx}] must be an object or component ID`);
    }
    const id = integer(obj.id, `components[${idx}].id`, 0, 255);
    const hSampling = integer(obj.hSampling ?? 1, `components[${idx}].hSampling`, 1, 4);
    const vSampling = integer(obj.vSampling ?? 1, `components[${idx}].vSampling`, 1, 4);
    return Object.freeze({ id, hSampling, vSampling });
  });
  const baseNear = integer(frame.near ?? 0, 'near', 0, 255);
  const frameIlv = integer(frame.interleave ?? 0, 'interleave', 0, 2);
  const framePt = integer(frame.pointTransform ?? 0, 'pointTransform', 0, 15);
  const rawScans = frame.scans ?? (frameIlv > 0
    ? [{ componentIds: components.map((comp) => comp.id), interleave: frameIlv, near: baseNear, pointTransform: framePt }]
    : components.map((comp) => ({ componentId: comp.id })));
  if (!Array.isArray(rawScans)) {
    throw new CodecError('InvalidArgument', 'frame.scans must be an array');
  }
  const scans = rawScans.map((scan, idx) => {
    const obj = typeof scan === 'number' ? { componentId: scan } : scan;
    if (!obj || typeof obj !== 'object') {
      throw new CodecError('InvalidArgument', `scans[${idx}] must be an object`);
    }
    const rawIds = obj.componentIds ?? [obj.componentId];
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      throw new CodecError('InvalidArgument', `scans[${idx}] must specify componentIds or componentId`);
    }
    const componentIds = rawIds.map((cid, cIdx) => integer(cid, `scans[${idx}].componentIds[${cIdx}]`, 0, 255));
    const defaultIlv = componentIds.length > 1 ? (frameIlv > 0 ? frameIlv : 1) : 0;
    const interleave = integer(obj.interleave ?? defaultIlv, `scans[${idx}].interleave`, 0, 2);
    const pointTransform = integer(obj.pointTransform ?? framePt, `scans[${idx}].pointTransform`, 0, 15);
    const near = integer(obj.near ?? baseNear, `scans[${idx}].near`, 0, 255);
    const presetSource = {
      maxval: obj.maxval ?? frame.maxval,
      preset: obj.preset ?? frame.preset,
    };
    const presetValues = requestedPreset(presetSource);
    return { componentIds, interleave, near, pointTransform, presetValues };
  });
  return { components: Object.freeze(components), scans };
}

function readErrorLocation(bindings, port) {
  if (!bindings.decoder_error_int || !bindings.decoder_error_int(port, 0)) return undefined;
  return Object.freeze({
    scanIndex: bindings.decoder_error_int(port, 1),
    componentId: bindings.decoder_error_int(port, 2),
    marker: bindings.decoder_error_int(port, 3),
    offset: bindings.decoder_error_offset ? bindings.decoder_error_offset(port) : -1,
  });
}

function readScanRecord(bindings, port, scanIndex) {
  const g = (field) => bindings.decoder_scan_int(port, scanIndex, field);
  const o = (which) => bindings.decoder_scan_offset ? bindings.decoder_scan_offset(port, scanIndex, which) : -1;
  const compCount = bindings.decoder_scan_comp_count ? bindings.decoder_scan_comp_count(port, scanIndex) : 1;
  const componentIndices = bindings.decoder_scan_comp_field
    ? Object.freeze(Array.from({ length: compCount }, (_, slot) => bindings.decoder_scan_comp_field(port, scanIndex, slot, 0)))
    : Object.freeze([g(1)]);
  const componentIds = bindings.decoder_scan_comp_field
    ? Object.freeze(Array.from({ length: compCount }, (_, slot) => bindings.decoder_scan_comp_field(port, scanIndex, slot, 1)))
    : Object.freeze([g(2)]);
  return Object.freeze({
    scanIndex: g(0),
    componentIndex: g(1),
    componentId: g(2),
    componentIndices,
    componentIds,
    near: g(3),
    interleave: g(4),
    pointTransform: g(5),
    preset: Object.freeze({ maxval: g(6), t1: g(7), t2: g(8), t3: g(9), reset: g(10) }),
    rows: g(11),
    completed: g(12) === 1,
    headerOffset: o(0),
    entropyOffset: o(1),
    endOffset: o(2),
  });
}

function readStructure(bindings, port, frameInfo) {
  if (!frameInfo || !bindings.decoder_scan_count || !bindings.decoder_structure_offset) return null;
  const scanCount = bindings.decoder_scan_count(port);
  const scans = Object.freeze(Array.from({ length: scanCount }, (_, i) => readScanRecord(bindings, port, i)));
  const markerCount = bindings.decoder_marker_count ? bindings.decoder_marker_count(port) : 0;
  const markers = Object.freeze(Array.from({ length: markerCount }, (_, i) => Object.freeze({
    code: bindings.decoder_marker_int(port, i, 0),
    length: bindings.decoder_marker_int(port, i, 1),
    scanIndex: bindings.decoder_marker_int(port, i, 2),
    detail: bindings.decoder_marker_int(port, i, 3),
    offset: bindings.decoder_marker_offset(port, i),
  })));
  return Object.freeze({
    soiOffset: bindings.decoder_structure_offset(port, 0),
    sofOffset: bindings.decoder_structure_offset(port, 1),
    sofLength: bindings.decoder_structure_offset(port, 2),
    eoiOffset: bindings.decoder_structure_offset(port, 3),
    frame: frameInfo,
    scans,
    markers,
  });
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

function decodedSampleArray(format = 'u16') {
  if (format === 'u16') return Uint16Array;
  if (format === 'u32') return Uint32Array;
  throw new CodecError('InvalidArgument', 'sampleFormat must be u16 or u32');
}

class Session {
  #bindings;
  #backend;
  #port;
  #frame;
  #frameInfo = null;
  #components = null;
  #scans = null;
  #currentScan = null;
  #structure = null;
  #rowMeta = null;
  #preset = null;
  #encoding;
  #DecodedSamples;
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
      const near = integer(frame.near ?? 0, 'near', 0, 255);
      if (frame.components !== undefined || frame.scans !== undefined || (frame.pointTransform ?? 0) !== 0) {
        if (frame.components !== undefined && (!Array.isArray(frame.components) || frame.components.length === 0)) {
          throw new CodecError('InvalidArgument', 'frame.components must be a non-empty array');
        }
        const multi = normalizeMultiEncode(frame);
        if (!bindings.encoder_builder_new) {
          throw new CodecError('UnsupportedFeature', 'Codec artifact does not support multi-component encoding');
        }
        const builder = bindings.encoder_builder_new(...frameValues, inputChunkSize, outputChunkSize, ...budget);
        for (const c of multi.components) {
          bindings.encoder_builder_component(builder, c.id, c.hSampling, c.vSampling);
        }
        for (const s of multi.scans) {
          if (bindings.encoder_builder_scan_begin) {
            bindings.encoder_builder_scan_begin(builder, s.interleave, s.near, s.pointTransform, ...s.presetValues);
            for (const cid of s.componentIds) {
              bindings.encoder_builder_scan_component(builder, cid);
            }
          } else {
            if (s.componentIds.length !== 1 || s.interleave !== 0 || s.pointTransform !== 0) {
              throw new CodecError('UnsupportedFeature', 'Codec artifact does not support interleaved scans or point transform');
            }
            bindings.encoder_builder_scan(builder, s.componentIds[0], s.near, ...s.presetValues);
          }
        }
        this.#port = bindings.encoder_builder_build(builder);
        const code = bindings.encoder_status(this.#port);
        if (code < 0) throw new CodecError(errors[-code], bindings.encoder_message(this.#port));
        this.#components = multi.components;
        this.#frameInfo = Object.freeze({ width: frameValues[0], height: frameValues[1], bits: frameValues[2], components: multi.components });
        const reportScanPresets = bindings.encoder_scan_preset && multi.scans.some((scan) => scan.pointTransform);
        this.#scans = Object.freeze(multi.scans.map((s, scanIndex) => {
          const componentIndices = Object.freeze(s.componentIds.map((cid) => multi.components.findIndex((c) => c.id === cid)));
          const componentIds = Object.freeze([...s.componentIds]);
          const preset = reportScanPresets && resolvedFrame({ bits: frameValues[2], near: s.near },
            (port, near, field) => bindings.encoder_scan_preset(port, scanIndex, near, field), this.#port).preset;
          return Object.freeze({
            scanIndex,
            componentIndex: componentIndices[0],
            componentId: componentIds[0],
            componentIndices,
            componentIds,
            near: s.near,
            interleave: s.interleave,
            pointTransform: s.pointTransform,
            ...(preset ? { preset } : {}),
          });
        }));
        const first = this.#scans[0];
        const resolved = resolvedFrame({
          width: frameValues[0], height: frameValues[1], bits: frameValues[2], near: first.near,
          ...(first.pointTransform ? { pointTransform: first.pointTransform } : {}),
          ...(first.interleave ? { interleave: first.interleave } : {}),
        }, bindings.encoder_preset, this.#port);
        this.#frame = multi.components.length > 1
          ? Object.freeze({ ...resolved.frame, components: multi.components, scans: this.#scans })
          : resolved.frame;
        this.#preset = resolved.preset;
      } else {
        if (frame.interleave === 2) {
          throw new CodecError('InvalidArgument', 'Sample interleave requires multiple frame components');
        }
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
        this.#components = Object.freeze([Object.freeze({ id: 1, hSampling: 1, vSampling: 1 })]);
        this.#frameInfo = Object.freeze({ width: frameValues[0], height: frameValues[1], bits: frameValues[2], components: this.#components });
        this.#scans = Object.freeze([Object.freeze({ scanIndex: 0, componentIndex: 0, componentId: 1, near, interleave: 0, pointTransform: 0 })]);
      }
    } else {
      this.#DecodedSamples = decodedSampleArray(options.sampleFormat);
      this.#port = bindings.decoder_new(inputChunkSize, ...budget);
    }
  }

  get frame() { return this.#frame; }
  get frameInfo() { return this.#frameInfo; }
  get components() { return this.#components; }
  get scans() { return this.#scans; }
  get currentScan() { return this.#currentScan; }
  get structure() { return this.#structure; }
  get rowMeta() { return this.#rowMeta; }
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

  #refreshDecodeMetadata(status) {
    const bindings = this.#bindings;
    const port = this.#port;
    const width = bindings.decoder_frame(port, 0);
    if (width === 0) return;
    const height = bindings.decoder_frame(port, 1);
    const bits = bindings.decoder_frame(port, 2);
    const near = bindings.decoder_current_scan ? bindings.decoder_current_scan(port, 3) : bindings.decoder_frame(port, 3);
    const activeNear = near >= 0 ? near : bindings.decoder_frame(port, 3);
    const activePt = bindings.decoder_current_scan ? Math.max(0, bindings.decoder_current_scan(port, 7)) : 0;
    if (this.#components === null) {
      const compCount = bindings.decoder_component_count ? bindings.decoder_component_count(port) : 1;
      const comps = bindings.decoder_component_field
        ? Array.from({ length: compCount }, (_, i) => Object.freeze({
            id: bindings.decoder_component_field(port, i, 0),
            hSampling: bindings.decoder_component_field(port, i, 1),
            vSampling: bindings.decoder_component_field(port, i, 2),
          }))
        : [Object.freeze({ id: 1, hSampling: 1, vSampling: 1 })];
      this.#components = Object.freeze(comps);
      this.#frameInfo = Object.freeze({ width, height, bits, components: this.#components });
    }
    const baseFrame = {
      width,
      height,
      bits,
      near: activeNear,
      ...(activePt ? { pointTransform: activePt } : {}),
      ...(this.#components.length > 1 ? { components: this.#components } : {}),
    };
    const resolved = resolvedFrame(baseFrame, bindings.decoder_preset, port);
    this.#frame = resolved.frame;
    this.#preset = resolved.preset;

    if (status === 'RowReady' || status === 'Done') {
      const sampleBytes = this.#DecodedSamples.BYTES_PER_ELEMENT;
      const endianness = sampleBytes === 4 ? 'host-u32' : 'host-u16';
      const st = readStructure(bindings, port, this.#frameInfo);
      if (st) {
        this.#structure = st;
        this.#scans = st.scans;
      }
      if (bindings.decoder_current_scan) {
        const scanIndex = bindings.decoder_current_scan(port, 0);
        if (scanIndex >= 0) {
          this.#currentScan = st?.scans[scanIndex] ?? null;
          if (status === 'RowReady') {
            const componentIndex = bindings.decoder_current_scan(port, 1);
            const stride = bindings.decoder_current_row_width ? bindings.decoder_current_row_width(port) : width;
            const compHeight = bindings.decoder_component_field ? bindings.decoder_component_field(port, componentIndex, 4) : height;
            this.#rowMeta = Object.freeze({
              scanIndex,
              componentIndex,
              componentId: bindings.decoder_current_scan(port, 2),
              rowIndex: bindings.decoder_current_scan(port, 4),
              height: compHeight > 0 ? compHeight : height,
              near: activeNear,
              interleave: bindings.decoder_current_scan(port, 6),
              pointTransform: activePt,
              preset: this.#preset,
              layout: 'planar',
              width: stride,
              stride,
              sampleBytes,
              endianness,
            });
          }
        }
      } else if (status === 'RowReady') {
        this.#rowMeta = Object.freeze({
          scanIndex: 0, componentIndex: 0, componentId: 1, rowIndex: null, height,
          near: activeNear, interleave: 0, pointTransform: 0,
          preset: this.#preset, layout: 'planar', width, stride: width, sampleBytes, endianness,
        });
      }
    }
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
      const loc = !this.#encoding ? readErrorLocation(bindings, port) : undefined;
      throw new CodecError(errors[-code], message, { consumed, produced }, loc);
    }
    this.#status = states[code];
    this.#rowMeta = null;
    if (!this.#encoding) {
      this.#refreshDecodeMetadata(this.#status);
    } else if (bindings.encoder_scan_index) {
      const scanIndex = bindings.encoder_scan_index(port);
      if (scanIndex >= 0 && this.#scans?.[scanIndex] && bindings.encoder_preset) {
        const s = this.#scans[scanIndex];
        const near = s.near;
        const resolved = resolvedFrame({ width: this.#frameInfo.width, height: this.#frameInfo.height, bits: this.#frameInfo.bits, near }, bindings.encoder_preset, port);
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
      const width = this.#rowMeta?.stride ?? (bindings.decoder_current_row_width ? bindings.decoder_current_row_width(port) : this.#frame.width);
      chunk = new this.#DecodedSamples(width);
      let i = 0;
      const narrow = this.#DecodedSamples === Uint16Array;
      const transformed = this.#rowMeta?.pointTransform > 0;
      if (narrow && !transformed && bindings.decoder_pack3) {
        const pack3 = bindings.decoder_pack3;
        for (; i + 2 < width; i += 3) {
          const d = pack3(port, i);
          const lo = d | 0;
          chunk[i] = lo & 0xffff;
          chunk[i + 1] = lo >>> 16;
          chunk[i + 2] = ((d - (lo >>> 0)) * INV_2_32) | 0;
        }
      } else if (narrow && !transformed && bindings.decoder_pair) {
        const pair = bindings.decoder_pair;
        for (; i + 1 < width; i += 2) {
          const p = pair(port, i);
          chunk[i] = p & 0xffff;
          chunk[i + 1] = p >>> 16;
        }
      }
      const getSample = bindings.decoder_sample;
      if (narrow && transformed) {
        for (; i < width; i++) {
          const sample = getSample(port, i);
          if (sample > 65535) {
            this.#status = 'Error';
            throw new CodecError('UnsupportedFeature', 'Point transform reconstruction exceeds Uint16 output range', { consumed, produced: 0 });
          }
          chunk[i] = sample;
        }
      } else {
        for (; i < width; i++) chunk[i] = getSample(port, i);
      }
    }
    return { status: this.#status, consumed, produced: chunk?.length ?? 0, chunk, rowMeta: this.#rowMeta ?? undefined };
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
  let lastScanCompleted = -1;
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
        else if (options.onRow) {
          const meta = next.rowMeta ?? next.metadata;
          const rowIndex = meta?.rowIndex ?? (stats.rows - 1);
          await wait(() => options.onRow(next.chunk, rowIndex, session.frame, snapshot(), session.preset, meta));
        }
      }
      if (!encoding && options.onScanComplete && session.scans) {
        while (lastScanCompleted + 1 < session.scans.length && session.scans[lastScanCompleted + 1].completed) {
          lastScanCompleted++;
          await wait(() => options.onScanComplete(session.scans[lastScanCompleted], snapshot(), session.structure));
        }
      }
      checkedAbort(options.signal, session);
      stats.outputQueueBytes = 0;
      if (options.onProgress) await wait(() => options.onProgress(snapshot(), session.frame, session.preset, session.structure));
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
        return {
          frame: session.frame,
          frameInfo: session.frameInfo ?? undefined,
          components: session.components ?? undefined,
          scans: session.scans ?? undefined,
          structure: session.structure ?? undefined,
          preset: session.preset,
          stats: snapshot(),
        };
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

export async function encodePlanarImage(core, frame, input, options = {}) {
  let samples;
  let hostConversionBufferBytes = 0;
  const comps = frame.components?.length ?? 1;
  const normalizedComps = (frame.components ?? [{ id: 1 }]).map((c) => (
    typeof c === 'number'
      ? { id: c, hSampling: 1, vSampling: 1 }
      : { id: c.id, hSampling: c.hSampling ?? 1, vSampling: c.vSampling ?? 1 }
  ));
  const dims = componentDimensions({ ...frame, components: normalizedComps });
  if (input instanceof Uint16Array) {
    samples = input;
  } else if (Array.isArray(input) && input.length === comps
    && input.every((p, idx) => p instanceof Uint16Array && p.length === dims.widths[idx] * dims.heights[idx])) {
    const compIds = normalizedComps.map((c) => c.id);
    const frameIlv = frame.interleave ?? 0;
    const scanSpecs = frame.scans ?? (frameIlv > 0
      ? [{ componentIds: compIds, interleave: frameIlv }]
      : compIds.map((id) => ({ componentIds: [id], interleave: 0 })));
    samples = new Uint16Array(dims.total);
    hostConversionBufferBytes = samples.byteLength;
    let outOffset = 0;
    for (const rawScan of scanSpecs) {
      const scan = typeof rawScan === 'number' ? { componentIds: [rawScan], interleave: 0 } : rawScan;
      const ids = scan.componentIds ?? [scan.componentId];
      const ilv = scan.interleave ?? (ids.length > 1 ? (frameIlv > 0 ? frameIlv : 1) : 0);
      const idxs = ids.map((cid) => {
        const ci = compIds.indexOf(cid);
        if (ci < 0) throw new CodecError('InvalidArgument', `Scan references undeclared component ${cid}`);
        return ci;
      });
      if (ilv === 0) {
        for (const ci of idxs) {
          samples.set(input[ci], outOffset);
          outOffset += input[ci].length;
        }
      } else if (ilv === 1) {
        const mcuRows = ceilDiv(frame.height, dims.maxV);
        for (let m = 0; m < mcuRows; m++) {
          for (const ci of idxs) {
            const cw = dims.widths[ci];
            const ch = dims.heights[ci];
            const vs = normalizedComps[ci].vSampling;
            for (let v = 0; v < vs; v++) {
              const y = m * vs + v;
              if (y < ch) {
                const start = y * cw;
                samples.set(input[ci].subarray(start, start + cw), outOffset);
                outOffset += cw;
              }
            }
          }
        }
      } else if (ilv === 2) {
        const width = dims.widths[idxs[0]];
        const height = dims.heights[idxs[0]];
        if (!idxs.every((ci) => dims.widths[ci] === width && dims.heights[ci] === height)) {
          throw new CodecError('InvalidArgument', 'Sample-interleaved scan components must have equal dimensions');
        }
        for (let sample = 0; sample < width * height; sample++) {
          for (const ci of idxs) samples[outOffset++] = input[ci][sample];
        }
      } else {
        throw new CodecError('InvalidArgument', 'Invalid scan interleave mode');
      }
    }
  } else {
    throw new CodecError('InvalidArgument', 'Expected planar Uint16Array or array of per-component Uint16Array planes');
  }
  const res = await encodeImage(core, frame, samples, options);
  return { ...res, hostConversionBufferBytes };
}

export async function decodeImage(core, bytes, options = {}) {
  if (!(bytes instanceof Uint8Array)) throw new CodecError('InvalidArgument', 'Expected Uint8Array input');
  const DecodedSamples = decodedSampleArray(options.sampleFormat);
  let samples;
  let dims;
  const result = await decodeStream(core, {
    ...options, read: readArray(bytes), onRow: (row, index, frame, _stats, _preset, meta) => {
      if (!dims) {
        dims = componentDimensions(frame);
        samples = new DecodedSamples(dims.total);
      }
      const compIdx = meta?.componentIndex ?? 0;
      const rowIdx = meta?.rowIndex ?? index;
      samples.set(row, dims.offsets[compIdx] + rowIdx * dims.widths[compIdx]);
    },
  });
  return { ...result, samples };
}

export async function decodePlanarImage(core, bytes, options = {}) {
  const result = await decodeImage(core, bytes, options);
  const dims = componentDimensions(result.frameInfo ?? result.frame);
  const planes = dims.widths.map((cw, c) =>
    result.samples.subarray(dims.offsets[c], dims.offsets[c] + cw * dims.heights[c]));
  return { ...result, planes };
}

export async function inspectStream(core, bytes, options = {}) {
  if (!(bytes instanceof Uint8Array)) throw new CodecError('InvalidArgument', 'Expected Uint8Array input');
  const sampleFormat = options.onRow ? 'u16' : 'u32';
  return decodeStream(core, { sampleFormat, ...options, read: readArray(bytes) });
}
