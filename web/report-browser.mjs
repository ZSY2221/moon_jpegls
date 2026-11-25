import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chromium } from 'playwright-core';

const origin = process.env.MOONJLS_WEB_URL ?? 'http://127.0.0.1:8000';
const fixturePath = process.env.MOONJLS_LOLA ?? '.evidence/real/lola.pgm';
const receiptPath = process.env.MOONJLS_REPORT_RECEIPT;
const executablePath = process.env.MOONJLS_CHROME;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fixtureSha = '1adb4e047099b942c229a8d21d33b6227dd2b6af22984d8d9de6b128b0e858a6';
const fixture = await readFile(fixturePath);
assert.equal(hash(fixture), fixtureSha);

const browser = await chromium.launch(executablePath ? { executablePath } : { channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
const upload = (name, buffer) => page.locator('#file').setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
const select = (id, value) => page.locator(`#${id}`).selectOption(value);
const click = (id) => page.locator(`#${id}`).click();
const text = (id) => page.locator(`#${id}`).textContent();
const phase = (name) => page.waitForFunction((value) => document.querySelector('#status').dataset.state === value, name);
const hidden = (id) => page.locator(`#${id}`).evaluate((element) => element.hidden);
const reports = {};

async function download(id) {
  const event = page.waitForEvent('download');
  await click(id);
  const file = await event;
  return { name: file.suggestedFilename(), bytes: await readFile(await file.path()) };
}

async function exported(name) {
  const file = await download('export-report');
  const report = JSON.parse(file.bytes.toString('utf8'));
  assert.equal(file.name, `moonjls-${report.runId}.json`);
  assert.equal(report.schemaVersion, 'moonjls.verification/1');
  assert.equal(report.host, 'workbench');
  assert.equal(report.reference.status, 'not_run');
  assert.ok(report.unexecuted.includes('independent_reference'));
  assert.match(report.source.revision, /^[a-f0-9]{40}$/);
  assert.equal(typeof report.source.dirty, 'boolean');
  const artifact = await page.request.get(`${origin}/sdk/generated/${report.artifact.name}`);
  assert.ok(artifact.ok());
  assert.equal(report.artifact.sha256, hash(await artifact.body()));
  reports[name] = report;
  return report;
}

function assertFile(info, name, bytes) {
  assert.equal(info.name, name);
  assert.equal(info.bytes, bytes.length);
  assert.equal(info.sha256, hash(bytes));
}

try {
  await page.goto(`${origin}/web/`);
  await upload('renamed-nasa.pgm', fixture);
  await select('near', '3');
  await select('backend', 'wasm-gc');
  await select('sink', 'buffered');
  await click('run');
  await phase('complete');
  await page.locator('#physical-budget').waitFor({ state: 'visible' });
  assert.equal(await text('physical-budget-value'), 'Codec-added elevation error ≤ 1.5 m · observed 1.5 m');
  await page.locator('#reconstruction').press('Enter');
  const integerPixel = await text('pixel');
  const physicalPixel = await text('pixel-physical');
  assert.equal(integerPixel, '(0, 0) · original 20000 · reconstructed 19999 · error 1');
  assert.equal(physicalPixel, 'Elevation 0 → -0.5 m · difference 0.5 m');

  const jls = await download('download');
  assert.equal(jls.bytes.length, 999_459);
  const roundTrip = await exported('nasaRoundTrip');
  assert.equal(roundTrip.status, 'passed');
  assert.equal(roundTrip.backend, 'wasm-gc');
  assert.deepEqual(roundTrip.stages, { encode: 'passed', decode: 'passed', compare: 'passed' });
  assert.deepEqual(roundTrip.samples, { total: 1_036_800, verified: 1_036_800, maxError: 3, errorBound: 3, unit: 'sample' });
  assertFile(roundTrip.input, 'renamed-nasa.pgm', fixture);
  assert.equal(roundTrip.input.provenance.pgmSha256, fixtureSha);
  assertFile(roundTrip.output, jls.name, jls.bytes);
  assert.equal(roundTrip.output.retained, true);
  assert.equal(roundTrip.output.complete, true);
  assert.deepEqual(roundTrip.physical, { unit: 'm', quantity: 'codec_added_elevation_error', errorBound: 1.5, maxError: 1.5 });
  assert.equal(roundTrip.stream.rowsDelivered, 720);
  assert.equal(roundTrip.stream.provisionalRows, 0);
  assert.equal(roundTrip.stream.strictEoi, true);
  assert.equal(roundTrip.memory.decode.lastOutputQueueBytes, 0);

  await upload(jls.name, jls.bytes);
  await click('run');
  await phase('complete');
  assert.equal(await text('error'), 'Not compared');
  assert.equal(await hidden('physical-budget'), true);
  await page.locator('#reconstruction').press('Enter');
  assert.equal(await hidden('pixel-physical'), true);
  const pgm = await download('download');
  let maxError = 0;
  for (let offset = 18; offset < fixture.length; offset += 2) {
    maxError = Math.max(maxError, Math.abs(fixture.readUInt16BE(offset) - pgm.bytes.readUInt16BE(offset)));
  }
  assert.equal(pgm.bytes.length, fixture.length);
  assert.equal(pgm.bytes.readUInt16BE(18), 19999);
  assert.equal(maxError, 3);
  const decode = await exported('nasaDecodeOnly');
  assert.equal(decode.status, 'passed');
  assert.deepEqual(decode.stages, { encode: 'not_run', decode: 'passed', compare: 'not_run' });
  assert.equal(decode.samples.verified, null);
  assert.equal(decode.samples.maxError, null);
  assert.equal(decode.input.provenance, null);
  assert.equal(decode.physical, null);
  assertFile(decode.input, jls.name, jls.bytes);
  assertFile(decode.output, pgm.name, pgm.bytes);
  assert.equal(decode.frame.near, 3);
  assert.equal(decode.stream.strictEoi, true);

  const changed = Buffer.from(fixture);
  changed[changed.length - 1] ^= 1;
  await upload('lola.pgm', changed);
  await select('sink', 'bounded');
  await click('run');
  await phase('complete');
  assert.equal(await hidden('physical-budget'), true);
  await page.locator('#reconstruction').press('Enter');
  assert.equal(await hidden('pixel-physical'), true);
  const changedReport = await exported('sameSizeDifferentHash');
  assertFile(changedReport.input, 'lola.pgm', changed);
  assert.equal(changedReport.input.provenance, null);
  assert.equal(changedReport.physical, null);
  assert.equal(changedReport.output.sha256, null);
  assert.equal(changedReport.output.retained, false);

  const ordinary = Buffer.concat([Buffer.from('P5\n2 2\n255\n'), Buffer.from([0, 128, 254, 255])]);
  await upload('ordinary.pgm', ordinary);
  await select('near', '0');
  await select('backend', 'js');
  await click('run');
  await phase('complete');
  await page.locator('#reconstruction').press('Enter');
  assert.equal(await hidden('physical-budget'), true);
  assert.equal(await hidden('pixel-physical'), true);
  const plain = await exported('ordinaryRoundTrip');
  assertFile(plain.input, 'ordinary.pgm', ordinary);
  assert.equal(plain.backend, 'js');
  assert.equal(plain.input.provenance, null);
  assert.equal(plain.physical, null);
  assert.equal(plain.samples.verified, 4);
  assert.equal(plain.samples.maxError, 0);

  const tinyJls = Buffer.from(await page.evaluate(async () => {
    const { loadCore, encodeImage } = await import('/sdk/index.mjs');
    const core = await loadCore({ backend: 'js' });
    return [...(await encodeImage(core, { width: 1, height: 4, bits: 16, near: 0 }, new Uint16Array(4))).bytes];
  }));
  await page.evaluate(() => {
    let release;
    const hold = new Promise((resolve) => { release = resolve; });
    const gate = { waiting: false, release };
    globalThis.eoiGate = gate;
    const slice = File.prototype.slice;
    File.prototype.slice = function (start, end) {
      const part = slice.call(this, start, end);
      if (this.name === 'held.jls' && start === this.size - 2) {
        const read = part.arrayBuffer.bind(part);
        part.arrayBuffer = async () => { gate.waiting = true; await hold; return read(); };
      }
      return part;
    };
    document.getElementById('advanced').open = true;
  });
  await page.locator('#chunk').fill('1');
  await upload('held.jls', tinyJls);
  await click('run');
  await page.waitForFunction(() => globalThis.eoiGate.waiting);
  await phase('finalizing');
  assert.equal(await hidden('export-report'), true);
  await click('cancel');
  await phase('cancelled');
  const cancelled = await exported('cancelledBeforeEoi');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.error.code, 'Cancelled');
  assert.deepEqual(cancelled.stages, { encode: 'not_run', decode: 'cancelled', compare: 'not_run' });
  assert.equal(cancelled.stream.rowsDelivered, 4);
  assert.equal(cancelled.stream.provisionalRows, 4);
  assert.equal(cancelled.stream.strictEoi, false);
  assert.equal(cancelled.output.retained, false);
  await page.evaluate(() => globalThis.eoiGate.release());

  const trailing = Buffer.concat([tinyJls, Buffer.of(0)]);
  await upload('trailing.jls', trailing);
  await click('run');
  await phase('failed');
  const failure = await exported('failedWithTrailingByte');
  assert.equal(failure.status, 'failed');
  assert.equal(failure.error.code, 'TrailingData');
  assert.equal(failure.stages.decode, 'failed');
  assert.equal(failure.stream.rowsDelivered, 4);
  assert.equal(failure.stream.provisionalRows, 4);
  assert.equal(failure.stream.strictEoi, false);
  assert.equal(failure.output.retained, false);

  assert.deepEqual(pageErrors, []);
  const receipt = { status: 'passed', browser: browser.version(), node: process.version, integerPixel, physicalPixel, reports };
  if (receiptPath) {
    await mkdir(dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  }
  console.log(JSON.stringify({ ...receipt, reports: Object.keys(reports) }));
} finally {
  await browser.close();
}
