import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chromium } from 'playwright-core';

const origin = process.env.MOONJLS_WEB_URL ?? 'http://127.0.0.1:8000';
const executablePath = process.env.MOONJLS_CHROME;
const browser = await chromium.launch(executablePath ? { executablePath } : { channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, acceptDownloads: true });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error));

const status = (message) => page.waitForFunction((text) => document.querySelector('#status').textContent.includes(text), message);
const select = (id, value) => page.locator(`#${id}`).selectOption(value);
const click = (id) => page.locator(`#${id}`).click();
const upload = (name, buffer) => page.locator('#file').setInputFiles({ name, mimeType: 'application/octet-stream', buffer });

function smallPgm(samples) {
  const header = Buffer.from(`P5\n2 ${samples.length / 2}\n65535\n`);
  const bytes = Buffer.alloc(header.length + samples.length * 2);
  header.copy(bytes);
  samples.forEach((sample, index) => bytes.writeUInt16BE(sample, header.length + index * 2));
  return { bytes, headerLength: header.length };
}

async function cancelRestart(kind, oldStream) {
  const oldPgm = smallPgm([1000, 1000, 2000, 2000, 5000, 5000]);
  const expected = [3000, 3000, 4000, 4000];
  const nextPgm = smallPgm(expected);
  const oldName = kind === 'read' ? 'cancel-old.pgm' : 'cancel-old.jls';
  const nextName = `cancel-${kind}-new.pgm`;
  const nextRow = kind === 'read' ? 1 : 0;
  await page.goto(`${origin}/web/`);
  await page.evaluate(({ kind, oldName, nextName, oldStart, nextStart }) => {
    function barrier() {
      let resume;
      let settle;
      const wait = new Promise((resolve) => { resume = resolve; });
      const settled = new Promise((resolve) => { settle = resolve; });
      return {
        started: false,
        async hold(action) {
          this.started = true;
          await wait;
          try { return await action(); } finally { settle(); }
        },
        async release() {
          resume();
          await settled;
          await new Promise((resolve) => setTimeout(resolve, 0));
        },
      };
    }
    const old = barrier();
    const next = barrier();
    const writes = { called: 0, aborted: 0, closed: 0 };
    const slice = File.prototype.slice;
    File.prototype.slice = function (start, end, ...rest) {
      const part = slice.call(this, start, end, ...rest);
      if (end !== start + 4) return part;
      const gate = this.name === nextName && start === nextStart ? next
        : kind === 'read' && this.name === oldName && start === oldStart ? old : null;
      if (gate) {
        const read = part.arrayBuffer.bind(part);
        part.arrayBuffer = () => gate.hold(read);
      }
      return part;
    };
    if (kind === 'write') {
      globalThis.showSaveFilePicker = async () => ({
        createWritable: async () => ({
          async write() {
            writes.called++;
            if (writes.called === 1) await old.hold(() => {});
          },
          async abort() { writes.aborted++; },
          async close() { writes.closed++; },
        }),
      });
      document.querySelector('#sink option[value="file"]').disabled = false;
    }
    globalThis.cancelRegression = { old, next, writes };
  }, { kind, oldName, nextName, oldStart: oldPgm.headerLength + 4, nextStart: nextPgm.headerLength + nextRow * 4 });

  const waitForBarrier = (name) => page.waitForFunction((key) => globalThis.cancelRegression[key].started, name);
  const release = (name) => page.evaluate((key) => globalThis.cancelRegression[key].release(), name);
  const snapshot = () => page.evaluate(() => ({
    text: ['frame', 'encoded', 'ratio', 'error', 'latency', 'workspace', 'queues', 'status'].map((id) => document.getElementById(id).textContent),
    progress: document.getElementById('progress').value,
    downloadHidden: document.getElementById('download').hidden,
    reconstruction: document.getElementById('reconstruction').toDataURL(),
  }));

  await upload(oldName, kind === 'read' ? oldPgm.bytes : oldStream);
  await page.locator('#chunk').fill('4096');
  if (kind === 'read') await select('near', '0');
  await select('sink', kind === 'read' ? 'bounded' : 'file');
  await click('run');
  await waitForBarrier('old');
  await click('cancel');
  await status('Cancelled');
  assert.equal(await page.locator('#download').isVisible(), false);

  await upload(nextName, nextPgm.bytes);
  await select('near', '0');
  await select('sink', 'buffered');
  await click('run');
  await waitForBarrier('next');
  const before = await snapshot();
  assert.match(before.text[0], /2 × 2 · 16-bit · NEAR 0/);
  await release('old');
  assert.deepEqual(await snapshot(), before, `Old ${kind} changed the active job`);
  if (kind === 'write') {
    assert.deepEqual(await page.evaluate(() => globalThis.cancelRegression.writes), { called: 1, aborted: 1, closed: 0 });
  }
  await release('next');
  await status('Complete');
  assert.equal(await page.locator('#progress').evaluate((element) => element.value), 2);
  assert.equal(await page.locator('#error').textContent(), '0');
  const canvas = page.locator('#reconstruction');
  const point = await canvas.evaluate((element) => ({
    x: element.clientWidth / 4, y: element.clientHeight * 3 / 4,
  }));
  await canvas.click({ position: point });
  assert.match(await page.locator('#pixel').textContent(), /original 4000 · reconstructed 4000 · error 0/);

  const pendingDownload = page.waitForEvent('download');
  await click('download');
  const download = await pendingDownload;
  assert.equal(download.suggestedFilename(), nextName.replace(/\.pgm$/, '.jls'));
  const downloaded = await readFile(await download.path());
  const reconstructed = await page.evaluate(async (bytes) => {
    const { loadCore, decodeImage } = await import('/sdk/index.mjs');
    const core = await loadCore({ backend: 'js' });
    return [...(await decodeImage(core, Uint8Array.from(bytes))).samples];
  }, [...downloaded]);
  assert.deepEqual(reconstructed, expected);
  console.log(JSON.stringify({ test: 'browser cancel/restart with pending host operation', blocked: kind, newPixel: 4000, reconstructed, download: download.suggestedFilename() }));
}

try {
  await page.goto(`${origin}/web/`);
  await click('example');
  await select('near', '3');
  await click('run');
  await status('Complete');
  assert.match(await page.locator('#frame').textContent(), /400 × 260 · 16-bit · NEAR 3/);
  assert.equal(Number(await page.locator('#error').textContent()), 3);
  await page.locator('#original').click();
  const pixel = /original (\d+) · reconstructed (\d+) · error (\d+)/.exec(await page.locator('#pixel').textContent());
  assert.ok(pixel && Number(pixel[1]) > 255);
  assert.equal(Math.abs(Number(pixel[1]) - Number(pixel[2])), Number(pixel[3]));
  if (process.env.MOONJLS_SCREENSHOT) {
    await mkdir(dirname(process.env.MOONJLS_SCREENSHOT), { recursive: true });
    await page.screenshot({ path: process.env.MOONJLS_SCREENSHOT, fullPage: true });
  }

  const jlsDownload = page.waitForEvent('download');
  await click('download');
  const byteStream = await readFile(await (await jlsDownload).path());
  assert.equal(byteStream.readUInt16BE(0), 0xffd8);
  assert.equal(byteStream.readUInt16BE(byteStream.length - 2), 0xffd9);
  console.log(JSON.stringify({ test: 'browser sample round-trip', backend: 'wasm-gc', encodedBytes: byteStream.length, maxError: 3 }));

  await upload('round-trip.jls', byteStream);
  await select('backend', 'js');
  await click('run');
  await status('Reconstruction complete');
  const pgmDownload = page.waitForEvent('download');
  await click('download');
  const pgm = await readFile(await (await pgmDownload).path());
  const pgmHeader = Buffer.from('P5\n400 260\n65535\n');
  assert.deepEqual(pgm.subarray(0, pgmHeader.length), pgmHeader);
  assert.equal(pgm.length, pgmHeader.length + 400 * 260 * 2);
  assert.ok(pgm.readUInt16BE(pgmHeader.length) <= 3);
  assert.ok(pgm.readUInt16BE(pgmHeader.length + 2) >= 65532);
  console.log(JSON.stringify({ test: 'browser decoded PGM download', backend: 'js', pgmBytes: pgm.length }));

  await upload('broken.jls', byteStream.subarray(0, byteStream.length - 1));
  await select('sink', 'bounded');
  await click('run');
  await status('Truncated');
  await upload('unsupported.pgm', Buffer.from('P5\n1 1\n63\n\0'));
  await click('run');
  await status('UnsupportedFeature');
  console.log(JSON.stringify({ test: 'browser malformed/unsupported status', cases: 2 }));

  await click('example');
  await page.locator('#chunk').fill('1024');
  await click('run');
  await status('Complete');
  assert.equal(await page.locator('#download').isVisible(), false);
  assert.equal(await page.locator('#error').textContent(), '3');
  await select('language', 'zh');
  await status('已完成');
  await select('language', 'en');
  console.log(JSON.stringify({ test: 'browser bounded verification and locale switch', inputChunkSize: 1024 }));

  await click('example');
  await page.locator('#chunk').fill('1');
  await click('run');
  await click('pause');
  await status('Paused');
  await click('cancel');
  await status('Cancelled');
  console.log(JSON.stringify({ test: 'browser UI pause and cancel', inputChunkSize: 1 }));

  await cancelRestart('read', byteStream);
  await cancelRestart('write', byteStream);

  const flow = await page.evaluate(async () => {
    const { loadCore, encodeImage } = await import('/sdk/index.mjs');
    const { startWorker } = await import('/sdk/worker-client.mjs');
    const core = await loadCore({ backend: 'wasm-gc' });
    const expected = Uint16Array.of(0, 32767, 65535, 32768, 42, 7, 32, 0);
    const { bytes } = await encodeImage(core, { width: 4, height: 2, bits: 16, near: 0 }, expected);
    let reads = 0;
    let offset = 0;
    const rows = [];
    let release;
    let firstRow;
    const hold = new Promise((resolve) => { release = resolve; });
    const ready = new Promise((resolve) => { firstRow = resolve; });
    const job = startWorker({
      mode: 'decode', backend: 'wasm-gc', inputChunkSize: 1,
      read() { reads++; return offset === bytes.length ? null : bytes.subarray(offset, ++offset); },
      async onEvent(event) {
        if (event.type !== 'row') return;
        if (!(event.row instanceof Uint16Array)) throw new Error('Row lost Uint16Array type');
        rows.push(...event.row);
        if (event.index === 0) {
          firstRow(event.stats.outputQueueBytes);
          await hold;
        }
      },
    });
    const queue = await Promise.race([ready, job.result.then(() => { throw new Error('No row delivered'); })]);
    const before = reads;
    await new Promise((resolve) => setTimeout(resolve, 40));
    const whileHeld = reads;
    job.pause();
    release();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const whilePaused = reads;
    job.resume();
    const result = await job.result;
    return { before, whileHeld, whilePaused, queue, reads, rows, expected: [...expected], stats: result.stats };
  });
  assert.deepEqual(flow.rows, flow.expected);
  assert.equal(flow.before, flow.whileHeld);
  assert.equal(flow.before, flow.whilePaused);
  assert.ok(flow.reads > flow.before);
  assert.equal(flow.stats.inputPeakBytes, 1);
  assert.equal(flow.queue, 8);
  assert.equal(flow.stats.outputPeakBytes, 8);
  console.log(JSON.stringify({ test: 'worker ACK, manual resume and one-byte reads', ...flow }));

  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ status: 'passed', browser: browser.version(), node: process.version }));
} finally {
  await browser.close();
}
