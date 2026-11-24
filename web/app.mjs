import { CodecError } from '../sdk/index.mjs';
import { startWorker } from '../sdk/worker-client.mjs';
import { strings } from './labels.mjs';
import { openPgm, pgmHeader, pgmRow, samplePgm } from './pgm.mjs';
import { createPreview, errorPalette, previewIds } from './preview.mjs';
import { createPipe, openSink, readBlob } from './transport.mjs';

const get = (id) => document.getElementById(id);
const setText = (id, value) => {
  const element = get(id);
  const text = String(value);
  if (element && element.textContent !== text) element.textContent = text;
};
const setAttr = (id, name, value) => {
  const element = get(id);
  if (element?.setAttribute && element.getAttribute?.(name) !== String(value)) {
    element.setAttribute(name, value);
  }
};
const setHidden = (id, hidden) => {
  const element = get(id);
  if (element) element.hidden = hidden;
};

const controls = ['example', 'file', 'near', 'backend', 'chunk', 'sink'];
const measures = ['frame', 'raw-size', 'encoded', 'ratio', 'error', 'latency', 'first-canvas', 'workspace', 'queues'];
const isJls = (file) => /\.jls$/i.test(file?.name ?? '');
const onPaint = (callback) => globalThis.requestAnimationFrame
  ? globalThis.requestAnimationFrame(callback) : queueMicrotask(callback);
const narrowQuery = globalThis.matchMedia?.('(max-width: 640px)');
const isNarrow = () => Boolean(narrowQuery?.matches);

let locale = 'en';
let source;
let active;
let artifactUrl;
let sequence = 0;
let presented;
let state = { phase: 'idle', message: 'waiting', args: [] };
let selectedPixel;
let viewMode = isNarrow() ? 'reconstruction' : 'compare';
const preview = createPreview(previewIds.map(get), (pixel) => { selectedPixel = pixel; renderPixel(); });

function translate(key, ...args) {
  const value = strings[locale][key];
  return typeof value === 'function' ? value(...args) : value ?? key;
}

const formatInt = (value) => value === undefined || value === null ? '—' : value.toLocaleString(locale);
const bytes = (value) => value === undefined ? '—' : `${value.toLocaleString(locale)} B`;

function effectiveDecodeOnly() {
  return presented ? presented.decodeOnly : isJls(source);
}

function setViewMode(mode) {
  const decodeOnly = effectiveDecodeOnly();
  let next = mode;
  if (decodeOnly && (next === 'compare' || next === 'original')) {
    next = next === 'difference' ? 'difference' : 'reconstruction';
  }
  if (isNarrow() && next === 'compare') next = 'reconstruction';
  if (!isNarrow() && next === 'original') next = decodeOnly ? 'reconstruction' : 'compare';
  viewMode = next;
  setAttr('workspace-view', 'data-view', viewMode);
  for (const tab of document.querySelectorAll?.('.view-tab') ?? []) {
    tab.setAttribute('aria-selected', String(tab.dataset?.view === viewMode));
  }
  onPaint(() => preview.syncOverlays?.());
}

function renderPixel() {
  setText('pixel', selectedPixel ? translate('pixel', selectedPixel) : translate('pickPixel'));
  const frame = presented?.frame;
  const near = frame?.near ?? presented?.near;
  const nearText = near === undefined || near === null ? '—' : String(near);
  setText('inspect-near', selectedPixel || frame ? nearText : '—');
  if (!selectedPixel) {
    setText('inspect-coord', '—');
    setText('inspect-original', '—');
    setText('inspect-reconstructed', '—');
    setText('inspect-error', '—');
    setAttr('inspect-error', 'data-error-level', 'none');
    return;
  }
  setText('inspect-coord', `(${selectedPixel.x}, ${selectedPixel.y})`);
  setText('inspect-reconstructed', formatInt(selectedPixel.reconstructed));
  if (selectedPixel.original === undefined) {
    setText('inspect-original', translate('notCompared'));
    setText('inspect-error', translate('notCompared'));
    setAttr('inspect-error', 'data-error-level', 'none');
  } else {
    setText('inspect-original', formatInt(selectedPixel.original));
    setText('inspect-error', formatInt(selectedPixel.error));
    const level = selectedPixel.error === 0 ? 'exact'
      : (near !== undefined && selectedPixel.error > near ? 'exceeded' : 'within');
    setAttr('inspect-error', 'data-error-level', level);
  }
}

let legendKey = '';

function renderErrorLegend() {
  const frame = presented?.frame;
  const decodeOnly = effectiveDecodeOnly();
  const nextLegendKey = !frame || decodeOnly ? '' : `${locale}:${frame.near}`;
  setText('error-legend-value', frame && !decodeOnly ? translate('legendMax', frame.near) : '—');
  const maxErr = presented?.result?.maxError;
  const boundText = frame && !decodeOnly ? translate('errorBoundSummary', maxErr ?? null, frame.near) : '—';
  setText('error-legend-max', boundText);
  setText('difference-bound', frame && !decodeOnly ? boundText : '');

  const container = get('error-legend-swatches');
  if (!container || typeof document.createElement !== 'function') return;
  if (legendKey === nextLegendKey) return;
  legendKey = nextLegendKey;
  if (!nextLegendKey) {
    container.textContent = '';
    return;
  }
  const stops = errorPalette(frame.near);
  const items = stops.map((stop) => {
    const chip = document.createElement('span');
    chip.className = 'legend-chip';
    const swatch = document.createElement('span');
    swatch.className = 'legend-swatch';
    swatch.style.backgroundColor = stop.hex;
    const label = document.createElement('span');
    label.className = 'legend-chip-label';
    if (stop.value === 0) label.textContent = translate('legendStopExact');
    else if (stop.value === frame.near) label.textContent = translate('legendStopLimit', stop.value);
    else label.textContent = translate('legendStopWithin', stop.value);
    chip.append(swatch, label);
    return chip;
  });
  container.replaceChildren(...items);
}

function renderIdentity() {
  const frame = presented?.frame;
  const decodeOnly = effectiveDecodeOnly();
  const backend = presented?.backend ?? get('backend').value;
  const backendLabel = backend === 'js' ? 'JavaScript' : 'Wasm GC';
  const near = frame?.near ?? (decodeOnly ? null : presented?.near ?? Number(get('near').value));
  const name = source?.name ?? translate('noFile');

  setText('selected', name);
  setText('source-name', name);
  setText('source-spec', !source ? translate('noSourceSpec') : (decodeOnly ? 'JLS' : 'PGM'));
  setText('task-id', presented ? `#${presented.id}` : '—');
  setText('task-meta', [
    backendLabel,
    frame ? `${frame.bits}-bit` : translate('precisionPending'),
    near === null ? translate('nearFromHeader') : `NEAR ${near}`,
  ].join(' · '));

  const sinkSelect = get('sink');
  const sinkValue = sinkSelect?.value ?? 'buffered';
  const sinkText = translate(sinkValue === 'file' ? 'streamed' : sinkValue);
  setText('settings-summary-meta', [
    decodeOnly ? 'JLS' : `NEAR ${near ?? 0}`,
    backendLabel,
    sinkText,
  ].join(' · '));

  setHidden('near-note', !isJls(source));
  setAttr('workspace-view', 'data-reference', decodeOnly ? 'none' : 'available');
  setAttr('workspace-view', 'data-near', frame?.near ?? '');

  if (decodeOnly) {
    setText('error', translate('notCompared'));
    setText('error-bound', '');
  } else if (!presented?.result) {
    setText('error-bound', near === null ? '' : (near === 0 ? translate('errorBoundExact') : translate('errorBoundNear', near)));
  }
  renderErrorScope();

  if (frame) {
    const spec = `${frame.width} × ${frame.height} · ${frame.bits}-bit · NEAR ${frame.near}`;
    setText('frame', spec);
    setText('original-scale', decodeOnly ? '' : `${frame.width} × ${frame.height} · ${frame.bits}-bit`);
    setText('reconstruction-scale', `${frame.width} × ${frame.height} · ${frame.bits}-bit`);
  } else {
    setText('original-scale', '');
    setText('reconstruction-scale', '');
  }

  if (presented) {
    setText('result-backend', backendLabel);
    setText('result-mode', translate(decodeOnly ? 'modeDecodeOnly' : 'modeRoundTrip'));
  } else {
    setText('result-backend', '');
    setText('result-mode', '');
  }

  renderErrorLegend();
  renderPixel();
}

function renderErrorScope() {
  if (effectiveDecodeOnly()) {
    setText('error-scope', translate('streamOnlyCheck'));
    return;
  }
  if (state.phase === 'complete' && presented?.result) {
    setText('error-scope', translate('fullSampleCheck'));
  } else if (state.phase === 'failed' || state.phase === 'cancelled') {
    setText('error-scope', translate('errorScopeUnfinished'));
  } else {
    setText('error-scope', translate('errorScopeIdle'));
  }
}

function renderState() {
  const { phase, message, args } = state;
  for (const id of ['workspace-view', 'phase', 'status']) setAttr(id, 'data-state', phase);
  setText('phase', translate(`phase-${phase}`));
  setText('status', translate(message, ...args));
  setText('pause', translate(active?.paused ? 'resume' : 'pause'));
  const previewState = phase === 'complete' ? (presented?.decodeOnly ? 'streamVerified' : 'samplesVerified')
    : ['failed', 'cancelled'].includes(phase) ? 'previewIncomplete'
      : ['running', 'paused', 'finalizing'].includes(phase) ? 'previewProvisional' : 'previewWaiting';
  setText('preview-state', translate(previewState));
  setText('preview-detail', translate(`${previewState}Detail`));
  renderErrorScope();
}

function transition(phase, message = phase, ...args) {
  if (state.phase === phase && state.message === message && args.length === 0) return;
  state = { phase, message, args };
  renderState();
}

function lock(running) {
  for (const id of controls) {
    const control = get(id);
    if (control) control.disabled = running || (id === 'near' && isJls(source));
  }
  const filePick = get('file')?.parentElement;
  if (filePick?.setAttribute) filePick.setAttribute('data-disabled', String(running));
  const runBtn = get('run');
  if (runBtn) runBtn.disabled = running || source === undefined;
  const pauseBtn = get('pause');
  if (pauseBtn) pauseBtn.disabled = !running || Boolean(active?.closing);
  const cancelBtn = get('cancel');
  if (cancelBtn) cancelBtn.disabled = !running;
}

function renderProgress(job) {
  const { frame, stats } = job ?? {};
  const rows = stats?.rows ?? 0;
  const progress = get('progress');
  if (progress) {
    progress.max = frame?.height ?? 1;
    progress.value = rows;
  }
  const key = state.phase === 'complete' ? 'rowsComplete'
    : ['failed', 'cancelled'].includes(state.phase) ? 'rowsIncomplete' : 'rowsProvisional';
  setText('progress-copy', frame ? translate(key, rows, frame.height) : '—');
  if (stats) {
    setText('workspace', `${bytes(job.encodeWorkspace)} / ${bytes(stats.coreWorkspaceBytes)}`);
    setText('queues', translate('queueValues', bytes(stats.inputQueueBytes), bytes(stats.outputQueueBytes),
      bytes(stats.inputPeakBytes), bytes(stats.outputPeakBytes)));
  }
}

function renderResult(job) {
  if (!job?.result) return;
  const { frame, jlsBytes, maxError } = job.result;
  const raw = frame.width * frame.height * Math.ceil(frame.bits / 8);
  setText('raw-size', bytes(raw));
  setText('encoded', bytes(jlsBytes));
  setText('ratio', `${(raw / jlsBytes).toFixed(2)}×`);
  setText('error', maxError ?? translate('notCompared'));
  setText('error-bound', job.decodeOnly ? '' : (frame.near === 0 ? translate('errorBoundExact') : translate('errorBoundNear', frame.near)));
  setText('error-scope', translate(job.decodeOnly ? 'streamOnlyCheck' : 'fullSampleCheck'));
  setText('latency', `${job.elapsed.toFixed(1)} ms`);
  if (job.firstCanvas !== undefined) setText('first-canvas', `${(job.firstCanvas - job.started).toFixed(1)} ms`);
  renderErrorLegend();
}

function clearOutput() {
  preview.clear();
  selectedPixel = undefined;
  setAttr('workspace-view', 'data-has-image', 'false');
  for (const id of measures) setText(id, '—');
  setHidden('download', true);
  const download = get('download');
  if (download) {
    download.href = '';
    download.download = '';
  }
  if (artifactUrl) URL.revokeObjectURL(artifactUrl);
  artifactUrl = undefined;
  renderPixel();
  renderErrorLegend();
}

function setSource(file) {
  if (active) return;
  source = file;
  presented = undefined;
  clearOutput();
  lock(false);
  transition(file ? 'ready' : 'idle', file ? 'ready' : 'waiting');
  setViewMode(isJls(file) ? 'reconstruction' : (isNarrow() ? 'reconstruction' : 'compare'));
  const drawer = get('settings-drawer');
  if (drawer && isNarrow()) drawer.open = true;
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
  if (!job.hasImageShown && firstCanvas !== undefined) {
    job.hasImageShown = true;
    setAttr('workspace-view', 'data-has-image', 'true');
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
  const job = {
    id: ++sequence, backend: settings.backend, near, decodeOnly,
    abort: new AbortController(), paused: false, workers: [],
  };
  active = job;
  presented = job;
  if (decodeOnly && (viewMode === 'compare' || viewMode === 'original')) {
    setViewMode('reconstruction');
  }
  const drawer = get('settings-drawer');
  if (drawer && isNarrow()) drawer.open = false;
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
      const download = get('download');
      if (download) {
        download.href = artifactUrl;
        download.download = outputName;
        download.hidden = false;
      }
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

for (const id of ['near', 'backend', 'sink']) {
  get(id)?.addEventListener?.('change', renderIdentity);
}
for (const tab of document.querySelectorAll?.('.view-tab') ?? []) {
  tab.addEventListener('click', () => setViewMode(tab.dataset.view));
}
globalThis.addEventListener?.('resize', () => onPaint(() => preview.syncOverlays?.()));

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

const fileSinkOption = get('sink').querySelector?.('[value="file"]');
if (!globalThis.showSaveFilePicker && fileSinkOption) fileSinkOption.disabled = true;

setViewMode(viewMode);
applyLocale();
