import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { decodeStream, encodeStream, loadCore } from './index.mjs';
import { buildIdentity } from './report-node.mjs';
import { codecMeasurements, createRunId, createVerificationReport, serializeVerificationReport } from './verification-report.mjs';

const help = `Usage: node sdk/cli.mjs encode|decode --input FILE --output FILE [options]
  --backend js|wasm-gc    Default: wasm-gc
  --chunk N               Samples on encode, bytes on decode
  --output-chunk N        Encoded bytes per sink call
  --width --height --bits Required on encode
  --near N                Default: 0
  --maxval N              Effective MAXVAL, default: full coded range
  --t1 --t2 --t3 --reset  Optional LSE thresholds and reset interval
  --report FILE           Write a verification JSON report to a new file
All raw input/output samples use unsigned 16-bit little-endian storage, including 8-bit images.`;

function parse(args) {
  const [mode, ...flags] = args;
  if (!['encode', 'decode'].includes(mode)) throw new Error(help);
  const allowed = new Set(['--input', '--output', '--backend', '--chunk', '--output-chunk', '--report']);
  if (mode === 'encode') for (const key of ['--width', '--height', '--bits', '--near', '--maxval', '--t1', '--t2', '--t3', '--reset']) allowed.add(key);
  const values = new Map();
  for (let i = 0; i < flags.length; i += 2) {
    const [name, value] = [flags[i], flags[i + 1]];
    if (!allowed.has(name) || value === undefined || values.has(name)) throw new Error(`Invalid argument ${name}`);
    values.set(name, value);
  }
  const input = values.get('--input');
  const output = values.get('--output');
  const report = values.get('--report');
  if (!input || !output || resolve(input) === resolve(output)) throw new Error('Distinct input and output files are required');
  if (report === '') throw new Error('Report file path is required');
  const number = (key) => values.has(key) ? Number(values.get(key)) : undefined;
  return {
    mode, input, output, report, backend: values.get('--backend'),
    inputChunkSize: number('--chunk'), outputChunkSize: number('--output-chunk'),
    frame: {
      width: number('--width'), height: number('--height'), bits: number('--bits'), near: number('--near') ?? 0,
      maxval: number('--maxval'),
      preset: { t1: number('--t1'), t2: number('--t2'), t3: number('--t3'), reset: number('--reset') },
    },
  };
}

async function reportPathKey(path) {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  const canonical = join(await realpath(parent).catch(() => parent), basename(absolute));
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

async function reserveReport({ report, input, output }) {
  const [reportKey, inputKey, outputKey] = await Promise.all([report, input, output].map(reportPathKey));
  if (reportKey === inputKey || reportKey === outputKey) throw new Error('Report must use a distinct file');
  return open(report, 'wx');
}

function fingerprint() {
  const hash = createHash('sha256');
  return {
    bytes: 0,
    eof: false,
    update(bytes) {
      hash.update(bytes);
      this.bytes += bytes.byteLength;
    },
    digest() { return hash.digest('hex'); },
  };
}

async function readChunk(file, size, tracking) {
  const bytes = Buffer.allocUnsafe(size);
  let received = 0;
  while (received < size) {
    const { bytesRead } = await file.read(bytes, received, size - received);
    if (bytesRead === 0) {
      if (tracking) tracking.eof = true;
      break;
    }
    tracking?.update(bytes.subarray(received, received + bytesRead));
    received += bytesRead;
  }
  return received === 0 ? null : bytes.subarray(0, received);
}

async function writeChunk(file, buffer, tracking) {
  let sent = 0;
  while (sent < buffer.byteLength) {
    const { bytesWritten } = await file.write(buffer, sent, buffer.byteLength - sent);
    if (bytesWritten === 0) throw new Error('Output file made no write progress');
    tracking?.update(buffer.subarray(sent, sent + bytesWritten));
    sent += bytesWritten;
  }
}

async function completeInputFingerprint(file, tracking) {
  if (tracking.eof) return;
  try {
    if ((await file.stat()).isFile()) {
      while (!tracking.eof) await readChunk(file, 64 * 1024, tracking);
    }
  } catch {
    // The report omits a whole-file digest when the remaining input is unreadable.
  }
}

async function closeFile(file) {
  try {
    await file?.close();
    return null;
  } catch (error) {
    return error;
  }
}

function readRaw(bytes) {
  if (bytes === null) return null;
  if (bytes.length % 2 !== 0) throw new Error('Raw input ends with half a sample');
  const samples = new Uint16Array(bytes.length / 2);
  for (let index = 0; index < samples.length; index++) samples[index] = bytes.readUInt16LE(index * 2);
  return samples;
}

function rawBytes(samples) {
  const bytes = Buffer.allocUnsafe(samples.length * 2);
  for (let index = 0; index < samples.length; index++) bytes.writeUInt16LE(samples[index], index * 2);
  return bytes;
}

async function main(args) {
  if (args.length === 0 || args.includes('--help')) {
    console.log(help);
    return;
  }
  const options = parse(args);
  const encoding = options.mode === 'encode';
  const backend = options.backend ?? 'wasm-gc';
  const reportFile = options.report ? await reserveReport(options) : null;
  const inputTracking = reportFile ? fingerprint() : null;
  const outputTracking = reportFile ? fingerprint() : null;
  const runId = reportFile ? createRunId() : null;
  let core;
  let input;
  let output;
  let outputClosed = false;
  let result;
  let failure;
  let started;
  let elapsedMs;
  let observedFrame;
  let observedPreset;
  let observedStats;
  let rowsDelivered = 0;
  const observe = reportFile ? (stats, frame, preset) => {
    observedStats = stats;
    observedFrame = frame ?? observedFrame;
    observedPreset = preset ?? observedPreset;
  } : undefined;
  const writeRow = (row) => writeChunk(output, rawBytes(row), outputTracking);
  try {
    core = await loadCore({ backend });
    input = await open(options.input, 'r');
    output = await open(options.output, 'wx');
    started = performance.now();
    result = encoding
      ? await encodeStream(core, {
          ...options, onProgress: observe,
          read: async (size) => readRaw(await readChunk(input, size * 2, inputTracking)),
          onBytes: (bytes, stats, preset) => {
            observe?.(stats, options.frame, preset);
            return writeChunk(output, bytes, outputTracking);
          },
        })
      : await decodeStream(core, {
          ...options, onProgress: observe,
          read: (size) => readChunk(input, size, inputTracking),
          onRow: observe ? async (row, _index, frame, stats) => {
            observe(stats, frame);
            await writeRow(row);
            rowsDelivered++;
          } : writeRow,
        });
  } catch (error) {
    failure = error;
  }
  if (output) {
    const error = await closeFile(output);
    outputClosed = !error;
    failure ??= error;
  }
  if (started !== undefined) elapsedMs = performance.now() - started;
  if (input && inputTracking) await completeInputFingerprint(input, inputTracking);
  const inputCloseError = await closeFile(input);
  failure ??= inputCloseError;

  if (reportFile) {
    try {
      const identity = await buildIdentity(backend);
      const stats = result?.stats ?? observedStats;
      const memory = codecMeasurements(stats, 'sdk');
      const stage = result ? 'passed' : started === undefined ? 'not_run' : 'failed';
      const report = createVerificationReport({
        ...identity, runId, host: 'sdk-cli', backend: core?.backend ?? null,
        input: {
          name: basename(options.input), format: encoding ? 'raw-u16le' : 'jls',
          bytes: inputTracking.eof ? inputTracking.bytes : null,
          sha256: inputTracking.eof ? inputTracking.digest() : null,
        },
        output: {
          name: basename(options.output), format: encoding ? 'jls' : 'raw-u16le',
          bytes: output ? outputTracking.bytes : null, sha256: output && outputClosed ? outputTracking.digest() : null,
          retained: Boolean(output), complete: Boolean(result && outputClosed),
        },
        frame: result?.frame ?? observedFrame,
        preset: result?.preset ?? observedPreset,
        stages: { [options.mode]: stage },
        status: failure ? 'failed' : 'passed',
        error: failure ? { code: failure.code ?? failure.name, message: failure.message } : null,
        timing: {
          elapsedMs: elapsedMs ?? null,
          boundary: 'SDK stream start through output close, including incremental hashing; excludes backend load, file open, and any post-failure input fingerprinting',
        },
        memory: { [options.mode]: memory },
        stream: {
          rowsDecoded: encoding ? null : stats?.rows ?? null,
          rowsDelivered: encoding ? null : rowsDelivered,
          provisionalRows: encoding ? null : result ? 0 : rowsDelivered,
          firstRowMs: stats?.firstRowMs ?? null,
          firstRowInputConsumed: stats?.firstRowInputConsumed ?? null,
          trailingPolicy: encoding ? null : 'reject',
          strictEoi: encoding || started === undefined ? null : Boolean(result),
        },
        limits: {
          maxWidth: 65535, maxHeight: 65535, maxPixels: 100000000, maxMetadataBytes: 1048576,
          inputChunkSize: options.inputChunkSize ?? 32768, outputChunkSize: options.outputChunkSize ?? 32768,
        },
      });
      await reportFile.writeFile(serializeVerificationReport(report), 'utf8');
    } catch (error) {
      failure ??= error;
    } finally {
      const reportCloseError = await closeFile(reportFile);
      failure ??= reportCloseError;
    }
  }
  if (failure) throw failure;
  console.log(JSON.stringify({ backend: core.backend, loadMs: core.loadMs, ...result }));
}

main(process.argv.slice(2)).catch((error) => {
  console.error(JSON.stringify({ error: error.code ?? error.name, message: error.message }));
  process.exitCode = 1;
});
