import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chromium } from 'playwright-core';

const origin = process.env.MOONJLS_WEB_URL ?? 'http://127.0.0.1:8000';
const executablePath = process.env.MOONJLS_CHROME;
const browser = await chromium.launch(executablePath ? { executablePath } : { channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error));
const consoleErrors = [];
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
const loaded = new Map();
const receiptPath = process.env.MOONJLS_SMOKE_RECEIPT;
const expectReferenceWindow = process.env.MOONJLS_EXPECT_REFERENCE_WINDOW === '1';
if (receiptPath) {
  page.context().on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin !== origin || !/\.(mjs|wasm|css)$/.test(url.pathname) || !response.ok() || loaded.has(url.pathname)) return;
    loaded.set(url.pathname, response.body().then(
      (body) => ({ sha256: createHash('sha256').update(body).digest('hex'), bytes: body.byteLength }),
      (error) => ({ error: error.message }),
    ));
  });
}

const status = (message) => page.waitForFunction((text) => document.querySelector('#status').textContent.includes(text), message);
const phase = (name) => page.waitForFunction((value) => document.querySelector('#status').dataset.state === value, name);
const select = (id, value) => page.locator(`#${id}`).selectOption(value);
const click = (id) => page.locator(`#${id}`).click();
const upload = (name, buffer) => page.locator('#file').setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
const text = (id) => page.locator(`#${id}`).textContent();
async function chunkSize(value) {
  await page.locator('#advanced').evaluate((details) => { details.open = true; });
  await page.locator('#chunk').fill(value);
}

async function capture(name) {
  const directory = process.env.MOONJLS_PRESENTATION_SCREENSHOTS;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/${name}.png` });
}

function smallPgm(samples) {
  const header = Buffer.from(`P5\n2 ${samples.length / 2}\n65535\n`);
  const bytes = Buffer.alloc(header.length + samples.length * 2);
  header.copy(bytes);
  samples.forEach((sample, index) => bytes.writeUInt16BE(sample, header.length + index * 2));
  return { bytes, headerLength: header.length };
}

async function cancelRestart(kind, oldStream, oldNear = 0) {
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
    const reads = { old: [], next: [] };
    const slice = File.prototype.slice;
    File.prototype.slice = function (start, end, ...rest) {
      const part = slice.call(this, start, end, ...rest);
      const length = end - start;
      const owner = this.name === nextName && start === nextStart && length === 4 ? 'next'
        : kind === 'read' && this.name === oldName && start === oldStart && (length === 4 || length === 8) ? 'old' : null;
      const gate = owner === 'next' ? next : owner === 'old' ? old : null;
      if (gate) {
        const read = part.arrayBuffer.bind(part);
        part.arrayBuffer = () => {
          reads[owner].push({ start, end, bytes: length });
          return gate.hold(read);
        };
      }
      return part;
    };
    if (kind !== 'read') {
      globalThis.showSaveFilePicker = async () => ({
        createWritable: async () => ({
          async write() {
            writes.called++;
            if (kind === 'write' && writes.called === 1) await old.hold(() => {});
          },
          async abort() { writes.aborted++; },
          async close() {
            writes.closed++;
            if (kind === 'close') await old.hold(() => {});
          },
        }),
      });
      document.querySelector('#sink option[value="file"]').disabled = false;
    }
    globalThis.cancelRegression = { old, next, reads, writes };
  }, { kind, oldName, nextName, oldStart: oldPgm.headerLength + 4, nextStart: nextPgm.headerLength + nextRow * 4 });

  const waitForBarrier = (name) => page.waitForFunction((key) => globalThis.cancelRegression[key].started, name);
  const release = (name) => page.evaluate((key) => globalThis.cancelRegression[key].release(), name);
  const snapshot = () => page.evaluate(() => ({
    text: ['frame', 'encoded', 'ratio', 'error', 'latency', 'workspace', 'queues', 'status', 'task-id', 'preview-state'].map((id) => document.getElementById(id).textContent),
    progress: document.getElementById('progress').value,
    downloadHidden: document.getElementById('download').hidden,
    reconstruction: document.getElementById('reconstruction').toDataURL(),
  }));

  await upload(oldName, kind === 'read' ? oldPgm.bytes : oldStream);
  await chunkSize('4096');
  if (kind === 'read') await select('near', String(oldNear));
  await select('sink', kind === 'read' ? 'bounded' : 'file');
  await click('run');
  await waitForBarrier('old');
  if (kind === 'read') assert.equal(await text('frame'), `2 × 3 · 16-bit · NEAR ${oldNear}`);
  await click('cancel');
  await phase('cancelled');
  assert.equal(await text('preview-state'), 'Incomplete');
  assert.equal(await page.locator('#download').isVisible(), false);

  await upload(nextName, nextPgm.bytes);
  await select('near', '0');
  await select('sink', 'buffered');
  await click('run');
  await waitForBarrier('next');
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const before = await snapshot();
  assert.match(before.text[0], /2 × 2 · 16-bit · NEAR 0/);
  await release('old');
  assert.deepEqual(await snapshot(), before, `Old ${kind} changed the active job`);
  const reads = await page.evaluate(() => globalThis.cancelRegression.reads);
  assert.deepEqual(reads.next, [{ start: nextPgm.headerLength + nextRow * 4, end: nextPgm.headerLength + (nextRow + 1) * 4, bytes: 4 }]);
  if (kind === 'write') {
    assert.deepEqual(await page.evaluate(() => globalThis.cancelRegression.writes), { called: 1, aborted: 1, closed: 0 });
  } else if (kind === 'close') {
    const writes = await page.evaluate(() => globalThis.cancelRegression.writes);
    assert.ok(writes.called > 1);
    assert.equal(writes.aborted, 1);
    assert.equal(writes.closed, 1);
  } else {
    assert.equal(reads.old.length, 1);
    assert.equal(reads.old[0].start, oldPgm.headerLength + 4);
    if (expectReferenceWindow) assert.equal(reads.old[0].bytes, 8, 'Expected a two-row reference window pending at cancel');
  }
  await release('next');
  await phase('complete');
  assert.equal(await page.locator('#progress').evaluate((element) => element.value), 2);
  assert.equal(await page.locator('#error').textContent(), '0');
  const canvas = page.locator('#reconstruction');
  const point = await canvas.evaluate((element) => {
    const scale = Math.min(element.clientWidth / element.width, element.clientHeight / element.height);
    const width = element.width * scale, height = element.height * scale;
    return { x: (element.clientWidth - width) / 2 + width / 4, y: (element.clientHeight - height) / 2 + 3 * height / 4 };
  });
  await canvas.click({ position: point });
  assert.match(await page.locator('#pixel').textContent(), /original 4000 · reconstructed 4000 · error 0/);
  assert.equal(await text('inspect-original'), '4,000');
  assert.equal(await text('inspect-reconstructed'), '4,000');
  assert.equal(await text('inspect-error'), '0');

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
  console.log(JSON.stringify({ test: 'browser cancel/restart with pending host operation', blocked: kind,
    oldNear: kind === 'read' ? oldNear : undefined, reads, newPixel: 4000, reconstructed, download: download.suggestedFilename() }));
}

async function gatedEnding() {
  await page.goto(`${origin}/web/`);
  const stream = Buffer.from(await page.evaluate(async () => {
    const { loadCore, encodeImage } = await import('/sdk/index.mjs');
    const core = await loadCore({ backend: 'wasm-gc' });
    return [...(await encodeImage(core, { width: 1, height: 4, near: 0, bits: 16 }, new Uint16Array(4))).bytes];
  }));
  assert.equal(stream.readUInt16BE(stream.length - 2), 0xffd9);
  await page.evaluate(() => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    globalThis.endingGate = { pending: false, release };
    const slice = File.prototype.slice;
    File.prototype.slice = function (start, end, ...rest) {
      const bytes = slice.call(this, start, end, ...rest);
      if (this.name === 'eoi-held.jls' && start === this.size - 2) {
        const read = bytes.arrayBuffer.bind(bytes);
        bytes.arrayBuffer = async () => { endingGate.pending = true; await held; return read(); };
      }
      return bytes;
    };
  });
  await upload('eoi-held.jls', stream);
  await chunkSize('1');
  await click('run');
  await page.waitForFunction(() => endingGate.pending);
  await phase('finalizing');
  assert.deepEqual(await page.locator('#progress').evaluate((element) => [element.value, element.max]), [4, 4]);
  assert.match(await text('progress-copy'), /4 \/ 4 rows received · provisional/);
  assert.equal(await text('preview-state'), 'Provisional');
  assert.equal(await text('error'), 'Not compared');
  assert.equal(await page.locator('#download').isVisible(), false);
  const alpha = await page.locator('#reconstruction').evaluate((canvas) => canvas.getContext('2d').getImageData(0, 3, 1, 1).data[3]);
  assert.equal(alpha, 255, 'Last provisional row should have rendered while EOI is still missing');
  await page.evaluate(() => endingGate.release());
  await phase('complete');
  assert.equal(await text('preview-state'), 'Stream verified');
  assert.equal(await page.locator('#download').isVisible(), true);
  console.log(JSON.stringify({ test: 'four preview rows provisional before withheld EOI', before: 4, afterRelease: 'complete' }));
}

async function gatedClose(fail) {
  await page.goto(`${origin}/web/`);
  await page.evaluate(() => {
    let resolveClose;
    const held = new Promise((resolve) => { resolveClose = resolve; });
    globalThis.outputGate = { bytes: 0, closeAt: null, release: resolveClose };
    globalThis.showSaveFilePicker = async () => ({ createWritable: async () => ({
      write(bytes) { outputGate.bytes += bytes.length; },
      async close() {
        outputGate.closeAt = performance.now();
        if (await held) throw new DOMException('Controlled output-close failure', 'NotAllowedError');
      },
      abort() {},
    }) });
    document.querySelector('#sink option[value="file"]').disabled = false;
  });
  await click('example');
  await select('sink', 'file');
  await click('run');
  await page.waitForFunction(() => outputGate.closeAt !== null);
  await phase('finalizing');
  assert.match(await text('status'), /Finalizing output/);
  assert.equal(await text('latency'), '—');
  assert.equal(await text('preview-state'), 'Provisional');
  assert.equal(await page.locator('#download').isVisible(), false);
  if (!fail) await capture('finalizing');
  await page.waitForTimeout(80);
  const closeHeldMs = await page.evaluate((shouldFail) => {
    const elapsed = performance.now() - outputGate.closeAt;
    outputGate.release(shouldFail);
    return elapsed;
  }, fail);
  await phase(fail ? 'failed' : 'complete');
  assert.equal(await page.locator('#download').isVisible(), false);
  const elapsed = await text('latency');
  if (fail) {
    assert.match(await text('status'), /NotAllowedError.*Controlled output-close failure/);
    assert.equal(await text('preview-state'), 'Incomplete');
    assert.equal(elapsed, '—');
    await capture('failed');
  } else {
    assert.ok(Number.parseFloat(elapsed) + 0.05 >= closeHeldMs, 'In-page latency should include pending close');
  }
  console.log(JSON.stringify({ test: 'pending sink close gates success and page timer', fail, closeHeldMs, elapsed,
    bytesWritten: await page.evaluate(() => outputGate.bytes) }));
}

async function narrowSettingsSummary(jlsStream) {
  await page.setViewportSize({ width: 390, height: 844 });
  try {
    await page.goto(`${origin}/web/`);
    await click('example');
    await select('near', '0');
    await select('backend', 'wasm-gc');
    await select('sink', 'buffered');
    await click('run');
    await phase('complete');

    assert.equal(await page.locator('#settings-drawer').evaluate((el) => el.open), false);
    assert.equal(await text('settings-summary-meta'), 'NEAR 0 · Wasm GC · Buffered download');
    assert.equal(await text('task-meta'), 'Wasm GC · 16-bit · NEAR 0');
    assert.equal(await text('frame'), '400 × 260 · 16-bit · NEAR 0');
    assert.equal(await text('result-backend'), 'Wasm GC');
    assert.equal(await text('error'), '0');
    assert.equal(await text('inspect-near'), '0');

    await page.locator('#settings-drawer > summary').click();
    assert.equal(await page.locator('#settings-drawer').evaluate((el) => el.open), true);
    await select('near', '3');
    await select('backend', 'js');
    await select('sink', 'bounded');
    await page.locator('#settings-drawer > summary').click();
    assert.equal(await page.locator('#settings-drawer').evaluate((el) => el.open), false);

    // Summary reflects the upcoming run immediately while completed results stay bound to job #1.
    assert.equal(await text('settings-summary-meta'), 'NEAR 3 · JavaScript · Bounded verification');
    assert.equal(await text('task-meta'), 'Wasm GC · 16-bit · NEAR 0');
    assert.equal(await text('frame'), '400 × 260 · 16-bit · NEAR 0');
    assert.equal(await text('result-backend'), 'Wasm GC');
    assert.equal(await text('error'), '0');
    assert.equal(await text('inspect-near'), '0');

    await click('run');
    await phase('complete');
    assert.equal(await text('task-meta'), 'JavaScript · 16-bit · NEAR 3');
    assert.equal(await text('frame'), '400 × 260 · 16-bit · NEAR 3');
    assert.equal(await text('result-backend'), 'JavaScript');
    assert.equal(await text('error'), '3');
    assert.equal(await text('inspect-near'), '3');
    assert.equal(await page.locator('#download').isVisible(), false);

    // Standalone JLS decode: summary shows JLS + current form settings, while parsed header NEAR stays in task info.
    await upload('narrow-summary.jls', jlsStream);
    if (!(await page.locator('#settings-drawer').evaluate((el) => el.open))) {
      await page.locator('#settings-drawer > summary').click();
    }
    await select('backend', 'wasm-gc');
    await select('sink', 'buffered');
    await click('run');
    await phase('complete');
    assert.equal(await text('settings-summary-meta'), 'JLS · Wasm GC · Buffered download');
    assert.equal(await text('task-meta'), 'Wasm GC · 16-bit · NEAR 3');
    assert.equal(await text('inspect-near'), '3');

    await page.locator('#settings-drawer > summary').click();
    await select('backend', 'js');
    await select('sink', 'bounded');
    await page.locator('#settings-drawer > summary').click();
    assert.equal(await text('settings-summary-meta'), 'JLS · JavaScript · Bounded verification');
    assert.equal(await text('task-meta'), 'Wasm GC · 16-bit · NEAR 3');
    assert.equal(await text('inspect-near'), '3');

    console.log(JSON.stringify({
      test: 'narrow settings summary tracks form changes without altering completed results',
      viewport: [390, 844],
      pgmUpdatedSummary: 'NEAR 3 · JavaScript · Bounded verification',
      jlsUpdatedSummary: 'JLS · JavaScript · Bounded verification',
    }));
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
}

async function expandedNear() {
  await page.goto(`${origin}/web/`);
  const rejected = await page.evaluate(async () => {
    const { loadCore } = await import('/sdk/index.mjs');
    const invalid = [[8, 128], [12, 256], [16, 256], [16, -1], [16, 1.5], [16, '4']];
    return Promise.all(['js', 'wasm-gc'].map(async (backend) => {
      const core = await loadCore({ backend });
      return { backend, cases: invalid.map(([bits, near]) => {
        try {
          core.createEncoder({ width: 1, height: 1, bits, near });
          return null;
        } catch (error) {
          return error.code;
        }
      }) };
    }));
  });
  for (const { cases } of rejected) assert.deepEqual(cases, Array(6).fill('InvalidArgument'));
  console.log(JSON.stringify({ test: 'browser SDK rejects invalid NEAR arguments', rejected }));

  const results = [];
  let encoded;
  for (const [bits, near, backend] of [[16, 4, 'wasm-gc'], [16, 255, 'wasm-gc'], [8, 127, 'js'], [12, 255, 'wasm-gc']]) {
    const maxval = 2 ** bits - 1;
    const limit = bits === 8 ? 127 : 255;
    const samples = [0, maxval, 12, 60, maxval - 1, 128, 75, maxval];
    const raster = Buffer.alloc(samples.length * (bits === 8 ? 1 : 2));
    samples.forEach((sample, index) => {
      if (bits === 8) raster[index] = sample;
      else raster.writeUInt16BE(sample, index * 2);
    });
    await upload(`expanded-${bits}.pgm`, Buffer.concat([Buffer.from(`P5\n4 2\n${maxval}\n`), raster]));
    await page.waitForFunction((limit) => {
      const input = document.getElementById('near');
      return !input.disabled && input.options.length === limit + 1;
    }, limit);
    assert.equal(await text('near-note'), `NEAR 0–${limit}`);
    if (bits === 8) assert.equal(await page.locator('#near').inputValue(), '127');
    await select('near', String(near));
    await select('backend', backend);
    await click('run');
    await phase('complete');
    assert.equal(await text('frame'), `4 × 2 · ${bits}-bit · NEAR ${near}`);
    const maxError = Number(await text('error'));
    assert.ok(maxError > 0 && maxError <= near);
    const legend = await page.locator('#error-legend-swatches .legend-chip-label').allTextContents();
    assert.deepEqual(legend, ['0 · exact', ...[1, 2, 3].map(index => `${Math.round(near * index / 4)} · in bound`), `${near} · NEAR limit`]);
    const pending = page.waitForEvent('download');
    await click('download');
    encoded = await readFile(await (await pending).path());
    const reconstructed = await page.evaluate(async (bytes) => {
      const { loadCore, decodeImage } = await import('/sdk/index.mjs');
      const core = await loadCore({ backend: 'js' });
      return [...(await decodeImage(core, Uint8Array.from(bytes))).samples];
    }, [...encoded]);
    const differences = samples.map((value, index) => Math.abs(value - reconstructed[index]));
    assert.equal(Math.max(...differences), maxError);
    const index = differences.indexOf(maxError);
    const x = index % 4;
    const y = Math.floor(index / 4);
    const canvas = page.locator('#reconstruction');
    await canvas.press('Enter');
    for (let step = 0; step < x; step++) await canvas.press('ArrowRight');
    if (y) await canvas.press('ArrowDown');
    assert.equal(await text('pixel'), `(${x}, ${y}) · original ${samples[index]} · reconstructed ${reconstructed[index]} · error ${maxError}`);
    assert.equal(await text('inspect-original'), samples[index].toLocaleString('en'));
    assert.equal(await text('inspect-reconstructed'), reconstructed[index].toLocaleString('en'));
    assert.equal(await text('inspect-error'), String(maxError));
    const heatmap = await page.evaluate(async ({ x, y, error, near }) => {
      const { errorColor } = await import('/web/preview.mjs');
      const { data } = document.getElementById('difference').getContext('2d').getImageData(x, y, 1, 1);
      return { rendered: [...data], expected: [...errorColor(error, near), 255] };
    }, { x, y, error: maxError, near });
    assert.deepEqual(heatmap.rendered, heatmap.expected);
    results.push({ bits, backend, near, maxError,
      pixel: { x, y, original: samples[index], reconstructed: reconstructed[index], rgba: heatmap.rendered } });
  }
  await upload('expanded-12.jls', encoded);
  assert.equal(await page.locator('#near').isDisabled(), true);
  assert.equal(await text('near-note'), 'NEAR from JLS header');
  await click('run');
  await phase('complete');
  assert.equal(await text('frame'), '4 × 2 · 12-bit · NEAR 255');
  assert.equal(await text('error'), 'Not compared');
  assert.equal(await page.locator('#error-legend-swatches .legend-chip').count(), 0);
  console.log(JSON.stringify({ test: 'browser precision-specific NEAR limits and calibrated legend', results }));
}

async function verifyLunarDownload(sourcePath) {
  const source = await readFile(sourcePath);
  const fingerprint = (value) => createHash('sha256').update(value).digest('hex');
  const fixtureSha256 = fingerprint(source);
  assert.equal(fixtureSha256, '1adb4e047099b942c229a8d21d33b6227dd2b6af22984d8d9de6b128b0e858a6');
  const header = Buffer.from('P5\n1440 720\n65535\n');
  assert.deepEqual(source.subarray(0, header.length), header);
  const download = async (name) => {
    const pending = page.waitForEvent('download');
    await click('download');
    const file = await pending;
    assert.equal(file.suggestedFilename(), name);
    return readFile(await file.path());
  };
  await page.goto(`${origin}/web/`);
  await upload('lola.pgm', source);
  await select('near', '3');
  await click('run');
  await phase('complete');
  assert.equal(await text('error'), '3');
  const jls = await download('lola.jls');
  await upload('lola.jls', jls);
  await click('run');
  await phase('complete');
  assert.equal(await text('error'), 'Not compared');
  const pgm = await download('lola.pgm');
  assert.deepEqual(pgm.subarray(0, header.length), header);
  assert.equal(pgm.length, source.length);
  const { createOracle } = await import('../scripts/oracle.mjs');
  const oracle = await createOracle();
  let maxError = 0;
  let samples = 0;
  try {
    const { pixels, frame } = oracle.decode(jls);
    assert.equal(frame.near, 3);
    assert.equal(pixels.length, 1440 * 720);
    for (let offset = header.length; offset < source.length; offset += 2) {
      const sample = pgm.readUInt16BE(offset);
      assert.equal(sample, pixels[samples]);
      samples++;
      maxError = Math.max(maxError, Math.abs(sample - source.readUInt16BE(offset)));
    }
    assert.equal(maxError, 3);
  } finally {
    oracle.close();
  }
  console.log(JSON.stringify({ test: 'NASA LOLA real browser downloads agree with CharLS', near: 3, maxError, samples,
    fixtureSha256, jlsBytes: jls.length, jlsSha256: fingerprint(jls), pgmBytes: pgm.length, pgmSha256: fingerprint(pgm) }));
}

try {
  await page.goto(`${origin}/web/`);
  await click('example');
  await select('near', '3');
  await click('run');
  await phase('complete');
  assert.match(await page.locator('#frame').textContent(), /400 × 260 · 16-bit · NEAR 3/);
  assert.equal(Number(await page.locator('#error').textContent()), 3);
  await page.locator('#original').click();
  const pixel = /original (\d+) · reconstructed (\d+) · error (\d+)/.exec(await page.locator('#pixel').textContent());
  assert.ok(pixel && Number(pixel[1]) > 255);
  assert.equal(Math.abs(Number(pixel[1]) - Number(pixel[2])), Number(pixel[3]));
  assert.equal(await text('inspect-original'), Number(pixel[1]).toLocaleString('en'));
  assert.equal(await text('inspect-reconstructed'), Number(pixel[2]).toLocaleString('en'));
  assert.equal(await text('inspect-error'), Number(pixel[3]).toLocaleString('en'));
  assert.equal(await page.locator('[data-pane="original"] .reticle-layer').evaluate((el) => el.hidden), false);
  assert.equal(await page.locator('[data-pane="reconstruction"] .reticle-layer').evaluate((el) => el.hidden), false);
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
  await phase('complete');
  assert.match(await text('status'), /stream termination verified\. No original comparison/);
  assert.equal(await text('error'), 'Not compared');
  await page.locator('#reconstruction').click();
  assert.equal(await text('inspect-original'), 'Not compared');
  assert.equal(await text('inspect-error'), 'Not compared');
  await page.locator('.view-tab[data-view="difference"]').click();
  assert.equal(await page.locator('#difference').isVisible(), false);
  assert.equal(await page.locator('[data-pane="difference"] .reference-placeholder').isVisible(), true);
  await page.locator('.view-tab[data-view="reconstruction"]').click();
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
  await chunkSize('1024');
  await click('run');
  await phase('complete');
  assert.equal(await page.locator('#download').isVisible(), false);
  assert.equal(await page.locator('#error').textContent(), '3');
  await select('language', 'zh');
  await status('已完成');
  assert.equal(await page.title(), 'MoonJLS · JPEG-LS 工作台');
  assert.equal(await page.locator('.view-tabs').getAttribute('aria-label'), '图像显示模式');
  await select('language', 'en');
  assert.equal(await page.title(), 'MoonJLS · JPEG-LS Workbench');
  assert.equal(await page.locator('.view-tabs').getAttribute('aria-label'), 'Image view mode');

  // Empty file-picker cancel should keep loaded source and completed results intact.
  await page.locator('#file').setInputFiles([]);
  assert.equal(await text('phase'), 'Complete');
  assert.equal(await text('error'), '3');

  // Drag-and-drop PGM file load resets drop ring and sets source cleanly.
  const dropBytes = smallPgm([100, 200, 300, 400]).bytes;
  await page.evaluate((raw) => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(raw)], 'dropped.pgm', { type: 'image/x-portable-graymap' }));
    document.body.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
    document.body.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    document.body.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, [...dropBytes]);
  assert.equal(await text('source-name'), 'dropped.pgm');
  assert.equal(await page.locator('#workspace-view').getAttribute('data-drop-active'), 'false');
  await select('near', '0');
  await click('run');
  await phase('complete');
  assert.equal(await text('error'), '0');
  console.log(JSON.stringify({ test: 'browser bounded verification, locale ARIA/title, cancel-picker guard & drag-drop', inputChunkSize: 1024 }));

  await click('example');
  await select('near', '0');
  await click('run');
  await phase('complete');
  assert.equal(await text('error'), '0');
  const zero = await page.locator('#reconstruction').evaluate((canvas) => [...canvas.getContext('2d').getImageData(0, 0, 2, 1).data]);
  assert.deepEqual(zero, [0, 0, 0, 255, 255, 255, 255, 255]);
  console.log(JSON.stringify({ test: 'browser sample lossless full-range endpoints', backend: 'js', maxError: 0, displayEndpoints: zero }));

  await chunkSize('1');
  await click('run');
  await click('pause');
  await phase('paused');
  await click('pause');
  await phase('running');
  await click('cancel');
  await status('Cancelled');
  console.log(JSON.stringify({ test: 'browser UI pause, resume and cancel', inputChunkSize: 1 }));

  await cancelRestart('read', byteStream);
  await cancelRestart('read', byteStream, 255);
  await cancelRestart('write', byteStream);
  await cancelRestart('close', byteStream);
  await gatedEnding();
  await gatedClose(false);
  await gatedClose(true);
  await narrowSettingsSummary(byteStream);

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

  await expandedNear();
  if (process.env.MOONJLS_LOLA) await verifyLunarDownload(process.env.MOONJLS_LOLA);

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  if (receiptPath) {
    const responses = Object.fromEntries(await Promise.all([...loaded].map(async ([path, receipt]) => [path, await receipt])));
    for (const path of ['/web/app.mjs', '/web/style.css', '/web/preview.mjs', '/web/labels.mjs',
      '/sdk/worker-client.mjs', '/sdk/index.mjs', '/sdk/worker.mjs', '/sdk/generated/core.mjs', '/sdk/generated/core.wasm']) {
      assert.ok(responses[path]?.sha256, `No browser body hash for ${path}`);
    }
    await mkdir(dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, `${JSON.stringify({ browser: browser.version(), node: process.version, responses }, null, 2)}\n`);
  }
  console.log(JSON.stringify({ status: 'passed', browser: browser.version(), node: process.version }));
} finally {
  await browser.close();
}
