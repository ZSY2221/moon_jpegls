import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { cpus, platform, release } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import { installWorkbenchObserver, instrumentApp, instrumentPgm } from './bench-workbench-probe.mjs';

const HELP = `Usage: node web/bench-workbench.mjs --baseline DIR [--candidate DIR] --output FILE
  --baseline / --candidate   Static workbench trees built by node web/build.mjs.
  --baseline-source / --candidate-source   Git revisions for the trees (recorded in report).
  --profile                 Diagnostic only. Defaults to a single Wasm GC NEAR=0 run.
  --backends wasm-gc,js       Selected backends. Default both for paired timing.
  --nears 0,3                Selected NEAR values. Default both for paired timing.
  --chunk 4096               Encoder source elements and decoder input bytes.
  --warmup 2 --repeats 5     Trials per case and variant after file selection.
  --check-download FILE     Use a real PGM, encode and download, then decode and compare once.
  --timeout-ms 120000       Individual browser operation timeout.
  --help                    Show help. MOONJLS_CHROME overrides the installed Chrome binary.

Without --check-download, generates the RC2 512x4096 16-bit sample formula as a PGM beside the report.
The workbench receives the actual file through its file input. Page wall time starts at the Run click
and ends after worker terminal events, sink.close, and UI completion. First display is the first
reconstruction Canvas putImageData completion, without a browser presentation milestone.`;

const { values: options } = parseArgs({ options: Object.fromEntries([
  ...['baseline', 'candidate', 'baseline-source', 'candidate-source', 'output', 'backends', 'nears', 'chunk', 'warmup', 'repeats',
    'check-download', 'timeout-ms'].map((key) => [key, { type: 'string' }]),
  ...['profile', 'help'].map((key) => [key, { type: 'boolean' }]),
]) });
if (options.help) {
  console.log(HELP);
  process.exit(0);
}
if (!options.baseline || !options.output) throw new Error(HELP);
if (options['check-download'] && options.profile) throw new Error('Download check and profile are separate runs');

const hash = (content) => createHash('sha256').update(content).digest('hex');
const integer = (name, fallback, min, max) => {
  const val = Number(options[name] ?? fallback);
  assert.ok(Number.isInteger(val) && val >= min && val <= max, `${name} must be between ${min} and ${max}`);
  return val;
};
const list = (name, fallback, accepted) => {
  const selected = (options[name] ?? fallback).split(',');
  assert.ok(new Set(selected).size === selected.length && selected.every((item) => accepted.includes(item)), `Invalid ${name}`);
  return selected;
};
const diagnostic = !!options.profile;
const single = diagnostic || !!options['check-download'];
const backends = list('backends', single ? 'wasm-gc' : 'wasm-gc,js', ['wasm-gc', 'js']);
const nears = list('nears', single ? '0' : '0,3', ['0', '3']).map(Number);
const chunk = integer('chunk', 4096, 1, 1024 * 1024);
const warmup = integer('warmup', single ? 0 : 2, 0, 10);
const repeats = integer('repeats', single ? 1 : 5, 1, 10);
const timeout = integer('timeout-ms', 120000, 1000, 900000);
const variants = options.candidate ? ['baseline', 'candidate'] : ['baseline'];
const output = resolve(options.output);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, '{}\n', { flag: 'wx' });

function pgmFixture() {
  const width = 512, height = 4096;
  const header = Buffer.from(`P5\n${width} ${height}\n65535\n`);
  const bytes = Buffer.allocUnsafe(header.length + width * height * 2);
  header.copy(bytes);
  let offset = header.length;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    bytes.writeUInt16BE((x * 173 + y * 47 + ((x ^ y) & 31) * 3) & 65535, offset);
    offset += 2;
  }
  return bytes;
}

function parsePgm(buffer) {
  const header = /^P5\s+(?:#[^\r\n]*(?:\r\n|\n)+\s*)*(\d+)\s+(\d+)\s+(255|4095|65535)(\r\n|\s)/.exec(buffer.subarray(0, 65537).toString('latin1'));
  assert.ok(header, 'Expected an ordinary P5 header for the benchmark fixture');
  const [, width, height, maximum] = header;
  const bits = { 255: 8, 4095: 12, 65535: 16 }[maximum];
  const samples = Number(width) * Number(height);
  const raster = buffer.subarray(header[0].length);
  assert.equal(raster.length, samples * (bits === 8 ? 1 : 2));
  return { width: Number(width), height: Number(height), bits, samples, raster };
}

const bytes = options['check-download'] ? await readFile(resolve(options['check-download'])) : pgmFixture();
const fixture = options['check-download'] ? resolve(options['check-download']) : join(dirname(output), 'resource-512x4096-16.pgm');
if (!options['check-download']) await writeFile(fixture, bytes);
const source = parsePgm(bytes);
const fixtureInfo = { file: basename(fixture), bytes: bytes.length, sha256: hash(bytes), width: source.width, height: source.height, bits: source.bits,
  rasterSha256: hash(source.raster), formula: options['check-download'] ? null : '(x*173+y*47+((x^y)&31)*3)&65535' };

const files = ['web/index.html', 'web/style.css', 'web/app.mjs', 'web/labels.mjs', 'web/pgm.mjs', 'web/preview.mjs', 'web/transport.mjs',
  'sdk/index.mjs', 'sdk/worker-client.mjs', 'sdk/worker.mjs', 'sdk/generated/core.mjs', 'sdk/generated/core.wasm'];
const types = { html: 'text/html', mjs: 'text/javascript', css: 'text/css', wasm: 'application/wasm' };
const resources = new Map();
const assets = {};
for (const variant of variants) {
  assets[variant] = {};
  for (const file of files) {
    const original = await readFile(join(resolve(options[variant]), file));
    let served = original;
    if (file === 'web/app.mjs') served = Buffer.from(instrumentApp(original.toString('utf8'), diagnostic));
    if (diagnostic && file === 'web/pgm.mjs') served = Buffer.from(instrumentPgm(original.toString('utf8')));
    const evidence = { originalSha256: hash(original), sha256: hash(served), bytes: served.byteLength, instrumented: served !== original };
    assets[variant][file] = evidence;
    const url = `/${variant}/${file === 'web/index.html' ? 'web/' : file}`;
    resources.set(url, { content: served, type: types[file.split('.').at(-1)], evidence });
  }
}
if (variants.length === 2) {
  for (const file of files.filter((file) => file !== 'web/pgm.mjs' && file !== 'web/app.mjs')) {
    assert.equal(assets.baseline[file].originalSha256, assets.candidate[file].originalSha256, `Unexpected product change: ${file}`);
  }
}

const frameHost = Buffer.from(`<!doctype html><html><title>MoonJLS workbench benchmark</title><style>iframe{width:100%;height:900px;border:0;display:block}iframe[hidden]{display:none}</style>${variants.map((variant, i) => `<iframe id="${variant}" name="${variant}" src="/${variant}/web/"${i ? ' hidden' : ''}></iframe>`).join('')}</html>`);
resources.set('/', { content: frameHost, type: 'text/html', evidence: { sha256: hash(frameHost) } });
const requests = {};
const server = createServer((req, reply) => {
  const resource = resources.get(req.url);
  if (!resource || req.method !== 'GET') return reply.writeHead(404).end();
  const requestType = `${req.headers['sec-fetch-dest'] ?? ''} ← ${req.headers.referer ? new URL(req.headers.referer).pathname : ''}`;
  requests[req.url] ??= {};
  requests[req.url][requestType] = (requests[req.url][requestType] ?? 0) + 1;
  reply.writeHead(200, { 'content-type': resource.type, 'content-length': resource.content.length, 'cache-control': 'no-store',
    'x-moonjls-sha256': resource.evidence.sha256 });
  reply.end(resource.content);
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const entry = `http://127.0.0.1:${server.address().port}/`;
const chrome = process.env.MOONJLS_CHROME;
const responses = {};
const pendingResponses = new Map();
const errors = [];
let browser;

function summarize(samples) {
  const values = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
  const deviations = values.map((value) => Math.abs(value - median)).sort((a, b) => a - b);
  return { median, min: values[0], max: values.at(-1), mad: values.length % 2 ? deviations[middle] : (deviations[middle - 1] + deviations[middle]) / 2 };
}

function summary(trials) {
  const result = [];
  for (const backend of backends) for (const near of nears) {
    const group = trials.filter((trial) => trial.backend === backend && trial.near === near && trial.phase === 'formal');
    if (!group.length) continue;
    const item = { backend, near };
    for (const variant of variants) {
      const matches = group.filter((trial) => trial.variant === variant).sort((a, b) => a.index - b.index);
      if (!matches.length) continue;
      item[variant] = Object.fromEntries(['wallMs', 'firstDisplayMs', 'firstRowArrivalMs', 'sinkOpenMs', 'sinkCloseMs'].map((key) => {
        const samples = matches.map((trial) => trial[key]);
        return [key, { samples, ...summarize(samples) }];
      }));
    }
    if (item.baseline?.wallMs.samples.length === repeats && item.candidate?.wallMs.samples.length === repeats) {
      const before = item.baseline.wallMs.median;
      const after = item.candidate.wallMs.median;
      const pairedRegression = item.candidate.wallMs.samples.map((value, i) => 100 * (value / item.baseline.wallMs.samples[i] - 1));
      const first = item.baseline.firstDisplayMs.median;
      const firstLimit = Math.max(first * 0.1, 2);
      const primary = backend === 'wasm-gc' && near === 0 && chunk === 4096;
      const reductionPercent = 100 * (1 - after / before);
      const stableRegression = reductionPercent < -5 && pairedRegression.filter((value) => value > 5).length >= 4;
      item.gate = {
        primary, reductionPercent, pairedRegression, stableRegression,
        wallPass: primary ? reductionPercent >= 10 : !stableRegression,
        firstDisplayDeltaMs: item.candidate.firstDisplayMs.median - first, firstDisplayAllowanceMs: firstLimit,
        firstDisplayPass: item.candidate.firstDisplayMs.median <= first + firstLimit,
      };
    }
    result.push(item);
  }
  return result;
}

const report = {
  startedUtc: new Date().toISOString(), schema: 1, diagnostic, options: process.argv.slice(2),
  environment: { node: process.version, platform: platform(), release: release(), cpu: cpus()[0].model },
  settings: { warmup, repeats, chunk, backends, nears, timeout }, fixture: fixtureInfo, assets,
  sourceCommit: Object.fromEntries(variants.map((variant) => [variant, options[`${variant}-source`] ?? null])),
  timing: 'Browser performance.now from capture of the real Run click until task finalization. The original file, app, workers, preview and sink are active. Fixture creation and file selection are excluded. First display is the return from the first reconstruction Canvas putImageData, not the painted next frame. Profile enables operation counters; ordinary trials use job/sink clocks, first-row/canvas clock and terminal statistics only.',
  profileLimit: 'Reference request durations are serial pre-row-ACK spans for this task. They include materialization and scheduling, and may overlap encoder and pipe work. The summed spans divided by wall time are a screening metric, not predicted savings. Cache/row/queue sizes are logical owned payloads, not renderer RSS.',
  trials: [], failures: [], actualBrowserResponses: responses, serverDelivered: requests,
};
report.harness = {
  runnerSha256: hash(await readFile(new URL(import.meta.url))),
  probeSha256: hash(await readFile(new URL('./bench-workbench-probe.mjs', import.meta.url))),
};

async function save() {
  const tmp = `${output}.tmp`;
  const groups = summary(report.trials);
  const expected = variants.length * backends.length * nears.length * (warmup + repeats);
  const pairedComplete = !diagnostic && !options['check-download'] && variants.length === 2 && report.trials.length === expected && !report.failures.length;
  const gate = pairedComplete ? {
    timingPass: groups.some((group) => group.gate?.primary) && groups.every((group) => group.gate.wallPass && group.gate.firstDisplayPass),
    notes: 'Separate correctness, targeted cancellation and memory evidence is required before retaining a product change.',
  } : null;
  await writeFile(tmp, `${JSON.stringify({ ...report, summary: groups, gate, recordedUtc: new Date().toISOString() }, null, 2)}\n`);
  await rename(tmp, output);
}

try {
  browser = await chromium.launch(chrome ? { executablePath: chrome } : { channel: 'chrome' });
  report.environment.browser = browser.version();
  const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(installWorkbenchObserver, { diagnostic });
  context.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (!resources.has(path) || pendingResponses.has(path)) return;
    pendingResponses.set(path, (async () => {
      const claimed = (await response.allHeaders())['x-moonjls-sha256'];
      assert.equal(claimed, resources.get(path).evidence.sha256);
      const body = await response.body().catch(() => null);
      if (body) assert.equal(hash(body), claimed);
      responses[path] = { status: response.status(), deliveredSha256: claimed, browserBodySha256: body && hash(body) };
    })().catch((error) => errors.push(error.message)));
  });
  const page = await context.newPage();
  page.setDefaultTimeout(timeout);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(entry);
  const frames = new Map(variants.map((variant) => [variant, page.frame({ name: variant })]));
  assert.ok([...frames.values()].every(Boolean));

  async function waitForFinish(frame) {
    return frame.evaluate(async (waitMs) => {
      let timer;
      const expire = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Workbench timeout')), waitMs); });
      try { return await Promise.race([globalThis.__workbenchBench.wait(), expire]); } finally { clearTimeout(timer); }
    }, timeout);
  }

  async function trial(variant, backend, near, phase, index, sink = 'bounded') {
    const frame = frames.get(variant);
    await page.evaluate((visible) => {
      for (const element of document.querySelectorAll('iframe')) element.hidden = element.id !== visible;
    }, variant);
    await frame.locator('#file').setInputFiles(fixture);
    await frame.locator('#backend').selectOption(backend);
    await frame.locator('#near').selectOption(String(near));
    await frame.locator('#chunk').fill(String(chunk));
    await frame.locator('#sink').selectOption(sink);
    await frame.locator('#run').click();
    const stats = await waitForFinish(frame);
    assert.deepEqual(errors, []);
    assert.equal(stats.status, 'Complete');
    assert.match(stats.frame, new RegExp(`${source.width} × ${source.height} · ${source.bits}-bit · NEAR ${near}`));
    assert.equal(stats.progress, source.height);
    assert.ok(Number(stats.maxError) <= near, `Maximum error ${stats.maxError}`);
    assert.ok(stats.firstDisplayMs !== null && stats.firstRowArrivalMs !== null && stats.firstDisplayMs >= stats.firstRowArrivalMs);
    assert.equal(stats.downloadVisible, sink === 'buffered');
    assert.equal(stats.workers.length, 2);
    assert.deepEqual(stats.workers.map((item) => item.mode).sort(), ['decode', 'encode']);
    for (const info of stats.workers) {
      assert.equal(info.stats.rows, source.height);
      if (diagnostic) {
        assert.equal(info.protocol.peakPending, 1);
        assert.equal(info.protocol.violations, 0);
        assert.equal(info.protocol.pending, 0);
        assert.equal(info.protocol.requests, info.protocol.replies);
      }
    }
    for (const name of ['web/pgm.mjs', 'web/app.mjs', 'web/preview.mjs', 'sdk/worker-client.mjs', 'sdk/index.mjs', 'sdk/worker.mjs',
      backend === 'wasm-gc' ? 'sdk/generated/core.wasm' : 'sdk/generated/core.mjs']) {
      const path = `/${variant}/${name}`;
      assert.ok(requests[path], `Browser did not request ${path}`);
      await pendingResponses.get(path);
      assert.equal(responses[path]?.deliveredSha256, assets[variant][name].sha256, path);
    }
    if (diagnostic) {
      const reference = stats.diagnostic.reference;
      assert.equal(reference.requests, source.height);
      stats.diagnostic.referencePreAckShare = reference.requestMs / stats.wallMs;
      stats.diagnostic.referenceIoAndMaterializationMs = reference.arrayBufferMs + reference.materializeMs;
      stats.diagnostic.referenceIoAndMaterializationShare = stats.diagnostic.referenceIoAndMaterializationMs / stats.wallMs;
      stats.diagnostic.referenceRatioMeasuredIncludesScheduling = true;
    }
    const item = { variant, backend, near, phase, index, order: report.trials.length + 1, ...stats };
    report.trials.push(item);
    console.log(JSON.stringify({ variant, backend, near, phase, index, wallMs: stats.wallMs, firstDisplayMs: stats.firstDisplayMs,
      ...(diagnostic && { reference: stats.diagnostic.reference,
        referencePreAckShare: stats.diagnostic.referencePreAckShare,
        referenceIoAndMaterializationShare: stats.diagnostic.referenceIoAndMaterializationShare }) }));
    await save();
    return frame;
  }

  async function download(frame) {
    const pending = page.waitForEvent('download', { timeout });
    await frame.locator('#download').click();
    return readFile(await (await pending).path());
  }

  if (options['check-download']) {
    const frame = await trial(variants.at(-1), backends[0], nears[0], 'formal', 1, 'buffered');
    const jls = await download(frame);
    assert.equal(jls.readUInt16BE(0), 0xffd8);
    assert.equal(jls.readUInt16BE(jls.length - 2), 0xffd9);
    await frame.locator('#file').setInputFiles({ name: 'workbench-recheck.jls', mimeType: 'application/octet-stream', buffer: jls });
    await frame.locator('#run').click();
    const result = await waitForFinish(frame);
    assert.match(result.status, /^Reconstruction complete/);
    const restored = await download(frame);
    const decoded = parsePgm(restored);
    assert.deepEqual([decoded.width, decoded.height, decoded.bits], [source.width, source.height, source.bits]);
    const { createOracle } = await import('../scripts/oracle.mjs');
    const oracle = await createOracle();
    try {
      const reference = oracle.decode(jls);
      assert.deepEqual(reference.frame, { width: source.width, height: source.height, bits: source.bits, near: nears[0] });
      assert.equal(reference.pixels.length, source.samples);
      let maxError = 0;
      for (let i = 0; i < source.samples; i++) {
        const original = source.bits === 8 ? source.raster[i] : source.raster.readUInt16BE(i * 2);
        const sample = source.bits === 8 ? decoded.raster[i] : decoded.raster.readUInt16BE(i * 2);
        assert.equal(sample, reference.pixels[i], `CharLS vs workbench reconstruction at sample ${i}`);
        maxError = Math.max(maxError, Math.abs(original - sample));
      }
      assert.ok(maxError <= nears[0]);
      assert.deepEqual(errors, []);
      report.download = { jlsBytes: jls.length, jlsSha256: hash(jls), pgmBytes: restored.length, pgmSha256: hash(restored),
        samplesChecked: source.samples, maxError, oracle: '@team-charls/charls-wasm 0.10.0', sameStreamReferenceMatch: true };
    } finally {
      oracle.close();
    }
  } else {
    for (const near of nears) for (const backend of backends) for (let run = 0; run < warmup + repeats; run++) {
      const order = run % 2 ? [...variants].reverse() : variants;
      for (const variant of order) await trial(variant, backend, near, run < warmup ? 'warmup' : 'formal', run < warmup ? run + 1 : run - warmup + 1);
    }
  }
  report.finishedUtc = new Date().toISOString();
} catch (error) {
  report.failures.push({ error: error.stack, timestamp: new Date().toISOString() });
  throw error;
} finally {
  await save();
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
