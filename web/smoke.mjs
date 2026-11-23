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
