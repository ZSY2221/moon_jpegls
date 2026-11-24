import { CodecError } from '../sdk/index.mjs';
import { startWorker } from '../sdk/worker-client.mjs';
import { strings } from './labels.mjs';
import { openPgm, pgmHeader, pgmRow, samplePgm } from './pgm.mjs';
import { createPreview, previewIds } from './preview.mjs';
import { createPipe, openSink, readBlob } from './transport.mjs';

const get = (id) => document.getElementById(id);
const controls = ['example', 'file', 'near', 'backend', 'chunk', 'sink'];
const measures = ['frame', 'encoded', 'ratio', 'error', 'latency', 'workspace', 'queues'];
let locale = 'en';
let source;
let active;
let artifactUrl;
let stateKey = 'waiting';
let stateArgs = [];
let selectedPixel;
const preview = createPreview(previewIds.map(get), (pixel) => { selectedPixel = pixel; renderText(); });

function translate(key, ...args) {
  const value = strings[locale][key];
  return typeof value === 'function' ? value(...args) : value ?? key;
}

function renderText() {
  get('selected').textContent = source?.name ?? translate('noFile');
  get('pixel').textContent = selectedPixel ? translate('pixel', selectedPixel) : translate('pickPixel');
  get('pause').textContent = translate(active?.paused ? 'resume' : 'pause');
  get('status').textContent = translate(stateKey, ...stateArgs);
  get('progress').setAttribute('aria-label', translate('reconstruction'));
}

function status(key, ...args) {
  stateKey = key;
  stateArgs = args;
  get('status').classList.remove('error');
  renderText();
}

function lock(running) {
  for (const id of controls) get(id).disabled = running || (id === 'near' && isJls(source));
  get('run').disabled = running || source === undefined;
  get('pause').disabled = !running;
  get('cancel').disabled = !running;
}

const isJls = (file) => /\.jls$/i.test(file?.name ?? '');

function clearOutput() {
  preview.clear();
  selectedPixel = undefined;
  for (const id of measures) get(id).textContent = '—';
  get('progress').value = 0;
  get('download').hidden = true;
  if (artifactUrl) URL.revokeObjectURL(artifactUrl);
  artifactUrl = undefined;
}

function setSource(file) {
  if (active) return;
  source = file;
  clearOutput();
  lock(false);
  status(file ? 'ready' : 'waiting');
}

function requireActive(job) {
  if (active !== job || job.abort.signal.aborted) throw new CodecError('Cancelled', 'Operation cancelled');
}

function statsToView(job, stats, frame) {
  requireActive(job);
  const payload = `${stats.coreWorkspaceBytes.toLocaleString(locale)} B`;
  get('workspace').textContent = job.encodePeak
    ? `${job.encodePeak.toLocaleString(locale)} / ${payload}` : payload;
  get('queues').textContent = `${stats.inputQueueBytes} / ${stats.outputQueueBytes} B · max ${stats.inputPeakBytes} / ${stats.outputPeakBytes} B`;
  if (frame) {
    get('frame').textContent = `${frame.width} × ${frame.height} · ${frame.bits}-bit · NEAR ${frame.near}`;
    get('progress').max = frame.height;
    get('progress').value = stats.rows;
    if (!job.paused) status('running', stats.rows, frame.height);
  }
}

function launch(job, options) {
  requireActive(job);
  const worker = startWorker({
    ...options, signal: job.abort.signal,
    async read(capacity) {
      requireActive(job);
      const chunk = await options.read(capacity);
      requireActive(job);
      return chunk;
    },
  });
  job.workers.push(worker);
  if (job.paused) worker.pause();
  return worker.result;
}

async function decodeFile(job, file, settings, sink) {
  const result = await launch(job, {
    ...settings, mode: 'decode', read: readBlob(file),
    async onEvent(event) {
      statsToView(job, event.stats, event.frame);
      if (event.type !== 'row') return;
      const { frame, index, row } = event;
      if (index === 0) {
        preview.configure(frame, false);
        await sink.write(pgmHeader(frame));
        requireActive(job);
      }
      preview.drawRow(index, row, null);
      await sink.write(pgmRow(row, frame));
      requireActive(job);
    },
  });
  requireActive(job);
  return { ...result, jlsBytes: result.stats.inputConsumed, maxError: null };
}

async function roundTrip(job, file, near, settings, sink) {
  const input = await openPgm(file, near);
  requireActive(job);
  const pipe = createPipe();
  let maxError = 0;
  const decoded = launch(job, {
    ...settings, mode: 'decode', read: pipe.read,
    async onEvent(event) {
      statsToView(job, event.stats, event.frame);
      if (event.type !== 'row') return;
      const { frame, index, row } = event;
      if (index === 0) preview.configure(frame, true);
      const original = await input.row(index);
      requireActive(job);
      for (let i = 0; i < row.length; i++) maxError = Math.max(maxError, Math.abs(original[i] - row[i]));
      if (maxError > near) throw new Error(`Round-trip error ${maxError} exceeds NEAR ${near} at row ${index}`);
      preview.drawRow(index, row, original);
    },
  });
  const encoded = launch(job, {
    ...settings, mode: 'encode', frame: input.frame, read: input.read,
    async onEvent(event) {
      requireActive(job);
      job.encodePeak = event.stats.coreWorkspaceBytes;
      if (event.type === 'bytes') {
        await sink.write(event.chunk);
        requireActive(job);
        await pipe.write(event.chunk);
        requireActive(job);
      }
    },
  }).then((result) => {
    requireActive(job);
    job.encodePeak = result.stats.coreWorkspaceBytes;
    pipe.close();
    return result;
  });
  try {
    const [fromEncode, fromDecode] = await Promise.all([encoded, decoded]);
    requireActive(job);
    return { ...fromDecode, jlsBytes: fromEncode.stats.outputProduced, maxError };
  } catch (error) {
    pipe.fail(error);
    throw error;
  }
}

async function run() {
  if (active || !source) return;
  const chunk = Number(get('chunk').value);
  if (!Number.isInteger(chunk) || chunk < 1 || chunk > 1024 * 1024) {
    status('invalidChunk');
    get('status').classList.add('error');
    return;
  }
  const near = Number(get('near').value);
  const sinkMode = get('sink').value;
  const file = source;
  const decodeOnly = isJls(file);
  const outputName = file.name.replace(/\.[^.]+$/, '') + (decodeOnly ? '.pgm' : '.jls');
  const settings = { backend: get('backend').value, inputChunkSize: chunk, outputChunkSize: Math.min(chunk, 32 * 1024) };
  const job = { abort: new AbortController(), paused: false, workers: [] };
  active = job;
  clearOutput();
  lock(true);
  status('starting');
  let sink;
  try {
    sink = await openSink(sinkMode, outputName, decodeOnly ? 'image/x-portable-graymap' : 'image/jls');
    requireActive(job);
    const started = performance.now();
    const result = await (decodeOnly ? decodeFile(job, file, settings, sink) : roundTrip(job, file, near, settings, sink));
    requireActive(job);
    const elapsed = performance.now() - started;
    const { frame, jlsBytes, maxError, stats } = result;
    const artifact = await sink.close();
    requireActive(job);
    if (artifact instanceof Blob) {
      artifactUrl = URL.createObjectURL(artifact);
      get('download').href = artifactUrl;
      get('download').download = outputName;
      get('download').hidden = false;
    }
    const rawBytes = frame.width * frame.height * Math.ceil(frame.bits / 8);
    statsToView(job, stats, frame);
    get('encoded').textContent = `${jlsBytes.toLocaleString(locale)} B`;
    get('ratio').textContent = `${(rawBytes / jlsBytes).toFixed(2)}×`;
    get('error').textContent = maxError ?? '—';
    get('latency').textContent = `${elapsed.toFixed(1)} ms`;
    status(decodeOnly ? 'decodeOnly' : 'complete');
  } catch (error) {
    const cancelled = job.abort.signal.aborted || error.code === 'Cancelled' || error.name === 'AbortError';
    job.abort.abort();
    try { await sink?.abort(); } catch { /* The browser may already have aborted the file handle. */ }
    if (active === job) {
      if (cancelled) status('stopped');
      else {
        status(`${error.code ?? error.name ?? 'Error'} · ${error.message}`);
        get('status').classList.add('error');
      }
    }
  } finally {
    if (active === job) {
      active = undefined;
      lock(false);
      renderText();
    }
  }
}

get('file').addEventListener('change', (event) => setSource(event.target.files[0]));
get('example').addEventListener('click', () => { get('file').value = ''; setSource(samplePgm()); });
get('run').addEventListener('click', run);
get('pause').addEventListener('click', () => {
  if (!active) return;
  active.paused = !active.paused;
  for (const worker of active.workers) active.paused ? worker.pause() : worker.resume();
  status(active.paused ? 'paused' : 'starting');
});
get('cancel').addEventListener('click', () => {
  const job = active;
  if (!job) return;
  job.abort.abort();
  active = undefined;
  lock(false);
  status('stopped');
});
get('language').addEventListener('change', (event) => {
  locale = event.target.value;
  document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  for (const element of document.querySelectorAll('[data-label]')) element.textContent = translate(element.dataset.label);
  renderText();
});
if (!globalThis.showSaveFilePicker) get('sink').querySelector('[value="file"]').disabled = true;
renderText();
