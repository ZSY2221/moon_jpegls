import { CodecError } from '../sdk/index.mjs';

const maxHeader = 64 * 1024;
const whitespace = (byte) => byte === 32 || (byte >= 9 && byte <= 13);
const invalid = (message) => new CodecError('InvalidData', message);

export const sampleMaximum = (frame) => frame.maxval ?? (2 ** frame.bits - 1);
export const sampleByteWidth = (maxval) => maxval < 256 ? 1 : 2;

export async function readPnmHeader(file, expectedMagic = null) {
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
    if (position - start < 1 || position - start > 10) throw invalid('Invalid PNM header token');
    return new TextDecoder().decode(prefix.subarray(start, position));
  };
  const number = () => {
    const value = token();
    if (!/^\d+$/.test(value)) throw invalid('Expected an unsigned PNM header integer');
    return Number(value);
  };
  const magic = token();
  if (expectedMagic ? magic !== expectedMagic : (magic !== 'P5' && magic !== 'P6')) {
    throw invalid(`Expected binary ${expectedMagic ?? 'P5 PGM or P6 PPM'} file`);
  }
  const components = magic === 'P6' ? 3 : 1;
  const width = number();
  const height = number();
  const maxval = number();
  if (maxval < 1 || maxval > 65535) throw invalid('PNM MAXVAL must be in 1..65535');
  if (!whitespace(prefix[position])) throw invalid('PNM raster must follow a header separator');
  if (width < 1 || height < 1) throw invalid('PNM dimensions must be positive');
  if (width > 65535 || height > 65535) throw new CodecError('UnsupportedFeature', 'PNM dimensions exceed the JPEG-LS frame format');
  const bits = Math.max(2, 32 - Math.clz32(maxval));
  const sampleBytes = sampleByteWidth(maxval);
  const count = width * height * components;
  if (count > 100_000_000) throw new CodecError('ResourceLimit', 'Image sample count exceeds 100M pixel limit');
  if (prefix[position] === 13 && prefix[position + 1] === 10 && file.size === position + 2 + count * sampleBytes) position++;
  position++;
  if (position > maxHeader) throw new CodecError('ResourceLimit', 'PNM header exceeds 64 KiB');
  if (file.size !== position + count * sampleBytes) throw invalid('PNM raster byte length differs from the frame size');
  return { magic, components, width, height, bits, maxval, sampleBytes, count, position };
}

export async function openPpm(file, near, signal, preloadedHeader, channelRoles = ['R', 'G', 'B'], interleave = 0) {
  if (![0, 1, 2].includes(interleave)) throw new CodecError('InvalidArgument', 'Expected ILV 0, 1, or 2');
  const header = preloadedHeader ?? await readPnmHeader(file, 'P6');
  const { width, height, bits, maxval, sampleBytes, position } = header;
  const planePixels = width * height;
  const totalSamples = planePixels * 3;
  const componentSpecs = Object.freeze([
    Object.freeze({ id: 1, hSampling: 1, vSampling: 1 }),
    Object.freeze({ id: 2, hSampling: 1, vSampling: 1 }),
    Object.freeze({ id: 3, hSampling: 1, vSampling: 1 }),
  ]);
  const frame = {
    width,
    height,
    bits,
    near,
    ...(maxval !== 2 ** bits - 1 ? { maxval } : {}),
    components: componentSpecs,
    ...(interleave === 0 ? {} : { interleave }),
  };

  // Keep one original plane per component for reference rows and scan-order input.
  const rawBytes = new Uint8Array(await file.slice(position).arrayBuffer());
  signal?.throwIfAborted();
  if (rawBytes.byteLength !== totalSamples * sampleBytes) {
    throw invalid('PPM raster byte length differs from the frame size');
  }
  const planes = [new Uint16Array(planePixels), new Uint16Array(planePixels), new Uint16Array(planePixels)];
  const planeBytes = totalSamples * Uint16Array.BYTES_PER_ELEMENT;
  let hostConversionBufferBytes = rawBytes.byteLength + planeBytes;
  if (sampleBytes === 1) {
    for (let i = 0, p = 0; i < planePixels; i++, p += 3) {
      const r = rawBytes[p];
      const g = rawBytes[p + 1];
      const b = rawBytes[p + 2];
      if (maxval < 255 && (r > maxval || g > maxval || b > maxval)) throw invalid('PPM sample exceeds MAXVAL');
      planes[0][i] = r;
      planes[1][i] = g;
      planes[2][i] = b;
    }
  } else {
    for (let i = 0, p = 0; i < planePixels; i++, p += 6) {
      const r = (rawBytes[p] << 8) | rawBytes[p + 1];
      const g = (rawBytes[p + 2] << 8) | rawBytes[p + 3];
      const b = (rawBytes[p + 4] << 8) | rawBytes[p + 5];
      if (maxval < 65535 && (r > maxval || g > maxval || b > maxval)) throw invalid('PPM sample exceeds MAXVAL');
      planes[0][i] = r;
      planes[1][i] = g;
      planes[2][i] = b;
    }
  }

  let sampleCursor = 0;
  let closed = false;
  const closeReference = () => {
    closed = true;
  };
  signal?.addEventListener('abort', closeReference, { once: true });

  return {
    frame,
    planes,
    channelRoles: Object.freeze([...channelRoles]),
    get hostConversionBufferBytes() { return hostConversionBufferBytes; },
    async read(capacity) {
      signal?.throwIfAborted();
      if (sampleCursor === totalSamples) return null;
      if (interleave === 2) {
        const packed = new Uint16Array(Math.min(capacity, totalSamples - sampleCursor));
        for (let i = 0; i < packed.length; i++) {
          const index = sampleCursor + i;
          packed[i] = planes[index % 3][Math.floor(index / 3)];
        }
        sampleCursor += packed.length;
        hostConversionBufferBytes = Math.max(hostConversionBufferBytes, planeBytes + packed.byteLength);
        return packed;
      }

      const groupWidth = interleave === 0 ? planePixels : width;
      const group = Math.floor(sampleCursor / groupWidth);
      const positionInGroup = sampleCursor % groupWidth;
      const component = group % 3;
      const firstSample = interleave === 0 ? 0 : Math.floor(group / 3) * width;
      const take = Math.min(capacity, groupWidth - positionInGroup);
      const start = firstSample + positionInGroup;
      // The Worker may transfer the returned buffer. Keep the reference plane owned here.
      const packed = planes[component].slice(start, start + take);
      hostConversionBufferBytes = Math.max(hostConversionBufferBytes, planeBytes + packed.byteLength);
      sampleCursor += take;
      return packed;
    },
    async row(rowIndex, componentIndex = 0) {
      signal?.throwIfAborted();
      if (closed) throw new CodecError('Cancelled', 'Reference reader is closed');
      const plane = planes[componentIndex];
      return plane.subarray(rowIndex * width, (rowIndex + 1) * width);
    },
    closeReference() {
      closeReference();
      signal?.removeEventListener('abort', closeReference);
    },
  };
}

export function ppmHeader(frame) {
  return new TextEncoder().encode(`P6\n${frame.width} ${frame.height}\n${sampleMaximum(frame)}\n`);
}

export function encodePpmFromPlanes(frame, planes) {
  const { width, height } = frame;
  const planePixels = width * height;
  const maxval = sampleMaximum(frame);
  const wide = sampleByteWidth(maxval) === 2;
  const hdr = ppmHeader(frame);
  const body = new Uint8Array(planePixels * 3 * (wide ? 2 : 1));
  const [rPlane, gPlane, bPlane] = planes;
  if (!wide) {
    for (let i = 0, p = 0; i < planePixels; i++, p += 3) {
      body[p] = rPlane[i];
      body[p + 1] = gPlane[i];
      body[p + 2] = bPlane[i];
    }
  } else {
    for (let i = 0, p = 0; i < planePixels; i++, p += 6) {
      const r = rPlane[i];
      const g = gPlane[i];
      const b = bPlane[i];
      body[p] = r >> 8;
      body[p + 1] = r & 255;
      body[p + 2] = g >> 8;
      body[p + 3] = g & 255;
      body[p + 4] = b >> 8;
      body[p + 5] = b & 255;
    }
  }
  const out = new Uint8Array(hdr.length + body.length);
  out.set(hdr, 0);
  out.set(body, hdr.length);
  return { bytes: out, hostConversionBufferBytes: body.byteLength + out.byteLength };
}

export function sampleRgb8Ppm() {
  const width = 256;
  const height = 192;
  const raster = new Uint8Array(width * height * 3);
  let seed = 0x243f6a88;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
      const dx = (x - width * 0.5) / 48;
      const dy = (y - height * 0.5) / 48;
      const ring = 0.5 + 0.45 * Math.cos(Math.hypot(dx, dy) * 3.1);
      const stripe = ((x >> 4) + (y >> 4)) % 2 === 0;
      const r = Math.max(0, Math.min(255, Math.round(x * 255 / (width - 1) * 0.72 + ring * 70)));
      const g = Math.max(0, Math.min(255, Math.round(y * 255 / (height - 1) * 0.72 + (stripe ? 64 : 16))));
      const b = Math.max(0, Math.min(255, Math.round((1 - x / width) * 180 + ((seed >>> 26) & 63))));
      const p = (y * width + x) * 3;
      raster[p] = r;
      raster[p + 1] = g;
      raster[p + 2] = b;
    }
  }
  // Exact boundary corners for deterministic integer verification
  raster[0] = 0; raster[1] = 128; raster[2] = 255;
  raster[3] = 255; raster[4] = 64; raster[5] = 0;
  const hdr = new TextEncoder().encode(`P6\n${width} ${height}\n255\n`);
  const file = new File([hdr, raster], 'synthetic-rgb-8.ppm', { type: 'image/x-portable-pixmap' });
  file.moonjlsMeta = Object.freeze({ synthetic: true, channelRoles: ['R', 'G', 'B'], labelKey: 'sampleRgb8Desc' });
  return file;
}

export function sampleMulti16Ppm() {
  const width = 256;
  const height = 192;
  const raster = new Uint8Array(width * height * 6);
  const view = new DataView(raster.buffer);
  let seed = 0x9e3779b9;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
      const rad = Math.hypot((x - 128) / 36, (y - 96) / 36);
      const b0 = Math.max(0, Math.min(65535, Math.round((0.5 + 0.42 * Math.sin(rad * 2.2) + 0.08 * ((seed >>> 24) / 255)) * 65535)));
      const b1 = Math.max(0, Math.min(65535, Math.round((x / (width - 1) * 0.7 + (y % 24 < 12 ? 0.25 : 0.05)) * 65535)));
      const b2 = Math.max(0, Math.min(65535, Math.round(((1 - y / (height - 1)) * 0.65 + ((seed >>> 18) & 255) / 1024) * 65535)));
      const base = (y * width + x) * 6;
      view.setUint16(base, b0, false);
      view.setUint16(base + 2, b1, false);
      view.setUint16(base + 4, b2, false);
    }
  }
  // Exact >255 and full-range 0/65535 points at top-left coordinates
  view.setUint16(0, 65535, false); view.setUint16(2, 32768, false); view.setUint16(4, 1025, false);
  view.setUint16(6, 0, false); view.setUint16(8, 49151, false); view.setUint16(10, 65535, false);
  const hdr = new TextEncoder().encode(`P6\n${width} ${height}\n65535\n`);
  const file = new File([hdr, raster], 'synthetic-3comp-16.ppm', { type: 'image/x-portable-pixmap' });
  file.moonjlsMeta = Object.freeze({ synthetic: true, channelRoles: ['Band 0', 'Band 1', 'Band 2'], labelKey: 'sampleMulti16Desc' });
  return file;
}
