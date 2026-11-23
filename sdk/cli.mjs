import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { decodeStream, encodeStream, loadCore } from './index.mjs';

const help = `Usage: node sdk/cli.mjs encode|decode --input FILE --output FILE [options]
  --backend js|wasm-gc    Default: wasm-gc
  --chunk N               Samples on encode, bytes on decode
  --output-chunk N        Encoded bytes per sink call
  --width --height --bits Required on encode
  --near N                Default: 0
All raw input/output samples use unsigned 16-bit little-endian storage, including 8-bit images.`;

function parse(args) {
  const [mode, ...flags] = args;
  if (!['encode', 'decode'].includes(mode)) throw new Error(help);
  const allowed = new Set(['--input', '--output', '--backend', '--chunk', '--output-chunk']);
  if (mode === 'encode') for (const key of ['--width', '--height', '--bits', '--near']) allowed.add(key);
  const values = new Map();
  for (let i = 0; i < flags.length; i += 2) {
    const [name, value] = [flags[i], flags[i + 1]];
    if (!allowed.has(name) || value === undefined || values.has(name)) throw new Error(`Invalid argument ${name}`);
    values.set(name, value);
  }
  const input = values.get('--input');
  const output = values.get('--output');
  if (!input || !output || resolve(input) === resolve(output)) throw new Error('Distinct input and output files are required');
  const number = (key) => values.has(key) ? Number(values.get(key)) : undefined;
  return {
    mode, input, output, backend: values.get('--backend'),
    inputChunkSize: number('--chunk'), outputChunkSize: number('--output-chunk'),
    frame: { width: number('--width'), height: number('--height'), bits: number('--bits'), near: number('--near') ?? 0 },
  };
}

async function readChunk(file, size) {
  const bytes = Buffer.allocUnsafe(size);
  let received = 0;
  while (received < size) {
    const { bytesRead } = await file.read(bytes, received, size - received);
    if (bytesRead === 0) break;
    received += bytesRead;
  }
  return received === 0 ? null : bytes.subarray(0, received);
}

async function writeChunk(file, buffer) {
  let sent = 0;
  while (sent < buffer.byteLength) {
    const { bytesWritten } = await file.write(buffer, sent, buffer.byteLength - sent);
    if (bytesWritten === 0) throw new Error('Output file made no write progress');
    sent += bytesWritten;
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
  const core = await loadCore({ backend: options.backend });
  const input = await open(options.input, 'r');
  let output;
  try {
    output = await open(options.output, 'wx');
    const result = options.mode === 'encode'
      ? await encodeStream(core, {
          ...options,
          read: async (size) => readRaw(await readChunk(input, size * 2)),
          onBytes: (bytes) => writeChunk(output, bytes),
        })
      : await decodeStream(core, {
          ...options,
          read: (size) => readChunk(input, size),
          onRow: (row) => writeChunk(output, rawBytes(row)),
        });
    console.log(JSON.stringify({ backend: core.backend, loadMs: core.loadMs, ...result }));
  } finally {
    await input.close();
    if (output) await output.close();
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(JSON.stringify({ error: error.code ?? error.name, message: error.message }));
  process.exitCode = 1;
});
