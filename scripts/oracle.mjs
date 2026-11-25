import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const localPackage = new URL('../.tools/oracle-npm/node_modules/@team-charls/charls-wasm/', import.meta.url);
const fallbackPackage = new URL('../../moon_jpegls/.tools/oracle-npm/node_modules/@team-charls/charls-wasm/', import.meta.url);
const packageUrl = existsSync(localPackage) ? localPackage : fallbackPackage;
const expectedVersion = '0.10.0';
const { version } = JSON.parse(await readFile(new URL('package.json', packageUrl), 'utf8'));
assert.equal(version, expectedVersion, `Install @team-charls/charls-wasm@${expectedVersion}`);
const { createJpegLSDecoder, createJpegLSEncoder } = await import(new URL('index.js', packageUrl));

export async function createOracle() {
  const encoder = await createJpegLSEncoder();
  const decoder = await createJpegLSDecoder();
  return {
    encode(samples, { width, height, bits, near }, options = 0) {
      assert.equal(samples.length, width * height, 'sample count');
      const byteWidth = bits <= 8 ? 1 : 2;
      const input = new Uint8Array(samples.length * byteWidth);
      if (byteWidth === 1) {
        input.set(samples);
      } else {
        const view = new DataView(input.buffer);
        for (let i = 0; i < samples.length; i++) view.setUint16(i * 2, samples[i], true);
      }
      return encoder.encode(input, width, height, bits, 1, 0, options, near).slice();
    },
    decode(input) {
      const result = decoder.decode(input);
      const { width, height, bitsPerSample: bits, componentCount } = decoder.getFrameInfo();
      assert.ok(componentCount >= 1, 'expected valid component count');
      const near = decoder.getNearLossless();
      const total = width * height * componentCount;
      const pixels = new Uint16Array(total);
      if (bits <= 8) {
        pixels.set(result);
      } else {
        const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
        for (let i = 0; i < pixels.length; i++) pixels[i] = view.getUint16(i * 2, true);
      }
      return {
        pixels,
        frame: { width, height, bits, near, ...(componentCount > 1 ? { components: componentCount } : {}) },
      };
    },
    close() {
      encoder.dispose();
      decoder.dispose();
    },
  };
}

export function readRaw(bytes) {
  assert.equal(bytes.byteLength % 2, 0, 'raw must be unsigned uint16le');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Uint16Array.from({ length: bytes.byteLength / 2 }, (_, index) => view.getUint16(index * 2, true));
}

export function writeRaw(pixels) {
  const bytes = new Uint8Array(pixels.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < pixels.length; i++) view.setUint16(i * 2, pixels[i], true);
  return bytes;
}

async function main(args) {
  const oracle = await createOracle();
  try {
    if (args[0] === '--self-test' && args.length === 1) {
      let cases = 0;
      for (const bits of [8, 12, 16]) {
        const max = 2 ** bits - 1;
        const pixels = Uint16Array.of(0, max >> 1, (max >> 1) + 1, max);
        for (const near of [0, 1, 2, 3]) {
          const frame = { width: 4, height: 1, bits, near };
          const reference = oracle.decode(oracle.encode(pixels, frame, 4));
          assert.deepEqual(reference.frame, frame);
          assert.ok(pixels.every((sample, i) => Math.abs(sample - reference.pixels[i]) <= near));
          cases++;
        }
      }
      console.log(JSON.stringify({ package: '@team-charls/charls-wasm', version, selfTestCases: cases }));
      return;
    }
    const [operation, input, output, ...parameters] = args;
    if (operation === 'encode' && parameters.length >= 4 && parameters.length <= 5) {
      const [width, height, bits, near, options = 0] = parameters.map(Number);
      const pixels = readRaw(await readFile(input));
      await writeFile(output, oracle.encode(pixels, { width, height, bits, near }, options));
      return;
    }
    if (operation === 'decode' && input && output && !parameters.length) {
      const { pixels, frame } = oracle.decode(await readFile(input));
      await writeFile(output, writeRaw(pixels));
      console.log(JSON.stringify(frame));
      return;
    }
    throw new Error('Usage: node scripts/oracle.mjs --self-test | encode in.raw out.jls WIDTH HEIGHT BITS NEAR [OPTIONS] | decode in.jls out.raw');
  } finally {
    oracle.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
