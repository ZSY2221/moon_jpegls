import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPgm, pgmHeader, pgmRow } from './pgm.mjs';

function fixture(width, height, bits, { crlf = false, maxval = (1 << bits) - 1, offset = 0 } = {}) {
  const eol = crlf ? '\r\n' : '\n';
  const header = Buffer.from(['P5', '# keep the raster offset correct', `${width} ${height}`, maxval].join(eol) + eol);
  const sampleBytes = maxval < 256 ? 1 : 2;
  const raster = Buffer.alloc(width * height * sampleBytes);
  const edges = [0, 255, 256, 4095, 65535].filter((sample) => sample <= maxval);
  const sampleAt = (index) => index < edges.length ? edges[index] : (index * 139 + offset) & maxval;
  for (let i = 0; i < width * height; i++) {
    if (sampleBytes === 1) raster[i] = sampleAt(i);
    else raster.writeUInt16BE(sampleAt(i), i * 2);
  }
  const file = new Blob([header, raster]);
  const calls = [];
  const barriers = new Map();
  let pending = 0;
  let concurrent = 0;
  return {
    file: {
      name: 'reader.pgm', size: file.size,
      slice(first, end) {
        const part = file.slice(first, end);
        return { async arrayBuffer() {
          calls.push({ first, bytes: part.size });
          pending++;
          concurrent = Math.max(concurrent, pending);
          try {
            if (barriers.has(first)) await barriers.get(first);
            return await part.arrayBuffer();
          } finally { pending--; }
        } };
      },
    },
    calls,
    get concurrent() { return concurrent; },
    rowBytes: width * sampleBytes,
    rasterOffset: header.length,
    expected(start, count) { return Uint16Array.from({ length: count }, (_, index) => sampleAt(start + index)); },
    holdRow(index) {
      let release;
      const hold = new Promise((resolve) => { release = resolve; });
      barriers.set(header.length + index * width * sampleBytes, hold);
      return release;
    },
  };
}

test('PGM P5 retains 8-, 12- and 16-bit samples including CRLF and big-endian boundaries', async () => {
  for (const bits of [8, 12, 16]) {
    const image = fixture(9, 5, bits, { crlf: true });
    const reader = await openPgm(image.file, 0);
    assert.deepEqual(reader.frame, { width: 9, height: 5, bits, near: 0 });
    assert.deepEqual(await reader.row(0), image.expected(0, 9));
    assert.deepEqual(await reader.row(1), image.expected(9, 9));
    assert.deepEqual(await reader.read(6), image.expected(0, 6));
    assert.deepEqual(await reader.row(4), image.expected(36, 9));
    assert.deepEqual(await reader.read(400), image.expected(6, 39));
    assert.equal(await reader.read(1), null);
    reader.closeReference();
  }
  const image = fixture(9, 5, 16, { crlf: true });
  // Minus one could be a CR separator followed by an initial LF raster byte.
  await assert.rejects(openPgm({ ...image.file, size: image.file.size - 2 }, 0), { code: 'InvalidData' });
});

test('PGM preserves custom MAXVAL and chooses storage width independently', async () => {
  for (const [bits, maxval] of [[2, 1], [6, 57], [9, 256], [12, 4094]]) {
    const image = fixture(9, 5, bits, { maxval });
    const reader = await openPgm(image.file, 0);
    assert.deepEqual(reader.frame, { width: 9, height: 5, bits, near: 0, maxval });
    assert.deepEqual(await reader.row(1), image.expected(9, 9));
    assert.equal(pgmRow(Uint16Array.of(maxval), reader.frame).length, maxval < 256 ? 1 : 2);
    assert.equal(Buffer.from(pgmHeader(reader.frame)).toString(), `P5\n9 5\n${maxval}\n`);
    reader.closeReference();
  }
  const invalidMaxval = new Blob([Buffer.from('P5\n1 1\n65536\n'), Buffer.from([0])]);
  await assert.rejects(openPgm(invalidMaxval, 0), { code: 'InvalidData' });
  const invalidSample = new Blob([Buffer.from('P5\n1 1\n63\n'), Buffer.from([64])]);
  const reader = await openPgm(invalidSample, 0);
  await assert.rejects(reader.read(1), { code: 'InvalidData' });
});

test('Reference windows hit, replace and clip by whole row without moving the encoding cursor', async () => {
  const width = 513;
  const image = fixture(width, 130, 16);
  const reader = await openPgm(image.file, 3);
  const callsAfterHeader = image.calls.length;
  const first = await reader.row(0);
  assert.deepEqual(first, image.expected(0, width));
  assert.equal(image.calls.at(-1).bytes, image.rowBytes);
  assert.deepEqual(await reader.read(7), image.expected(0, 7));

  const windowRows = Math.floor(65_536 / image.rowBytes);
  const retained = await reader.row(1);
  const snapshot = retained.slice();
  const firstLoad = { first: image.rasterOffset + image.rowBytes, bytes: windowRows * image.rowBytes };
  assert.deepEqual(image.calls.at(-1), firstLoad);
  const calls = image.calls.length;
  const repeated = await reader.row(1);
  assert.deepEqual(repeated, snapshot);
  assert.notEqual(repeated.buffer, retained.buffer);
  assert.deepEqual(await reader.row(windowRows), image.expected(windowRows * width, width));
  assert.equal(image.calls.length, calls);

  const nextRow = windowRows + 1;
  assert.deepEqual(await reader.row(nextRow), image.expected(nextRow * width, width));
  assert.equal(image.calls.at(-1).first, image.rasterOffset + nextRow * image.rowBytes);
  assert.deepEqual(await reader.row(128), image.expected(128 * width, width));
  assert.deepEqual(image.calls.at(-1), { first: image.rasterOffset + 128 * image.rowBytes, bytes: 2 * image.rowBytes });
  assert.deepEqual(await reader.row(129), image.expected(129 * width, width));
  assert.deepEqual(await reader.row(1), snapshot);
  assert.deepEqual(image.calls.at(-1), firstLoad);
  assert.deepEqual(retained, snapshot);
  assert.deepEqual(await reader.read(8), image.expected(7, 8));
  assert.ok(image.calls.slice(callsAfterHeader).every(({ bytes }) => bytes <= 65_536));
  reader.closeReference();
});

test('A row wider than 64 KiB uses the existing uncached read', async () => {
  const width = 32_769;
  const image = fixture(width, 3, 16);
  const reader = await openPgm(image.file, 0);
  const calls = image.calls.length;
  const first = await reader.row(1);
  const repeated = await reader.row(1);
  assert.deepEqual(first, image.expected(width, width));
  assert.deepEqual(repeated, first);
  assert.notEqual(repeated.buffer, first.buffer);
  assert.deepEqual(image.calls.slice(calls), Array(2).fill({ first: image.rasterOffset + image.rowBytes, bytes: image.rowBytes }));
  assert.ok(image.rowBytes > 65_536);
  reader.closeReference();
});

test('Concurrent reference requests share at most one physical window load', { timeout: 5000 }, async () => {
  const width = 513;
  const image = fixture(width, 140, 16);
  const reader = await openPgm(image.file, 0);
  const release = image.holdRow(1);
  const calls = image.calls.length;
  const pending = Promise.all([reader.row(1), reader.row(2), reader.row(100)]);
  try {
    await Promise.resolve();
    assert.equal(image.calls.length - calls, 1);
  } finally {
    release();
  }
  const rows = await pending;
  assert.equal(image.concurrent, 1);
  for (const [slot, index] of [1, 2, 100].entries()) assert.deepEqual(rows[slot], image.expected(index * width, width));
  assert.equal(new Set(rows.map((row) => row.buffer)).size, rows.length);
  reader.closeReference();
});

test('A released old window cannot trigger another read after cancellation and restart', { timeout: 5000 }, async () => {
  const width = 513;
  const old = fixture(width, 100, 16);
  const controller = new AbortController();
  const reader = await openPgm(old.file, 0, controller.signal);
  const release = old.holdRow(1);
  const reads = old.calls.length;
  const waiting = Promise.all([assert.rejects(reader.row(1), { name: 'AbortError' }), assert.rejects(reader.row(80), { name: 'AbortError' })]);
  try {
    await Promise.resolve();
    assert.equal(old.calls.length - reads, 1);
    controller.abort();
    reader.closeReference();
    const replacement = fixture(width, 100, 16, { offset: 901 });
    const next = await openPgm(replacement.file, 0);
    const nextRow = await next.row(1);
    assert.deepEqual(nextRow, replacement.expected(width, width));
    release();
    await waiting;
    assert.equal(old.calls.length - reads, 1);
    assert.notDeepEqual(nextRow, old.expected(width, width));
    assert.deepEqual(await next.row(1), nextRow);
    await assert.rejects(reader.row(20), { name: 'AbortError' });
    next.closeReference();
    await assert.rejects(next.row(2), { code: 'Cancelled' });
  } finally {
    release();
  }
});
