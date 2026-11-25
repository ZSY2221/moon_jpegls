import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { cpus, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';

const help = `Usage: node web/bench-presentation.mjs --baseline DIR --candidate DIR
       --baseline-source SHA --candidate-source SHA --output REPORT.json

Both directories must contain independent static Workbench builds (node web/build.mjs).
Runs Chrome, Wasm GC, 512x4096 16-bit PGM, NEAR=0, bounded sink, 4096 samples/bytes,
two alternating warmups and five measured pairs. Only presentation assets may differ.
The browser clock covers Run through terminal controls (including output close),
and separately records the first reconstruction Canvas update.
The report and generated fixture are written beside the output path.
MOONJLS_CHROME can override the installed Chrome binary. Use --help to show this text.`;
const { values } = parseArgs({ options: {
  baseline: { type: 'string' }, candidate: { type: 'string' },
  'baseline-source': { type: 'string' }, 'candidate-source': { type: 'string' },
  output: { type: 'string' }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log(help);
  process.exit(0);
}

const variants = ['baseline', 'candidate'];
assert.ok(values.output && variants.every((variant) =>
  values[variant] && /^[0-9a-f]{40}$/.test(values[`${variant}-source`] ?? '')), help);
const output = resolve(values.output);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const width = 512, height = 4096, chunk = 4096, warmup = 2, repeats = 5;
const raster = Buffer.allocUnsafe(width * height * 2);
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    raster.writeUInt16BE((x * 173 + y * 47 + ((x ^ y) & 31) * 3) & 65535, (y * width + x) * 2);
  }
}
const pgm = Buffer.concat([Buffer.from(`P5\n${width} ${height}\n65535\n`), raster]);
const fixture = join(dirname(output), 'presentation-512x4096-16.pgm');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, '{}\n', { flag: 'wx' });
await writeFile(fixture, pgm);

const presentation = new Set(['web/index.html', 'web/style.css', 'web/app.mjs', 'web/labels.mjs', 'web/preview.mjs']);
const frozen = ['web/pgm.mjs', 'web/transport.mjs', 'sdk/index.mjs', 'sdk/worker-client.mjs',
  'sdk/worker.mjs', 'sdk/generated/core.mjs', 'sdk/generated/core.wasm'];
const files = [...presentation, ...frozen];
const mime = { html: 'text/html', css: 'text/css', mjs: 'text/javascript', wasm: 'application/wasm' };
const assets = Object.fromEntries(variants.map((variant) => [variant, {}]));
const routes = new Map();
for (const variant of variants) {
  for (const file of files) {
    const data = await readFile(join(values[variant], file));
    const asset = { bytes: data.length, sha256: hash(data) };
    const type = mime[file.split('.').at(-1)];
    assets[variant][file] = asset;
    routes.set(`/${variant}/${file === 'web/index.html' ? 'web/' : file}`, { data, type, asset });
  }
}
for (const file of frozen) assert.deepEqual(assets.baseline[file], assets.candidate[file], `Frozen asset changed: ${file}`);
const index = Buffer.from(`<!doctype html><title>MoonJLS presentation comparison</title>
<style>body{margin:0}iframe{border:0;width:100%;height:100vh;display:block}iframe[hidden]{display:none}</style>
${variants.map((id) => `<iframe name="${id}" src="/${id}/web/"${id === 'baseline' ? '' : ' hidden'}></iframe>`).join('')}`);
routes.set('/', { data: index, type: mime.html, asset: { sha256: hash(index) } });
const requests = {};
const server = createServer((req, reply) => {
  if (req.url === '/favicon.ico') return reply.writeHead(204).end();
  const asset = routes.get(req.url);
  if (!asset || req.method !== 'GET') return reply.writeHead(404).end();
  requests[req.url] = (requests[req.url] ?? 0) + 1;
  reply.writeHead(200, {
    'content-type': asset.type, 'content-length': asset.data.byteLength, 'cache-control': 'no-store',
    'x-moonjls-sha256': asset.asset.sha256,
  });
  reply.end(asset.data);
});

// Use the same observer in both unmodified builds. Only the Run button's
// disabled attribute marks terminal UI, so there is no per-row DOM observation.
function observePresentation() {
  if (!/^\/(baseline|candidate)\/web\/$/.test(location.pathname)) return;
  let trial;
  document.addEventListener('click', (event) => {
    if (event.target.id !== 'run') return;
    let finish;
    const clickedAt = performance.now();
    const completion = new Promise((resolve) => { finish = resolve; });
    trial = { clickedAt, completion, finish };
  }, true);
  const putImageData = CanvasRenderingContext2D.prototype.putImageData;
  CanvasRenderingContext2D.prototype.putImageData = function (...args) {
    const result = Reflect.apply(putImageData, this, args);
    if (trial && trial.firstCanvasAt === undefined && this.canvas.id === 'reconstruction') {
      trial.firstCanvasAt = performance.now();
    }
    return result;
  };
  document.addEventListener('DOMContentLoaded', () => {
    const get = (id) => document.getElementById(id);
    const run = get('run');
    const observer = new MutationObserver(() => {
      if (!trial || trial.finishedAt !== undefined || run.disabled) return;
      trial.finishedAt = performance.now();
      const status = get('status');
      trial.finish({
        timeOriginMs: performance.timeOrigin, clickedAtMs: trial.clickedAt, finishedAtMs: trial.finishedAt,
        wallMs: trial.finishedAt - trial.clickedAt, firstCanvasMs: trial.firstCanvasAt - trial.clickedAt,
        status: status.textContent, state: status.dataset.state ?? null, frame: get('frame').textContent,
        rows: get('progress').value, jlsBytes: get('encoded').textContent, maxError: get('error').textContent,
        downloadHidden: get('download').hidden,
      });
    });
    observer.observe(run, { attributes: true, attributeFilter: ['disabled'] });
  }, { once: true });
  globalThis.awaitPresentationTrial = async () => {
    let timeout;
    const limit = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Browser task did not finalize within 60 seconds')), 60_000);
    });
    try { return await Promise.race([trial.completion, limit]); } finally { clearTimeout(timeout); }
  };
}

function describe(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted[middle];
  const deviations = sorted.map((value) => Math.abs(value - median)).sort((a, b) => a - b);
  return { samples, median, min: sorted[0], max: sorted.at(-1), mad: deviations[middle] };
}

function evaluateGates(trials) {
  const samples = (variant, key) => trials.filter((trial) => trial.variant === variant && trial.phase === 'formal')
    .sort((a, b) => a.pair - b.pair).map((trial) => trial[key]);
  const summary = Object.fromEntries(variants.map((variant) => [variant, {
    wallMs: describe(samples(variant, 'wallMs')), firstCanvasMs: describe(samples(variant, 'firstCanvasMs')),
  }]));
  const { baseline: before, candidate: after } = summary;
  const wallRegressionPercent = 100 * (after.wallMs.median / before.wallMs.median - 1);
  const pairedWallRegressionPercent = after.wallMs.samples.map((n, i) => 100 * (n / before.wallMs.samples[i] - 1));
  const stableWallRegression = wallRegressionPercent > 5 && pairedWallRegressionPercent.filter((n) => n > 5).length >= 4;
  const firstCanvasAllowanceMs = Math.max(before.firstCanvasMs.median * 0.1, 2);
  const firstCanvasDeltaMs = after.firstCanvasMs.median - before.firstCanvasMs.median;
  return { summary, gate: { wallRegressionPercent, pairedWallRegressionPercent, stableWallRegression,
    firstCanvasDeltaMs, firstCanvasAllowanceMs, pass: !stableWallRegression && firstCanvasDeltaMs <= firstCanvasAllowanceMs } };
}

const responses = {};
const pending = new Map();
const errors = [];
const trials = [];
const report = {
  startedUtc: new Date().toISOString(), runnerSha256: hash(await readFile(new URL(import.meta.url))),
  sourceCommit: Object.fromEntries(variants.map((variant) => [variant, values[`${variant}-source`]])),
  environment: { node: process.version, platform: platform(), release: release(), cpu: cpus()[0].model },
  settings: { width, height, bits: 16, backend: 'wasm-gc', near: 0, chunk, sink: 'bounded', warmup, repeats, viewport: [1440, 900] },
  fixture: { bytes: pgm.length, sha256: hash(pgm), rasterSha256: hash(raster), formula: '(x*173+y*47+((x^y)&31)*3)&65535' },
  timing: "Browser performance.now from capture of the real Run click until the post-finalization Run control is enabled (MutationObserver microtask). Includes worker load, preview, verification and output close. Excludes test setup and file selection. First Canvas time is measured at the return of first reconstruction putImageData.",
  assets, serverDelivered: requests, browserResponses: responses, trials, errors,
};
let browser;
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const executablePath = process.env.MOONJLS_CHROME;
  browser = await chromium.launch(executablePath ? { executablePath } : { channel: 'chrome' });
  report.environment.browser = browser.version();
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
  await context.addInitScript(observePresentation);
  context.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (!routes.has(path) || pending.has(path)) return;
    pending.set(path, (async () => {
      assert.equal(response.status(), 200);
      const deliveredSha256 = (await response.allHeaders())['x-moonjls-sha256'];
      assert.equal(deliveredSha256, routes.get(path).asset.sha256, path);
      const body = await response.body().catch(() => null);
      if (body) assert.equal(hash(body), deliveredSha256, path);
      responses[path] = { deliveredSha256, browserBodySha256: body && hash(body) };
    })().catch((error) => errors.push(error.message)));
  });

  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);

  for (let run = 0; run < warmup + repeats; run++) {
    const order = run % 2 ? [...variants].reverse() : variants;
    const phase = run < warmup ? 'warmup' : 'formal';
    const pair = run < warmup ? run + 1 : run - warmup + 1;
    for (const variant of order) {
      await page.evaluate((visible) => {
        for (const element of document.querySelectorAll('iframe')) element.hidden = element.name !== visible;
      }, variant);
      const frame = page.frame({ name: variant });
      await frame.locator('#file').setInputFiles(fixture);
      await frame.locator('#backend').selectOption('wasm-gc');
      await frame.locator('#near').selectOption('0');
      await frame.locator('#sink').selectOption('bounded');
      const advanced = frame.locator('#advanced > summary');
      const needsOpen = await advanced.count() > 0;
      if (needsOpen) await advanced.click();
      await frame.locator('#chunk').fill(String(chunk));
      if (needsOpen) await advanced.click();
      await frame.locator('#run').click();
      const trial = await frame.evaluate(() => globalThis.awaitPresentationTrial());
      trials.push({ variant, phase, pair, order: trials.length + 1, ...trial });
      assert.deepEqual(errors, []);
      assert.equal(trial.state ?? trial.status, trial.state ? 'complete' : 'Complete');
      assert.match(trial.frame, /512 × 4096 · 16-bit · NEAR 0/);
      assert.equal(trial.rows, height);
      assert.equal(trial.maxError, '0');
      assert.equal(trial.jlsBytes, '1,249,961 B');
      assert.ok(trial.downloadHidden);
      assert.ok(Number.isFinite(trial.firstCanvasMs) && trial.firstCanvasMs >= 0 && trial.wallMs >= trial.firstCanvasMs);
      console.log(JSON.stringify({ variant, phase, pair, wallMs: trial.wallMs, firstCanvasMs: trial.firstCanvasMs }));
    }
  }
  await Promise.all(pending.values());
  assert.deepEqual(errors, []);
  for (const variant of variants) {
    for (const file of files.filter((name) => name !== 'sdk/generated/core.mjs')) {
      const path = `/${variant}/${file === 'web/index.html' ? 'web/' : file}`;
      assert.equal(responses[path]?.deliveredSha256, assets[variant][file].sha256, path);
    }
  }
  Object.assign(report, evaluateGates(trials));
  console.log(JSON.stringify(report.gate));
  if (!report.gate.pass) process.exitCode = 1;
} catch (error) {
  errors.push(error.stack ?? String(error));
  throw error;
} finally {
  report.finishedUtc = new Date().toISOString();
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  await browser?.close();
  server.close();
}
