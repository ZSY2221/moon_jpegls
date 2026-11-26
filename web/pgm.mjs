import { CodecError } from '../sdk/index.mjs';

const maxHeader = 64 * 1024;
const maxReferenceBytes = 64 * 1024;
const whitespace = (byte) => byte === 32 || (byte >= 9 && byte <= 13);
const invalid = (message) => new CodecError('InvalidData', message);
export function sampleMaximum(frame) {
  const codedMaxval = frame.maxval ?? (2 ** frame.bits - 1);
  return Math.min(65535, codedMaxval * 2 ** (frame.pointTransform ?? 0));
}
export const sampleByteWidth = (maxval) => maxval < 256 ? 1 : 2;

export async function readPgmHeader(file) {
  const prefix = new Uint8Array(await file.slice(0, maxHeader + 1).arrayBuffer());
  let position = 0;
  const token = () => {
    while (position < prefix.length) {
      if (whitespace(prefix[position])) position++;
      else if (prefix[position] === 35) {
        while (position < prefix.length && prefix[position] !== 10 && prefix[position] !== 13) position++;
      } else break;
    }
    const start = position;
    while (position < prefix.length && !whitespace(prefix[position]) && prefix[position] !== 35) position++;
    if (position - start < 1 || position - start > 10) throw invalid('Invalid PGM header token');
    return new TextDecoder().decode(prefix.subarray(start, position));
  };
  const number = () => {
    const value = token();
    if (!/^\d+$/.test(value)) throw invalid('Expected an unsigned PGM header integer');
    return Number(value);
  };
  if (token() !== 'P5') throw invalid('Expected a binary P5 PGM file');
  const width = number();
  const height = number();
  const maxval = number();
  if (maxval < 1 || maxval > 65535) throw invalid('PGM MAXVAL must be in 1..65535');
  if (!whitespace(prefix[position])) throw invalid('PGM raster must follow a header separator');
  if (width < 1 || height < 1) throw invalid('PGM dimensions must be positive');
  if (width > 65535 || height > 65535) throw new CodecError('UnsupportedFeature', 'PGM dimensions exceed the JPEG-LS frame format');
  const bits = Math.max(2, 32 - Math.clz32(maxval));
  const sampleBytes = sampleByteWidth(maxval);
  const count = width * height;
  if (prefix[position] === 13 && prefix[position + 1] === 10 && file.size === position + 2 + count * sampleBytes) position++;
  position++;
  if (position > maxHeader) throw new CodecError('ResourceLimit', 'PGM header exceeds 64 KiB');
  if (file.size !== position + count * sampleBytes) throw invalid('PGM raster byte length differs from the frame size');
  return { width, height, bits, maxval, sampleBytes, count, position };
}

export async function openPgm(file, near, signal, header) {
  const { width, height, bits, maxval, sampleBytes, count, position } = header ?? await readPgmHeader(file);
  const frame = { width, height, bits, near };
  if (maxval !== 2 ** bits - 1) frame.maxval = maxval;

  const materialize = (bytes, size) => {
    const output = new Uint16Array(size);
    if (sampleBytes === 1) output.set(bytes);
    else {
      for (let i = 0, p = 0; i < size; i++, p += 2) {
        output[i] = (bytes[p] << 8) | bytes[p + 1];
      }
    }
    if (maxval < 2 ** (sampleBytes * 8) - 1 && output.some((sample) => sample > maxval)) {
      throw invalid('PGM sample exceeds MAXVAL');
    }
    return output;
  };
  const readRange = async (start, size) => {
    const offset = position + start * sampleBytes;
    return materialize(new Uint8Array(await file.slice(offset, offset + size * sampleBytes).arrayBuffer()), size);
  };
  let cursor = 0;
  const rowBytes = width * sampleBytes;
  const rowsPerWindow = Math.floor(maxReferenceBytes / rowBytes);
  let referenceWindow;
  let loading;
  let referenceClosed = false;
  const releaseReference = () => {
    referenceClosed = true;
    referenceWindow = undefined;
  };
  const assertReferenceOpen = () => {
    signal?.throwIfAborted();
    if (referenceClosed) throw new CodecError('Cancelled', 'Reference reader is closed');
  };
  signal?.addEventListener('abort', releaseReference, { once: true });

  return {
    frame,
    async read(capacity) {
      if (cursor === count) return null;
      const size = Math.min(capacity, count - cursor);
      const result = await readRange(cursor, size);
      cursor += size;
      return result;
    },
    async row(index) {
      assertReferenceOpen();
      // Keep the first preview row small, and preserve the direct path for rows wider than the window.
      if (rowsPerWindow === 0 || !Number.isInteger(index) || index < 1 || index >= height) {
        const pixels = await readRange(index * width, width);
        assertReferenceOpen();
        return pixels;
      }
      while (!referenceWindow || index < referenceWindow.firstRow || index >= referenceWindow.firstRow + referenceWindow.count) {
        if (!loading) {
          // Release the old byte buffer before starting its replacement. Concurrent callers share this load.
          referenceWindow = undefined;
          loading = (async () => {
            const count = Math.min(rowsPerWindow, height - index);
            const first = position + index * rowBytes;
            const end = first + count * rowBytes;
            const buffer = await file.slice(first, end).arrayBuffer();
            assertReferenceOpen();
            referenceWindow = { firstRow: index, count, bytes: new Uint8Array(buffer) };
          })().finally(() => { loading = undefined; });
        }
        await loading;
        assertReferenceOpen();
      }
      const offset = (index - referenceWindow.firstRow) * rowBytes;
      const bytes = referenceWindow.bytes;
      return materialize(bytes.subarray(offset, offset + rowBytes), width);
    },
    closeReference() {
      releaseReference();
      signal?.removeEventListener('abort', releaseReference);
    },
  };
}

export function pgmHeader(frame) {
  return new TextEncoder().encode(`P5\n${frame.width} ${frame.height}\n${sampleMaximum(frame)}\n`);
}

export function pgmRow(samples, frame) {
  if (sampleByteWidth(sampleMaximum(frame)) === 1) return Uint8Array.from(samples);
  const row = new Uint8Array(samples.length * 2);
  for (let i = 0, p = 0; i < samples.length; i++, p += 2) {
    const s = samples[i];
    row[p] = s >> 8;
    row[p + 1] = s & 255;
  }
  return row;
}

export function samplePgm() {
  const width = 400;
  const height = 260;
  const raster = new Uint8Array(width * height * 2);
  const view = new DataView(raster.buffer);
  let seed = 0x116e7a53;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
      const distance = Math.hypot(x - width / 2, (y - height / 2) * 1.2);
      const bands = 0.5 + 0.27 * Math.sin(distance / 11) + 0.18 * Math.sin((x + y) / 36);
      const texture = ((seed >>> 22) - 512) * (x > width * 0.7 ? 2.4 : 0.18);
      const sample = Math.max(0, Math.min(65535, Math.round(bands * 65535 + texture)));
      view.setUint16((y * width + x) * 2, sample, false);
    }
  }
  view.setUint16(0, 0, false);
  view.setUint16(2, 65535, false);
  return new File([pgmHeader({ width, height, bits: 16 }), raster], 'ripple-16.pgm', { type: 'image/x-portable-graymap' });
}
