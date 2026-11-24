import { CodecError } from '../sdk/index.mjs';
import { startWorker } from '../sdk/worker-client.mjs';
import { strings } from './labels.mjs';
import { openPgm, pgmHeader, pgmRow, samplePgm } from './pgm.mjs';
import { createPreview, previewIds } from './preview.mjs';
import { createPipe, openSink, readBlob } from './transport.mjs';

const get = (id) => document.getElementById(id);
const controls = ['example', 'file', 'near', 'backend', 'chunk', 'sink'];
const measures = ['frame', 'raw-size', 'encoded', 'ratio', 'error', 'latency', 'first-canvas', 'workspace', 'queues'];
const isJls = (file) => /\.jls$/i.test(file?.name ?? '');
const onPaint = (callback) => globalThis.requestAnimationFrame
  ? globalThis.requestAnimationFrame(callback) : queueMicrotask(callback);
let locale = 'en';
let source;
let active;
let artifactUrl;
let sequence = 0;
let presented;
let state = { phase: 'idle', message: 'waiting', args: [] };
let selectedPixel;
const preview = createPreview(previewIds.map(get), (pixel) => { selectedPixel = pixel; renderPixel(); });

function translate(key, ...args) {
  const value = strings[locale][key];
  return typeof value === 'function' ? value(...args) : value ?? key;
}

function renderPixel() {
  get('pixel').textContent = selectedPixel ? translate('pixel', selectedPixel) : translate('pickPixel');
}

function renderIdentity() {
  const frame = presented?.frame;
  const backend = presented?.backend ?? get('backend').value;
  const near = frame?.near ?? (isJls(source) ? null : presented?.near ?? Number(get('near').value));
  const name = source?.name ?? translate('noFile');
  get('selected').textContent = name;
  get('source-name').textContent = name;
  get('task-id').textContent = presented ? `#${presented.id}` : '—';
  get('task-meta').textContent = [backend === 'js' ? 'JavaScript' : 'Wasm GC',
    frame ? `${frame.bits}-bit` : translate('precisionPending'), near === null ? translate('nearFromHeader') : `NEAR ${near}`].join(' · ');
  get('workspace-view').setAttribute('data-reference', isJls(source) ? 'none' : 'available');
  get('workspace-view').setAttribute('data-near', frame?.near ?? '');
  if (isJls(source)) get('error').textContent = translate('notCompared');
  if (frame) get('frame').textContent = `${frame.width} × ${frame.height} · ${frame.bits}-bit · NEAR ${frame.near}`;
  get('error-legend-value').textContent = frame ? translate('legendMax', frame.near) : '—';
}

function renderState() {
  const { phase, message, args } = state;
  for (const id of ['workspace-view', 'phase', 'status']) get(id).setAttribute('data-state', phase);
  get('phase').textContent = translate(`phase-${phase}`);
  get('status').textContent = translate(message, ...args);
  get('pause').textContent = translate(active?.paused ? 'resume' : 'pause');
  const previewState = phase === 'complete' ? (presented?.decodeOnly ? 'streamVerified' : 'samplesVerified')
    : ['failed', 'cancelled'].includes(phase) ? 'previewIncomplete'
      : ['running', 'paused', 'finalizing'].includes(phase) ? 'previewProvisional' : 'previewWaiting';
  get('preview-state').textContent = translate(previewState);
  get('preview-detail').textContent = translate(`${previewState}Detail`);
}

function transition(phase, message = phase, ...args) {
  if (state.phase === phase && state.message === message && args.length === 0) return;
  state = { phase, message, args };
  renderState();
}

function lock(running) {
  for (const id of controls) get(id).disabled = running || (id === 'near' && isJls(source));
  get('run').disabled = running || source === undefined;
  get('pause').disabled = !running || Boolean(active?.closing);
  get('cancel').disabled = !running;
}

const bytes = (value) => value === undefined ? '—' : `${value.toLocaleString(locale)} B`;

function renderProgress(job) {
  const { frame, stats } = job ?? {};
  const rows = stats?.rows ?? 0;
  get('progress').max = frame?.height ?? 1;
  get('progress').value = rows;
  const key = state.phase === 'complete' ? 'rowsComplete'
    : ['failed', 'cancelled'].includes(state.phase) ? 'rowsIncomplete' : 'rowsProvisional';
  get('progress-copy').textContent = frame ? translate(key, rows, frame.height) : '—';
  if (stats) {
    get('workspace').textContent = `${bytes(job.encodeWorkspace)} / ${bytes(stats.coreWorkspaceBytes)}`;
    get('queues').textContent = translate('queueValues', bytes(stats.inputQueueBytes), bytes(stats.outputQueueBytes),
      bytes(stats.inputPeakBytes), bytes(stats.outputPeakBytes));
  }
}

function renderResult(job) {
  if (!job?.result) return;
  const { frame, jlsBytes, maxError } = job.result;
  const raw = frame.width * frame.height * Math.ceil(frame.bits / 8);
  get('raw-size').textContent = bytes(raw);
  get('encoded').textContent = bytes(jlsBytes);
  get('ratio').textContent = `${(raw / jlsBytes).toFixed(2)}×`;
  get('error').textContent = maxError ?? translate('notCompared');
  get('latency').textContent = `${job.elapsed.toFixed(1)} ms`;
  if (job.firstCanvas !== undefined) get('first-canvas').textContent = `${(job.firstCanvas - job.started).toFixed(1)} ms`;
}

function clearOutput() {
  preview.clear();
  selectedPixel = undefined;
  for (const id of measures) get(id).textContent = '—';
  get('download').hidden = true;
  get('download').href = '';
  get('download').download = '';
  if (artifactUrl) URL.revokeObjectURL(artifactUrl);
  artifactUrl = undefined;
  renderPixel();
}

function setSource(file) {
  if (active) return;
  source = file;
  presented = undefined;
  clearOutput();
  lock(false);
  transition(file ? 'ready' : 'idle', file ? 'ready' : 'waiting');
  renderIdentity();
  renderProgress();
}

function requireActive(job) {
  if (active !== job || job.abort.signal.aborted) throw new CodecError('Cancelled', 'Operation cancelled');
}

function setFrame(job, frame) {
  if (!frame || job.frame) return;
  job.frame = frame;
  renderIdentity();
}

function recordStats(job, stats, frame) {
  requireActive(job);
  setFrame(job, frame);
  job.stats = stats;
  if (job.frame && stats.rows === job.frame.height && !job.rowsArrived) {
    job.rowsArrived = true;
    if (!job.paused) transition('finalizing', 'finishingStream');
    renderProgress(job);
    return;
  }
  if (job.paintPending) return;
  job.paintPending = true;
  onPaint(() => {
    job.paintPending = false;
    if (active === job && !job.abort.signal.aborted) renderProgress(job);
  });
}

function draw(job, index, reconstructed, original) {
  const firstCanvas = preview.drawRow(index, reconstructed, original);
  if (firstCanvas !== undefined && job.firstCanvas === undefined) job.firstCanvas = firstCanvas;
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
      recordStats(job, event.stats, event.frame);
      if (event.type !== 'row') return;
      const { frame, index, row } = event;
      if (index === 0) {
        preview.configure(frame, false);
        await sink.write(pgmHeader(frame));
        requireActive(job);
      }
      draw(job, index, row, null);
      await sink.write(pgmRow(row, frame));
      requireActive(job);
    },
  });
  requireActive(job);
  return { ...result, jlsBytes: result.stats.inputConsumed, maxError: null };
}

async function roundTrip(job, file, near, settings, sink) {
  const input = await openPgm(file, near, job.abort.signal);
  requireActive(job);
  setFrame(job, input.frame);
  const pipe = createPipe();
  let maxError = 0;
  const decoded = launch(job, {
    ...settings, mode: 'decode', read: pipe.read,
    async onEvent(event) {
      recordStats(job, event.stats, event.frame);
      if (event.type !== 'row') return;
      const { frame, index, row } = event;
      if (index === 0) preview.configure(frame, true);
      const original = await input.row(index);
      requireActive(job);
      for (let i = 0; i < row.length; i++) maxError = Math.max(maxError, Math.abs(original[i] - row[i]));
      if (maxError > near) throw new Error(`Round-trip error ${maxError} exceeds NEAR ${near} at row ${index}`);
      draw(job, index, row, original);
    },
  });
  const encoded = launch(job, {
    ...settings, mode: 'encode', frame: input.frame, read: input.read,
    async onEvent(event) {
      requireActive(job);
      job.encodeWorkspace = event.stats.coreWorkspaceBytes;
      if (event.type === 'bytes') {
        await sink.write(event.chunk);
        requireActive(job);
        await pipe.write(event.chunk);
        requireActive(job);
      }
    },
  }).then((result) => {
    requireActive(job);
    job.encodeWorkspace = result.stats.coreWorkspaceBytes;
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
  } finally {
    input.closeReference();
  }
}

async function run() {
  if (active || !source) return;
  clearOutput();
  presented = undefined;
  const chunk = Number(get('chunk').value);
  if (!Number.isInteger(chunk) || chunk < 1 || chunk > 1024 * 1024) {
    renderIdentity();
    renderProgress();
    transition('failed', 'invalidChunk');
    return;
  }
  const near = Number(get('near').value);
  const sinkMode = get('sink').value;
  const file = source;
  const decodeOnly = isJls(file);
  const outputName = file.name.replace(/\.[^.]+$/, '') + (decodeOnly ? '.pgm' : '.jls');
  const settings = { backend: get('backend').value, inputChunkSize: chunk, outputChunkSize: Math.min(chunk, 32 * 1024) };
  const job = { id: ++sequence, backend: settings.backend, near, decodeOnly,
    abort: new AbortController(), paused: false, workers: [] };
  active = job;
  presented = job;
  lock(true);
  transition('running', 'starting');
  renderIdentity();
  renderProgress(job);
  let sink;
  try {
    sink = await openSink(sinkMode, outputName, decodeOnly ? 'image/x-portable-graymap' : 'image/jls');
    requireActive(job);
    job.started = performance.now();
    if (!job.paused) transition('running');
    const result = await (decodeOnly ? decodeFile(job, file, settings, sink) : roundTrip(job, file, near, settings, sink));
    requireActive(job);
    job.closing = true;
    job.paused = false;
    setFrame(job, result.frame);
    job.stats = result.stats;
    lock(true);
    transition('finalizing', 'closingOutput');
    renderProgress(job);
    const artifact = await sink.close();
    requireActive(job);
    job.elapsed = performance.now() - job.started;
    job.result = result;
    if (artifact instanceof Blob) {
      artifactUrl = URL.createObjectURL(artifact);
      get('download').href = artifactUrl;
      get('download').download = outputName;
      get('download').hidden = false;
    }
    renderResult(job);
    transition('complete', decodeOnly ? 'decodeOnly' : 'complete');
    renderProgress(job);
  } catch (error) {
    const cancelled = job.abort.signal.aborted || error.code === 'Cancelled' || error.name === 'AbortError';
    job.abort.abort();
    if (active === job) {
      active = undefined;
      lock(false);
      if (cancelled) transition('cancelled');
      else transition('failed', 'failure', typeof error.code === 'string' ? error.code : error.name ?? 'Error', error.message);
      renderProgress(job);
    }
    try { await sink?.abort(); } catch { /* The browser may already have closed the writer. */ }
  } finally {
    if (active === job) {
      active = undefined;
      lock(false);
    }
    job.workers.length = 0;
  }
}

get('file').addEventListener('change', (event) => setSource(event.target.files[0]));
get('example').addEventListener('click', () => { get('file').value = ''; setSource(samplePgm()); });
get('run').addEventListener('click', run);
get('pause').addEventListener('click', () => {
  const job = active;
  if (!job || job.closing) return;
  job.paused = !job.paused;
  for (const worker of job.workers) job.paused ? worker.pause() : worker.resume();
  if (job.paused) transition('paused');
  else if (job.rowsArrived) transition('finalizing', 'finishingStream');
  else transition('running', job.started === undefined ? 'starting' : 'running');
  renderProgress(job);
});
get('cancel').addEventListener('click', () => {
  const job = active;
  if (!job) return;
  job.abort.abort();
  active = undefined;
  lock(false);
  transition('cancelled');
  renderProgress(job);
});
for (const id of ['near', 'backend']) get(id).addEventListener('change', renderIdentity);
function applyLocale() {
  document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  for (const element of document.querySelectorAll('[data-label]')) element.textContent = translate(element.dataset.label);
  renderIdentity();
  renderState();
  renderProgress(presented);
  renderResult(presented);
  renderPixel();
  get('progress').setAttribute('aria-label', translate('reconstruction'));
}
get('language').addEventListener('change', (event) => {
  locale = event.target.value;
  applyLocale();
});
if (!globalThis.showSaveFilePicker) get('sink').querySelector('[value="file"]').disabled = true;
applyLocale();
