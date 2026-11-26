import { CodecError, componentDimensions } from '../sdk/index.mjs';
import { startWorker } from '../sdk/worker-client.mjs';
import { lunarElevationMeters, lunarErrorMeters } from '../sdk/lunar.mjs';
import { createRunId, reconstructionErrorBound, serializeVerificationReport } from '../sdk/verification-report.mjs';
import { finishWorkbenchReport, lunarIdentity, workbenchReport } from './run-report.mjs';
import { strings } from './labels.mjs';
import { openPgm, pgmHeader, pgmRow, sampleByteWidth, sampleMaximum, samplePgm } from './pgm.mjs';
import { encodePpmFromPlanes, openPpm, readPnmHeader } from './ppm.mjs';
import { createPreview, errorLegendStops, previewIds } from './preview.mjs';
import { renderScanInspector } from './scan-inspector.mjs';
import { createPipe, openSink, readBlob } from './transport.mjs';
import { mountBuildIdentity, mountCompatibility } from './compatibility.mjs';

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

const presetFields = ['t1', 't2', 't3', 'reset'];
const encodeControls = new Set(['near', 'point-transform', ...presetFields.map((field) => `preset-${field}`)]);
const controls = ['example', 'sample-rgb8', 'sample-multi16', 'sample-sampling', 'file', 'interleave', 'decode-sample-format', 'backend', 'chunk', 'sink', ...encodeControls];
const measures = ['frame', 'raw-size', 'encoded', 'ratio', 'error', 'latency', 'first-canvas', 'workspace', 'queues', 'host-conv-buffer', 'preview-buffer'];
const isJls = (file) => /\.jls$/i.test(file?.name ?? '');
const isPpm = (file) => /\.ppm$/i.test(file?.name ?? '');
const compCountOf = (frame) => frame?.components?.length ?? 1;
const onPaint = (callback) => globalThis.requestAnimationFrame
  ? globalThis.requestAnimationFrame(callback) : queueMicrotask(callback);
const narrowQuery = globalThis.matchMedia?.('(max-width: 640px)');
const isNarrow = () => Boolean(narrowQuery?.matches);

let locale = 'en';
let source;
let sourceSelection = 0;
let sourcePgm;
let active;
let artifactUrl;
let sequence = 0;
let presented;
let state = { phase: 'idle', message: 'waiting', args: [] };
let selectedPixel;
let viewMode = isNarrow() ? 'reconstruction' : 'compare';
let focusedViewTab = null;
let focusedOriginalCanvas = false;
const preview = createPreview(previewIds.map(get), (pixel) => { selectedPixel = pixel; renderPixel(); },
  previewIds.map((id) => get(`zoom-${id}`)));

function translate(key, ...args) {
  const value = strings[locale][key];
  return typeof value === 'function' ? value(...args) : value ?? key;
}

const formatInt = (value) => value === undefined || value === null ? '—' : value.toLocaleString(locale);
const bytes = (value) => value === undefined ? '—' : `${value.toLocaleString(locale)} B`;
const nearLimit = (maxval = 65535) => Math.min(255, Math.floor(maxval / 2));
const configuredPt = () => Number(get('point-transform')?.value ?? 0);
const planarSampleBytes = (format) => format === 'planar-u32le' ? 4 : format === 'planar-u16le' ? 2 : 0;
const pnmCodedMaxval = (header, pointTransform) => header && (pointTransform ? 2 ** header.bits - 1 : header.maxval);
const firstScan = (job) => job?.structure?.scans?.[0] ?? (job?.frame && {
  ...job.frame, pointTransform: job.frame.pointTransform ?? job.pointTransform,
});
const scanReconstructionBound = (scan) => scan && reconstructionErrorBound(scan.near, scan.pointTransform);
const scaleForScan = (near, pointTransform) => pointTransform
  ? translate('transformedBound', near, reconstructionErrorBound(near, pointTransform))
  : near === 0 ? translate('errorBoundExact') : translate('errorBoundNear', near);

function setNearOptions(limit) {
  const select = get('near');
  if (!select?.options) return;
  const selected = Number(select.value);
  for (let value = select.options.length; value <= limit; value++) {
    select.add(new Option(String(value), String(value)));
  }
  select.options.length = limit + 1;
  select.value = String(Math.min(selected, limit));
}

function effectiveDecodeOnly() {
  return presented ? presented.decodeOnly : isJls(source);
}

function isTabVisible(tab) {
  if (!tab) return false;
  if (typeof globalThis.getComputedStyle === 'function') {
    return globalThis.getComputedStyle(tab).display !== 'none';
  }
  return true;
}

function visibleViewTabs() {
  const decodeOnly = effectiveDecodeOnly();
  const narrow = isNarrow();
  const allowed = decodeOnly
    ? new Set(['reconstruction', 'difference'])
    : narrow
      ? new Set(['original', 'reconstruction', 'difference'])
      : new Set(['compare', 'reconstruction', 'difference']);
  return [...(document.querySelectorAll?.('.view-tab') ?? [])].filter((tab) => {
    const view = tab.dataset?.view;
    return allowed.has(view) && isTabVisible(tab);
  });
}

function setViewMode(mode, { focus = false } = {}) {
  const decodeOnly = effectiveDecodeOnly();
  let next = mode;
  if (decodeOnly && (next === 'compare' || next === 'original')) {
    next = 'reconstruction';
  }
  if (isNarrow() && next === 'compare') next = 'reconstruction';
  if (!isNarrow() && next === 'original') next = decodeOnly ? 'reconstruction' : 'compare';
  viewMode = next;
  setAttr('workspace-view', 'data-view', viewMode);
  let activeTab = null;
  for (const tab of document.querySelectorAll?.('.view-tab') ?? []) {
    const selected = tab.dataset?.view === viewMode;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected) activeTab = tab;
  }
  if (focus && activeTab && isTabVisible(activeTab)) {
    activeTab.focus?.();
  }
  onPaint(() => preview.syncOverlays?.());
}

function channelLabelsFor(job) {
  const count = compCountOf(job?.frame);
  const roles = job?.file?.moonjlsMeta?.channelRoles;
  if (Array.isArray(roles) && roles.length >= count) {
    return roles.slice(0, count);
  }
  if (!job?.decodeOnly && job?.inputFormat === 'ppm' && count === 3) {
    return ['R', 'G', 'B'];
  }
  return Array.from({ length: count }, (_, idx) => `C${idx}`);
}

function provenanceKeyFor(job) {
  const metaKey = job?.file?.moonjlsMeta?.labelKey;
  if (metaKey === 'sampleRgb8Desc') return 'provenanceRgb8';
  if (metaKey === 'sampleMulti16Desc') return 'provenanceMulti16';
  if (metaKey === 'sampledLilyDesc') return 'provenanceSampledLily';
  if (job?.decodeOnly) return 'provenanceJlsUnknown';
  if (job?.inputFormat === 'ppm') return 'provenancePpm';
  return 'provenancePgm';
}

function renderMulticomponent(job) {
  const count = compCountOf(job?.frame);
  const show = Boolean(job?.frame && count > 1);
  setHidden('multicomponent-panel', !show);
  if (!show) return;
  const labels = channelLabelsFor(job);
  setText('mc-provenance-badge', translate(provenanceKeyFor(job)));
  setHidden('sampled-preview-note', !job.sampledGeometry);
  if (job.sampledGeometry) {
    const c = job.activeChannel ?? 0;
    const { widths, heights } = job.componentGeometry;
    setText('reconstruction-scale', `${widths[c]} × ${heights[c]} · ${job.frame.bits}-bit`);
  }

  const btnWrap = get('channel-buttons');
  if (btnWrap && typeof document.createElement === 'function') {
    const composite = job.canComposite;
    const options = composite
      ? [{ id: 'composite', label: translate('channelComposite'), compAttr: 'composite' },
         ...labels.map((label, idx) => ({ id: idx, label, compAttr: String(idx) }))]
      : labels.map((label, idx) => ({ id: idx, label, compAttr: String(idx) }));
    const activeCh = job.activeChannel ?? (composite ? 'composite' : 0);
    btnWrap.replaceChildren(...options.map((opt) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'channel-pill';
      btn.dataset.comp = opt.compAttr;
      btn.textContent = opt.label;
      btn.setAttribute('aria-pressed', String(activeCh === opt.id));
      btn.addEventListener('click', () => {
        job.activeChannel = opt.id;
        preview.setChannel(opt.id);
        renderMulticomponent(job);
      });
      return btn;
    }));
  }

  const progWrap = get('multicomponent-progress');
  if (progWrap && typeof document.createElement === 'function') {
    const { heights } = job.componentGeometry;
    const scans = job.structure?.scans ?? [];
    const eoiDone = job.status === 'passed';
    progWrap.replaceChildren(...labels.map((label, idx) => {
      const scan = scans.find((entry) => (entry.componentIndices ?? [entry.componentIndex]).includes(idx));
      const delivered = job.compRows?.[idx] ?? 0;
      let statusKey = 'mcWait';
      let stateAttr = 'wait';
      if (eoiDone) {
        statusKey = 'mcVerified';
        stateAttr = 'verified';
      } else if (job.status === 'failed' || job.status === 'cancelled') {
        statusKey = `phase-${job.status}`;
        stateAttr = job.status;
      } else if (delivered === heights[idx]) {
        statusKey = 'mcRowsProvisional';
        stateAttr = 'provisional';
      } else if (scan?.completed || job.completedScans?.has?.(scan?.scanIndex)) {
        statusKey = 'mcScanProvisional';
        stateAttr = 'provisional';
      } else if (delivered > 0) {
        statusKey = 'mcActive';
        stateAttr = 'active';
      }
      const chip = document.createElement('span');
      chip.className = 'mc-progress-chip';
      chip.dataset.comp = String(idx);
      chip.dataset.scanState = stateAttr;
      chip.textContent = `${label}: ${delivered}/${heights[idx]} · ${translate(statusKey)}`;
      const stats = job.componentStats[idx];
      const metrics = document.createElement('small');
      metrics.className = 'mc-component-metrics';
      metrics.textContent = translate('componentMetrics', formatInt(stats.maxError), stats.verified
        ? (stats.absoluteError / stats.verified).toLocaleString(locale, { maximumFractionDigits: 3 })
        : '—', formatInt(stats.verified), formatInt(stats.total - stats.verified));
      chip.append(metrics);
      return chip;
    }));
  }
}

function renderInspector(job) {
  renderScanInspector({
    structure: job?.structure ?? null,
    selectedScanIndex: job?.selectedScanIndex ?? -1,
    channelNames: job ? channelLabelsFor(job) : null,
    errorLocation: job?.errorLocation ?? null,
    errorMessage: job?.errorMessage ?? null,
    translate,
    onSelectScan(scan) {
      if (!job) return;
      job.selectedScanIndex = scan.scanIndex;
      if (compCountOf(job.frame) > 1) {
        job.activeChannel = scan.componentIndex;
        preview.setChannel(scan.componentIndex);
      }
      renderPrecision(job);
      renderMulticomponent(job);
      renderInspector(job);
    },
  });
}

function renderPixel() {
  setHidden('magnifier', !selectedPixel);
  setText('pixel', selectedPixel ? translate('pixel', selectedPixel) : translate('pickPixel'));
  const frame = presented?.frame;
  const physical = presented?.pgm?.lunar && selectedPixel?.original !== undefined;
  setHidden('pixel-physical', !physical);
  if (physical) {
    setText('pixel-physical', translate('physicalPixel',
      formatInt(lunarElevationMeters(selectedPixel.original)),
      formatInt(lunarElevationMeters(selectedPixel.reconstructed)),
      formatInt(lunarErrorMeters(selectedPixel.error))));
  }
  const scan = firstScan(presented);
  const near = selectedPixel?.near ?? scan?.near ?? presented?.near;
  const pt = selectedPixel?.pointTransform ?? scan?.pointTransform ?? 0;
  const nearText = selectedPixel?.mappingSelector
    ? translate('mappedNear', selectedPixel.codedNear, selectedPixel.mappingSelector)
    : selectedPixel && pt
      ? translate('transformedBound', selectedPixel.codedNear, near)
      : near === undefined || near === null ? '—' : String(near);
  setText('inspect-near', selectedPixel || frame ? nearText : '—');
  const compWrap = get('inspect-components');
  if (!selectedPixel) {
    setText('inspect-coord', '—');
    setText('inspect-original', '—');
    setText('inspect-reconstructed', '—');
    setText('inspect-error', '—');
    setAttr('inspect-error', 'data-error-level', 'none');
    if (compWrap) {
      compWrap.replaceChildren();
      compWrap.hidden = true;
    }
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
  if (compWrap && typeof document.createElement === 'function') {
    const comps = selectedPixel.components;
    if (Array.isArray(comps) && comps.length > 1) {
      compWrap.hidden = false;
      compWrap.replaceChildren(...comps.map((c) => {
        const card = document.createElement('span');
        card.className = 'inspect-comp-card';
        card.dataset.compIndex = String(c.index);
        const limit = c.mappingSelector ? translate('mappedNear', c.codedNear, c.mappingSelector)
          : c.pointTransform ? translate('transformedBound', c.codedNear, c.near) : `NEAR ${c.near ?? 0}`;
        card.textContent = c.original === undefined
          ? `${c.label}: ${formatInt(c.reconstructed)} (${limit})`
          : `${c.label}: ${formatInt(c.original)} -> ${formatInt(c.reconstructed)} (|e|=${formatInt(c.error)}, ${limit})`;
        return card;
      }));
    } else {
      compWrap.replaceChildren();
      compWrap.hidden = true;
    }
  }
}

let legendKey = '';

function renderErrorLegend() {
  const frame = presented?.frame;
  const decodeOnly = effectiveDecodeOnly();
  const scan = firstScan(presented);
  const pt = scan?.pointTransform ?? 0;
  const bound = scanReconstructionBound(scan);
  const nextLegendKey = !frame || decodeOnly ? '' : `${locale}:${pt}:${bound}`;
  setText('error-legend-value', frame && !decodeOnly ? translate(pt ? 'originalLegendLimit' : 'legendMax', bound) : '—');
  const maxErr = presented?.result?.maxError;
  const boundText = frame && !decodeOnly ? translate('errorBoundSummary', maxErr ?? null, bound) : '—';
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
  const stops = errorLegendStops(bound);
  const items = stops.map((stop) => {
    const chip = document.createElement('span');
    chip.className = 'legend-chip';
    const swatch = document.createElement('span');
    swatch.className = 'legend-swatch';
    swatch.style.backgroundColor = stop.hex;
    const label = document.createElement('span');
    label.className = 'legend-chip-label';
    if (stop.value === 0) label.textContent = translate('legendStopExact');
    else if (stop.value === bound) label.textContent = translate(pt ? 'originalLegendStop' : 'legendStopLimit', stop.value);
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
  const scan = firstScan(presented);
  const near = scan?.near ?? (decodeOnly ? null : presented?.near ?? Number(get('near').value));
  const pt = scan?.pointTransform ?? (decodeOnly ? 0 : presented?.pointTransform ?? configuredPt());
  const name = source?.name ?? translate('noFile');

  setText('selected', name);
  setText('source-name', name);
  const specLabel = !source ? translate('noSourceSpec')
    : (decodeOnly ? 'JLS' : ((isPpm(source) || sourcePgm?.header?.magic === 'P6') ? 'PPM' : 'PGM'));
  setText('source-spec', specLabel);
  setText('task-id', presented ? `#${presented.id}` : '—');
  const compCount = compCountOf(frame);
  setText('task-meta', [
    backendLabel,
    frame ? (compCount > 1 ? `${compCount}ch ${frame.bits}-bit` : `${frame.bits}-bit`) : translate('precisionPending'),
    near === null ? translate('nearFromHeader') : `NEAR ${near}`,
    ...(pt ? [translate('scanPt', pt)] : []),
  ].join(' · '));

  const formDecodeOnly = isJls(source);
  const formPpm = isPpm(source) || sourcePgm?.header?.magic === 'P6';
  setHidden('interleave-setting', !formPpm);
  setHidden('point-transform-setting', formDecodeOnly);
  setHidden('decode-sample-format-setting', !formDecodeOnly);
  const formBackend = get('backend')?.value ?? 'wasm-gc';
  const formBackendLabel = formBackend === 'js' ? 'JavaScript' : 'Wasm GC';
  const formNear = Number(get('near')?.value ?? 0);
  const sinkSelect = get('sink');
  const sinkValue = sinkSelect?.value ?? 'buffered';
  const sinkText = translate(sinkValue === 'file' ? 'streamed' : sinkValue);
  setText('settings-summary-meta', [
    formDecodeOnly ? 'JLS' : `NEAR ${formNear}`,
    ...(formDecodeOnly && get('decode-sample-format').value === 'u32' ? [translate('wideSamples')] : []),
    ...(!formDecodeOnly && configuredPt() ? [translate('scanPt', configuredPt())] : []),
    ...(formPpm ? [`ILV ${get('interleave')?.value ?? 0}`] : []),
    formBackendLabel,
    sinkText,
  ].join(' · '));

  const sourceMaxval = pnmCodedMaxval(sourcePgm?.header, configuredPt());
  setHidden('near-note', !formDecodeOnly && sourceMaxval === undefined);
  if (formDecodeOnly) setText('near-note', translate('nearFromHeader'));
  else if (sourceMaxval !== undefined) setText('near-note', translate('nearRange', nearLimit(sourceMaxval)));
  setAttr('workspace-view', 'data-reference', decodeOnly ? 'none' : 'available');
  setAttr('workspace-view', 'data-near', frame?.near ?? '');

  if (decodeOnly) {
    setText('error', translate('notCompared'));
    setText('error-bound', '');
  } else if (!presented?.result) {
    setText('error-bound', near === null ? '' : scaleForScan(near, pt));
  }
  renderErrorScope();

  if (frame) {
    const spec = compCount > 1
      ? `${frame.width} × ${frame.height} · ${compCount} ch · ${frame.bits}-bit · NEAR ${frame.near}`
      : `${frame.width} × ${frame.height} · ${frame.bits}-bit · NEAR ${frame.near}`;
    const paneScale = compCount > 1
      ? `${frame.width} × ${frame.height} · ${compCount} ch · ${frame.bits}-bit`
      : `${frame.width} × ${frame.height} · ${frame.bits}-bit`;
    setText('frame', spec);
    const displayMaxval = presented?.file?.moonjlsMeta?.displayMaxval;
    const scale = displayMaxval === undefined ? paneScale : `${paneScale} · ${translate('displayScale', displayMaxval)}`;
    setText('original-scale', decodeOnly ? '' : scale);
    setText('reconstruction-scale', scale);
  } else {
    setText('original-scale', '');
    setText('reconstruction-scale', '');
  }

  if (presented) {
    setText('result-backend', backendLabel);
    const sampleBytes = planarSampleBytes(presented.outputFormat);
    setText('raw-sample-size', sampleBytes ? translate('planarSampleSize', sampleBytes) : translate('ratioBasis'));
    setText('result-mode', translate(decodeOnly ? 'modeDecodeOnly' : 'modeRoundTrip'));
  } else {
    setText('result-backend', '');
    setText('result-mode', '');
  }

  renderErrorLegend();
  renderPixel();
  renderPrecision(presented);
  renderMulticomponent(presented);
  renderInspector(presented);
}

function renderPrecision(job) {
  const selectedScan = job?.structure?.scans?.[job.selectedScanIndex] ?? firstScan(job);
  const frame = job?.frame;
  const preset = selectedScan?.preset ?? job?.preset;
  const effectiveNear = selectedScan?.near;
  const effectiveMaxval = preset?.maxval ?? frame?.maxval ?? (frame ? 2 ** frame.bits - 1 : undefined);
  const effectivePt = selectedScan?.pointTransform ?? 0;
  setText('precision-bits', formatInt(frame?.bits));
  setText('precision-maxval', formatInt(effectiveMaxval));
  setText('precision-near', formatInt(effectiveNear));
  setHidden('precision-pt-field', !effectivePt);
  setText('precision-pt', formatInt(effectivePt));
  for (const field of presetFields) setText(`precision-${field}`, formatInt(preset?.[field]));
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
    const ppm = isPpm(source) || sourcePgm?.header?.magic === 'P6';
    if (control) control.disabled = running ||
      (id === 'interleave' && (!ppm || Boolean(sourcePgm?.pending))) ||
      (id === 'decode-sample-format' && !isJls(source)) ||
      (encodeControls.has(id) && (isJls(source) || Boolean(sourcePgm?.pending)));
  }
  const filePick = get('file')?.parentElement;
  if (filePick?.setAttribute) filePick.setAttribute('data-disabled', String(running));
  const runBtn = get('run');
  if (runBtn) runBtn.disabled = running || source === undefined || Boolean(sourcePgm?.pending);
  const pauseBtn = get('pause');
  if (pauseBtn) pauseBtn.disabled = !running || Boolean(active?.closing);
  const cancelBtn = get('cancel');
  if (cancelBtn) cancelBtn.disabled = !running;
}

function renderProgress(job) {
  const { frame, stats } = job ?? {};
  const rows = stats?.rows ?? 0;
  const totalRows = job?.totalRows ?? 1;
  const progress = get('progress');
  if (progress) {
    progress.max = totalRows;
    progress.value = Math.min(rows, totalRows);
  }
  const key = state.phase === 'complete' ? 'rowsComplete'
    : ['failed', 'cancelled'].includes(state.phase) ? 'rowsIncomplete' : 'rowsProvisional';
  setText('progress-copy', frame ? translate(key, rows, totalRows) : '—');
  if (stats) {
    setText('workspace', `${bytes(job.encodeWorkspace)} / ${bytes(stats.coreWorkspaceBytes)}`);
    setText('queues', translate('queueValues', bytes(stats.inputQueueBytes), bytes(stats.outputQueueBytes),
      bytes(stats.inputPeakBytes), bytes(stats.outputPeakBytes)));
  }
  setText('stream-chunk', job ? `${formatInt(job.settings.inputChunkSize)} / ${formatInt(job.settings.outputChunkSize)}` : formatInt());
  setText('stream-input', job ? `${bytes(job.inputBytes.encode)} / ${bytes(job.inputBytes.decode)}` : formatInt());
  setText('stream-output', bytes(job?.outputBytes));
  setText('stream-rows', job ? `${formatInt(job.rowsDelivered)} / ${formatInt(job.status === 'passed' ? 0 : job.rowsDelivered)}` : formatInt());
  setText('stream-first-row', stats?.firstRowMs == null ? formatInt() : `${stats.firstRowMs.toFixed(2)} ms`);
  setText('stream-acks', formatInt(job?.acknowledgedEvents));
  setText('stream-peak-ack', job?.peakHostAckMs == null ? formatInt() : `${job.peakHostAckMs.toFixed(2)} ms`);
  setText('host-conv-buffer', job ? bytes(job.hostConversionBufferBytes ?? 0) : '—');
  setText('preview-buffer', job ? bytes(job.previewBufferBytes ?? preview.bufferBytes()) : '—');
  renderMulticomponent(job);
  renderInspector(job);
}

function renderResult(job) {
  if (!job?.result) return;
  const { frame, jlsBytes, maxError } = job.result;
  const planarBytes = planarSampleBytes(job.outputFormat);
  const bytesPerSample = planarBytes || sampleByteWidth(job.pgmHeader?.maxval ?? job.pnmOutputMaxval ?? sampleMaximum(frame));
  const raw = job.componentGeometry.total * bytesPerSample;
  setText('raw-size', bytes(raw));
  setText('raw-sample-size', planarBytes ? translate('planarSampleSize', planarBytes) : translate('ratioBasis'));
  setText('encoded', bytes(jlsBytes));
  setText('ratio', `${(raw / jlsBytes).toFixed(2)}×`);
  setText('error', maxError ?? translate('notCompared'));
  const scan = firstScan(job);
  setText('error-bound', job.decodeOnly ? '' : scaleForScan(scan.near, scan.pointTransform));
  setText('error-scope', translate(job.decodeOnly ? 'streamOnlyCheck' : 'fullSampleCheck'));
  setText('latency', `${job.elapsed.toFixed(1)} ms`);
  if (job.firstCanvas !== undefined) setText('first-canvas', `${(job.firstCanvas - job.started).toFixed(1)} ms`);
  setText('host-conv-buffer', bytes(job.hostConversionBufferBytes ?? 0));
  setText('preview-buffer', bytes(job.previewBufferBytes ?? preview.bufferBytes()));
  renderErrorLegend();
  renderPrecision(job);
  renderMulticomponent(job);
  renderInspector(job);
}

function renderPhysicalBudget(job) {
  const physical = job?.pgm?.lunar && job.frame;
  setHidden('physical-budget', !physical);
  if (physical) {
    setText('physical-budget-value', translate('physicalBudget',
      formatInt(lunarErrorMeters(scanReconstructionBound(firstScan(job)))),
      formatInt(job.observedError === undefined ? null : lunarErrorMeters(job.observedError))));
  }
}

function clearOutput() {
  preview.clear();
  selectedPixel = undefined;
  setAttr('workspace-view', 'data-has-image', 'false');
  for (const id of measures) setText(id, '—');
  setText('raw-sample-size', translate('ratioBasis'));
  setHidden('download', true);
  setHidden('export-report', true);
  setHidden('physical-budget', true);
  setHidden('pixel-physical', true);
  setText('report-error', '');
  setHidden('report-error', true);
  const download = get('download');
  if (download) {
    download.href = '';
    download.download = '';
  }
  if (artifactUrl) URL.revokeObjectURL(artifactUrl);
  artifactUrl = undefined;
  renderPixel();
  renderErrorLegend();
  setHidden('multicomponent-panel', true);
  renderInspector(null);
}

function setSource(file) {
  if (active) return;
  sourceSelection++;
  source = file;
  const pgm = file && !isJls(file) ? {} : undefined;
  sourcePgm = pgm;
  if (pgm) {
    void lunarIdentity(file).then((identity) => {
      pgm.lunar = identity;
      if (sourcePgm !== pgm || presented?.pgm !== pgm) return;
      renderPixel();
      renderPhysicalBudget(presented);
    });
    pgm.pending = readPnmHeader(file).then(
      (header) => { pgm.header = header; },
      (error) => { pgm.error = error; },
    ).then(() => {
      pgm.pending = undefined;
      if (sourcePgm !== pgm) return;
      setNearOptions(nearLimit(pnmCodedMaxval(pgm.header, configuredPt())));
      lock(false);
      renderIdentity();
    });
  }
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
  const count = compCountOf(frame);
  job.compRows ??= Array(count).fill(0);
  job.componentGeometry = componentDimensions(frame);
  const { widths, heights } = job.componentGeometry;
  job.totalRows = heights.reduce((total, height) => total + height, 0);
  job.sampledGeometry = widths.some((width, i) => width !== frame.width || heights[i] !== frame.height);
  job.canComposite = count === 3 && !job.sampledGeometry && (job.file.moonjlsMeta?.composite ?? true);
  job.componentStats = widths.map((width, index) => ({
    index, id: frame.components?.[index]?.id ?? 1, total: width * heights[index],
    verified: 0, maxError: null, absoluteError: 0,
  }));
  if (job.activeChannel === undefined) job.activeChannel = job.canComposite ? 'composite' : 0;
  renderIdentity();
  renderPhysicalBudget(job);
}

function recordStats(job, stats, frame, structure) {
  requireActive(job);
  if (structure) job.structure = structure;
  setFrame(job, frame);
  job.stats = stats;
  const totalRows = job.totalRows ?? 0;
  if (totalRows > 0 && stats.rows === totalRows && !job.rowsArrived) {
    job.rowsArrived = true;
    if (!job.paused) transition('finalizing', 'finishingStream');
    renderProgress(job);
    return;
  }
  scheduleProgress(job);
}

function scheduleProgress(job) {
  if (job.paintPending) return;
  job.paintPending = true;
  onPaint(() => {
    job.paintPending = false;
    if (active === job && !job.abort.signal.aborted) renderProgress(job);
  });
}

function draw(job, index, reconstructed, original, meta) {
  const firstCanvas = preview.drawRow(index, reconstructed, original, meta);
  job.rowsDelivered++;
  const compIdx = meta?.componentIndex ?? 0;
  job.compRows ??= Array(compCountOf(job.frame)).fill(0);
  if (compIdx >= 0 && compIdx < job.compRows.length) job.compRows[compIdx]++;
  job.previewBufferBytes = preview.bufferBytes();
  if (firstCanvas !== undefined && job.firstCanvas === undefined) job.firstCanvas = firstCanvas;
  if (!job.hasImageShown && firstCanvas !== undefined) {
    job.hasImageShown = true;
    setAttr('workspace-view', 'data-has-image', 'true');
  }
}

async function writeOutput(job, sink, bytes, position = undefined) {
  if (position === undefined) await sink.write(bytes);
  else await sink.writeAt(bytes, position);
  requireActive(job);
  job.outputBytes += bytes.byteLength;
}

function launch(job, options) {
  requireActive(job);
  job.stages[options.mode] = 'incomplete';
  const worker = startWorker({
    ...options, signal: job.abort.signal,
    async read(capacity) {
      requireActive(job);
      const chunk = await options.read(capacity);
      requireActive(job);
      if (chunk) job.inputBytes[options.mode] += chunk.byteLength;
      return chunk;
    },
    async onEvent(event) {
      requireActive(job);
      if (event.structure) job.structure = event.structure;
      if (event.type === 'scanComplete' && event.scan) {
        job.completedScans ??= new Set();
        job.completedScans.add(event.scan.scanIndex);
      }
      if (!job.preset && event.preset) {
        job.preset = event.preset;
        renderPrecision(job);
      }
      await options.onEvent?.(event);
    },
    onAck(_event, elapsedMs) {
      if (active !== job || job.abort.signal.aborted) return;
      job.acknowledgedEvents++;
      job.peakHostAckMs = Math.max(job.peakHostAckMs ?? 0, elapsedMs);
      scheduleProgress(job);
    },
  });
  job.workers.push(worker);
  if (job.paused) worker.pause();
  return worker.result.then((result) => {
    if (!job.status) {
      job.stages[options.mode] = 'passed';
      job.preset ??= result.preset;
      if (result.structure) job.structure = result.structure;
      renderPrecision(job);
    }
    return result;
  }, (error) => {
    if (!job.status) job.stages[options.mode] = error.code === 'Cancelled' ? 'cancelled' : 'failed';
    throw error;
  });
}

async function decodeFile(job, file, settings, sink) {
  let configured = false;
  let planes = null;
  let pgmFrame;
  let componentCount = 1;
  const wide = job.sampleFormat === 'u32';
  const sampleBytes = wide ? 4 : 2;
  const baseName = file.name.replace(/\.[^.]+$/, '');
  const handleRow = async (frame, index, row, meta) => {
    if (!configured) {
      configured = true;
      componentCount = compCountOf(frame);
      setFrame(job, frame);
      preview.configure(frame, false, {
        componentCount,
        componentLabels: channelLabelsFor(job),
        initialChannel: job.activeChannel,
        allowComposite: job.canComposite,
        sampleFormat: job.sampleFormat,
      });
      if (wide) {
        job.outputName = `${baseName}.planar-u32le.raw`;
        job.outputFormat = 'planar-u32le';
      } else if (componentCount === 1) {
        job.outputName = `${baseName}.pgm`;
        job.outputFormat = 'pgm';
        job.hostConversionBufferBytes = 0;
        pgmFrame = meta.mappingSelector ? { ...frame, maxval: 255 } : frame;
        await writeOutput(job, sink, pgmHeader(pgmFrame));
      } else if (componentCount === 3 && !job.sampledGeometry) {
        job.outputName = `${baseName}.ppm`;
        job.outputFormat = 'ppm';
        const px = frame.width * frame.height;
        planes = [new Uint16Array(px), new Uint16Array(px), new Uint16Array(px)];
        job.hostConversionBufferBytes = planes.reduce((acc, p) => acc + p.byteLength, 0);
      } else {
        job.outputName = `${baseName}.planar-u16le.raw`;
        job.outputFormat = 'planar-u16le';
        job.hostConversionBufferBytes = 0;
      }
    }
    const rowMaxval = meta.mappingSelector ? 255 : sampleMaximum({
      ...frame, pointTransform: meta.pointTransform, maxval: meta.preset?.maxval ?? frame.maxval,
    });
    job.pnmOutputMaxval = Math.max(job.pnmOutputMaxval ?? 0, rowMaxval);
    draw(job, index, row, null, meta);
    const compIdx = meta.componentIndex;
    if (planes) {
      planes[compIdx].set(row, index * frame.width);
    } else if (wide || job.outputFormat === 'planar-u16le') {
      const { widths, offsets } = job.componentGeometry;
      const samples = new Uint8Array(row.length * sampleBytes);
      const view = new DataView(samples.buffer);
      if (wide) {
        for (let x = 0; x < row.length; x++) view.setUint32(x * 4, row[x], true);
      } else {
        for (let x = 0; x < row.length; x++) view.setUint16(x * 2, row[x], true);
      }
      job.hostConversionBufferBytes = Math.max(job.hostConversionBufferBytes, samples.byteLength);
      await writeOutput(job, sink, samples, (offsets[compIdx] + index * widths[compIdx]) * sampleBytes);
    } else {
      await writeOutput(job, sink, pgmRow(row, pgmFrame));
    }
  };
  const result = await launch(job, {
    ...settings, mode: 'decode', sampleFormat: job.sampleFormat, read: readBlob(file),
    maxBatchBytes: settings.inputChunkSize >= 256 ? 16384 : 0,
    async onEvent(event) {
      recordStats(job, event.stats, event.frame, event.structure);
      const rowMeta = {
        scanIndex: event.scanIndex ?? 0,
        componentIndex: event.componentIndex ?? 0,
        componentId: event.componentId ?? 1,
        near: event.near ?? event.frame?.near,
        pointTransform: event.pointTransform ?? 0,
        mappingSelector: event.mappingSelector,
        preset: event.preset,
      };
      if (event.type === 'row') {
        await handleRow(event.frame, event.index, event.row, rowMeta);
      } else if (event.type === 'rows') {
        const w = event.stride ?? event.frame.width;
        for (let i = 0; i < event.count; i++) {
          await handleRow(event.frame, event.startIndex + i, event.samples.subarray(i * w, (i + 1) * w), rowMeta);
        }
      }
    },
  });
  requireActive(job);
  if (planes) {
    const ppmOut = encodePpmFromPlanes({ ...result.frame, maxval: job.pnmOutputMaxval, pointTransform: 0 }, planes);
    job.hostConversionBufferBytes = planes.reduce((acc, p) => acc + p.byteLength, 0) + ppmOut.hostConversionBufferBytes;
    await writeOutput(job, sink, ppmOut.bytes);
  }
  return { ...result, jlsBytes: result.stats.inputConsumed, maxError: null };
}

async function roundTrip(job, file, near, settings, sink) {
  const isPpmInput = job.pgmHeader?.magic === 'P6' || isPpm(file);
  job.inputFormat = isPpmInput ? 'ppm' : 'pgm';
  job.outputFormat = 'jls';
  const input = isPpmInput
    ? await openPpm(file, near, job.abort.signal, job.pgmHeader, file.moonjlsMeta?.channelRoles, job.interleave)
    : await openPgm(file, near, job.abort.signal, job.pgmHeader);
  requireActive(job);
  job.hostConversionBufferBytes = input.hostConversionBufferBytes ?? 0;
  setFrame(job, input.frame);
  const componentCount = compCountOf(input.frame);
  const pipe = createPipe();
  let configured = false;
  let maxError = 0;
  const handleRow = async (frame, index, row, meta) => {
    if (!configured) {
      configured = true;
      preview.configure(frame, true, {
        componentCount,
        componentLabels: channelLabelsFor(job),
        initialChannel: job.activeChannel,
        allowComposite: job.canComposite,
        displayMaxval: file.moonjlsMeta?.displayMaxval,
        sourceMaxval: sampleMaximum(input.frame),
        sampleFormat: job.sampleFormat,
      });
    }
    const compIdx = meta?.componentIndex ?? 0;
    const allowedNear = meta?.near ?? near;
    const pointTransform = meta?.pointTransform ?? job.pointTransform;
    const reconstructionBound = reconstructionErrorBound(allowedNear, pointTransform);
    const original = await input.row(index, compIdx);
    requireActive(job);
    job.stages.compare = 'incomplete';
    const stats = job.componentStats[compIdx];
    let rowMax = 0;
    let codedRowMax = 0;
    for (let i = 0; i < row.length; i++) {
      const diff = Math.abs(original[i] - row[i]);
      rowMax = Math.max(rowMax, diff);
      const codedError = Math.abs((original[i] >>> pointTransform) - (row[i] >>> pointTransform));
      codedRowMax = Math.max(codedRowMax, codedError);
      stats.absoluteError += diff;
    }
    stats.maxError = Math.max(stats.maxError ?? 0, rowMax);
    stats.verified += row.length;
    maxError = Math.max(maxError, rowMax);
    job.verifiedSamples = (job.verifiedSamples ?? 0) + row.length;
    job.observedError = maxError;
    job.observedCodedError = Math.max(job.observedCodedError ?? 0, codedRowMax);
    if (codedRowMax > allowedNear || rowMax > reconstructionBound) {
      job.stages.compare = 'failed';
      throw new Error(`Row ${index}: coded error ${codedRowMax} (NEAR ${allowedNear}), original error ${rowMax} (bound ${reconstructionBound})`);
    }
    draw(job, index, row, original, meta);
  };
  const decoded = launch(job, {
    ...settings, mode: 'decode', sampleFormat: job.sampleFormat, read: pipe.read,
    maxBatchBytes: settings.inputChunkSize >= 256 ? 16384 : 0,
    async onEvent(event) {
      recordStats(job, event.stats, event.frame, event.structure);
      const rowMeta = {
        scanIndex: event.scanIndex ?? 0,
        componentIndex: event.componentIndex ?? 0,
        componentId: event.componentId ?? 1,
        near: event.near ?? event.frame?.near ?? near,
        pointTransform: event.pointTransform ?? 0,
        preset: event.preset,
      };
      if (event.type === 'row') {
        await handleRow(event.frame, event.index, event.row, rowMeta);
      } else if (event.type === 'rows') {
        const w = event.stride ?? event.frame.width;
        for (let i = 0; i < event.count; i++) {
          await handleRow(event.frame, event.startIndex + i, event.samples.subarray(i * w, (i + 1) * w), rowMeta);
        }
      }
    },
  });
  const encodeFrame = { ...input.frame, preset: job.requestedPreset };
  if (job.pointTransform) {
    encodeFrame.pointTransform = job.pointTransform;
    delete encodeFrame.maxval; // Netpbm MAXVAL describes original samples, not the transformed coding range.
  }
  const encoded = launch(job, {
    ...settings, mode: 'encode', frame: encodeFrame, read: input.read,
    async onEvent(event) {
      requireActive(job);
      job.encodeWorkspace = event.stats.coreWorkspaceBytes;
      job.encodedStats = event.stats;
      job.hostConversionBufferBytes = input.hostConversionBufferBytes ?? 0;
      if (event.type === 'bytes') {
        await writeOutput(job, sink, event.chunk);
        await pipe.write(event.chunk);
        requireActive(job);
      }
    },
  }).then((result) => {
    requireActive(job);
    job.encodeWorkspace = result.stats.coreWorkspaceBytes;
    job.encodedStats = result.stats;
    pipe.close();
    return result;
  });
  try {
    const [fromEncode, fromDecode] = await Promise.all([encoded, decoded]);
    requireActive(job);
    if (job.verifiedSamples !== input.frame.width * input.frame.height * componentCount) {
      job.stages.compare = 'failed';
      throw new Error('Round-trip comparison did not verify every sample');
    }
    job.stages.compare = 'passed';
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
  const pgm = sourcePgm;
  if (pgm?.pending) {
    await pgm.pending;
    if (active || sourcePgm !== pgm) return;
  }
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
  const pointTransform = decodeOnly ? 0 : configuredPt();
  if (!Number.isInteger(pointTransform) || pointTransform < 0 || pointTransform > 15) {
    transition('failed', 'invalidPointTransform');
    return;
  }
  const sampleFormat = (decodeOnly ? get('decode-sample-format').value === 'u32' : pointTransform > 0) ? 'u32' : 'u16';
  const outputFormat = decodeOnly ? (sampleFormat === 'u32' ? 'planar-u32le' : 'pgm') : 'jls';
  const defaultOutExt = outputFormat === 'planar-u32le' ? '.planar-u32le.raw'
    : decodeOnly ? (sinkMode === 'file' ? '.decoded' : '.pgm') : '.jls';
  const outputName = file.name.replace(/\.[^.]+$/, '') + defaultOutExt;
  const settings = { backend: get('backend').value, inputChunkSize: chunk, outputChunkSize: Math.min(chunk, 32 * 1024) };
  const requestedPreset = Object.fromEntries(presetFields.map((field) => [field, Number(get(`preset-${field}`)?.value ?? 0)]));
  const job = {
    id: ++sequence, runId: createRunId(), backend: settings.backend, near, decodeOnly, pgmHeader: pgm?.header,
    interleave: Number(get('interleave')?.value ?? 0), pointTransform,
    inputFormat: decodeOnly ? 'jls' : (pgm?.header?.magic === 'P6' || isPpm(file) ? 'ppm' : 'pgm'),
    outputFormat, sampleFormat,
    file, outputName, sinkMode, settings, pgm, rowsDelivered: 0,
    hostConversionBufferBytes: 0, previewBufferBytes: 0, selectedScanIndex: -1,
    completedScans: new Set(), errorLocation: null, errorMessage: null,
    requestedPreset, inputBytes: { encode: 0, decode: 0 }, acknowledgedEvents: 0,
    stages: { encode: 'not_run', decode: 'not_run', compare: 'not_run' },
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
    if (pgm?.error) throw pgm.error;
    const type = outputFormat === 'planar-u32le' ? 'application/octet-stream'
      : decodeOnly ? 'image/x-portable-graymap' : 'image/jls';
    sink = await openSink(sinkMode, outputName, type);
    requireActive(job);
    job.fileOutputName = sink.name;
    job.started = performance.now();
    job.outputBytes = 0;
    if (!job.paused) transition('running');
    const result = await (decodeOnly ? decodeFile(job, file, settings, sink) : roundTrip(job, file, near, settings, sink));
    requireActive(job);
    job.closing = true;
    job.paused = false;
    setFrame(job, result.frame);
    job.stats = result.stats;
    job.structure = result.structure ?? job.structure;
    lock(true);
    transition('finalizing', 'closingOutput');
    renderProgress(job);
    const mimeType = job.outputFormat === 'pgm' ? 'image/x-portable-graymap'
      : job.outputFormat === 'ppm' ? 'image/x-portable-pixmap'
      : job.outputFormat === 'jls' ? 'image/jls' : 'application/octet-stream';
    const artifact = await sink.close(mimeType);
    requireActive(job);
    job.elapsed = performance.now() - job.started;
    job.result = result;
    if (artifact instanceof Blob) {
      job.artifact = artifact;
      artifactUrl = URL.createObjectURL(artifact);
      const download = get('download');
      if (download) {
        download.href = artifactUrl;
        download.download = job.outputName;
        download.hidden = false;
      }
    }
    finishWorkbenchReport(job, 'passed');
    setHidden('export-report', false);
    renderPhysicalBudget(job);
    renderResult(job);
    transition('complete', decodeOnly ? 'decodeOnly' : 'complete');
    renderProgress(job);
  } catch (error) {
    const cancelled = job.abort.signal.aborted || error.code === 'Cancelled' || error.name === 'AbortError';
    job.abort.abort();
    if (active === job) {
      job.errorLocation = error.location ?? null;
      job.errorMessage = error.message ?? null;
      finishWorkbenchReport(job, cancelled ? 'cancelled' : 'failed', error);
      setHidden('export-report', false);
      renderPhysicalBudget(job);
      active = undefined;
      lock(false);
      if (cancelled) transition('cancelled');
      else {
        const isWasmFailure = job.backend === 'wasm-gc'
          && (error.name === 'CompileError' || /\bwasm\b|webassembly/i.test(error.message ?? ''));
        const widthLimited = job.decodeOnly && error.code === 'UnsupportedFeature' && /Uint16 output range/i.test(error.message);
        const hint = isWasmFailure ? translate('wasmFallbackHint') : widthLimited ? translate('wideRetry') : null;
        const detail = hint ? `${error.message} · ${hint}` : error.message;
        transition('failed', 'failure', typeof error.code === 'string' ? error.code : error.name ?? 'Error', detail);
      }
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

get('file').addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  if (file) setSource(file);
});
get('example').addEventListener('click', () => { get('file').value = ''; setSource(samplePgm()); });
const builtInSamples = {
  'sample-rgb8': { name: 'lily-8.ppm', labelKey: 'sampleRgb8Desc' },
  'sample-multi16': { name: 'lily-16.ppm', labelKey: 'sampleMulti16Desc', displayMaxval: 4095 },
  'sample-sampling': { name: 'lily-sampled.jls', labelKey: 'sampledLilyDesc' },
};
for (const [id, { name, ...meta }] of Object.entries(builtInSamples)) {
  get(id)?.addEventListener('click', async () => {
    const selection = ++sourceSelection;
    try {
      const response = await fetch(new URL(`./samples/${name}`, import.meta.url));
      if (!response.ok) throw new Error(`Sample request failed (${response.status})`);
      const bytes = await response.arrayBuffer();
      if (selection !== sourceSelection || active) return;
      const file = new File([bytes], name);
      file.moonjlsMeta = Object.freeze({ ...meta, channelRoles: ['C0', 'C1', 'C2'], composite: false });
      get('file').value = '';
      setSource(file);
    } catch {
      if (selection === sourceSelection && !active) transition('failed', 'sampleUnavailable');
    }
  });
}

let dragDepth = 0;
const setDropActive = (on) => setAttr('workspace-view', 'data-drop-active', on ? 'true' : 'false');
const hasDragFiles = (event) => Boolean(event.dataTransfer?.types?.includes?.('Files'));
document.body?.addEventListener?.('dragenter', (event) => {
  if (!hasDragFiles(event)) return;
  event.preventDefault();
  dragDepth++;
  if (!active) setDropActive(true);
});
document.body?.addEventListener?.('dragover', (event) => {
  if (!hasDragFiles(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = active ? 'none' : 'copy';
});
document.body?.addEventListener?.('dragleave', (event) => {
  if (!hasDragFiles(event) && dragDepth === 0) return;
  dragDepth = event.relatedTarget === null ? 0 : Math.max(0, dragDepth - 1);
  if (dragDepth === 0) setDropActive(false);
});
document.body?.addEventListener?.('drop', (event) => {
  dragDepth = 0;
  setDropActive(false);
  if (!hasDragFiles(event)) return;
  event.preventDefault();
  if (active) return;
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  const fileInput = get('file');
  if (fileInput) fileInput.value = '';
  setSource(file);
});
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
  finishWorkbenchReport(job, 'cancelled', new CodecError('Cancelled', 'Operation cancelled'));
  setHidden('export-report', false);
  renderPhysicalBudget(job);
  active = undefined;
  lock(false);
  transition('cancelled');
  renderProgress(job);
});

get('export-report')?.addEventListener?.('click', async () => {
  const job = presented;
  if (!job?.status) return;
  setText('report-error', '');
  setHidden('report-error', true);
  try {
    const report = await workbenchReport(job);
    if (presented !== job) return;
    const url = URL.createObjectURL(new Blob([serializeVerificationReport(report)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `moonjls-${job.runId}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  } catch (error) {
    if (presented !== job) return;
    setText('report-error', translate('reportExportFailed', error.message));
    setHidden('report-error', false);
  }
});

get('point-transform')?.addEventListener('change', () => {
  if (!isJls(source)) setNearOptions(nearLimit(pnmCodedMaxval(sourcePgm?.header, configuredPt())));
  renderIdentity();
});
for (const id of ['near', 'interleave', 'decode-sample-format', 'backend', 'sink']) {
  get(id)?.addEventListener?.('change', renderIdentity);
}
for (const tab of document.querySelectorAll?.('.view-tab') ?? []) {
  tab.addEventListener('click', () => setViewMode(tab.dataset.view));
  tab.addEventListener('focus', () => { focusedViewTab = tab; });
  tab.addEventListener('blur', (event) => {
    if (focusedViewTab !== tab) return;
    const next = event.relatedTarget;
    if (next) {
      if (!next.classList?.contains?.('view-tab')) focusedViewTab = null;
    } else if (isTabVisible(tab)) {
      focusedViewTab = null;
    }
  });
  tab.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const visible = visibleViewTabs();
    if (visible.length === 0) return;
    const currentIndex = visible.indexOf(tab);
    let nextIndex = -1;
    if (event.key === 'ArrowRight') nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % visible.length;
    else if (event.key === 'ArrowLeft') nextIndex = currentIndex < 0 ? 0 : (currentIndex - 1 + visible.length) % visible.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = visible.length - 1;
    else return;
    event.preventDefault();
    setViewMode(visible[nextIndex].dataset.view, { focus: true });
  });
}
const origCanvasEl = get('original');
origCanvasEl?.addEventListener?.('focus', () => { focusedOriginalCanvas = true; });
origCanvasEl?.addEventListener?.('blur', (event) => {
  if (!focusedOriginalCanvas) return;
  if (event.relatedTarget) {
    focusedOriginalCanvas = false;
    return;
  }
  const origCard = origCanvasEl.closest?.('.preview-card') ?? origCanvasEl;
  const visible = typeof globalThis.getComputedStyle === 'function'
    ? globalThis.getComputedStyle(origCard).display !== 'none'
    : true;
  if (visible) focusedOriginalCanvas = false;
});

function syncViewportMode() {
  if (typeof globalThis.innerWidth === 'number' && globalThis.innerWidth === 0) return;
  const activeElement = document.activeElement;
  const origCanvas = get('original');
  const recCanvas = get('reconstruction');
  const lostOriginalCanvasFocus = Boolean(
    focusedOriginalCanvas
    && (!activeElement || activeElement === document.body || activeElement === document.documentElement || activeElement === origCanvas),
  );
  const shouldMoveOriginalCanvasFocus = Boolean(
    isNarrow()
    && viewMode === 'compare'
    && recCanvas
    && !effectiveDecodeOnly()
    && ((origCanvas && activeElement === origCanvas) || lostOriginalCanvasFocus),
  );
  const activeIsViewTab = Boolean(activeElement?.classList?.contains?.('view-tab'));
  const lostHiddenTabFocus = Boolean(
    focusedViewTab
    && !isTabVisible(focusedViewTab)
    && (!activeElement || activeElement === document.body || activeElement === document.documentElement || activeElement === focusedViewTab),
  );
  const shouldFollowFocus = (activeIsViewTab && !isTabVisible(activeElement)) || lostHiddenTabFocus;
  const drawer = get('settings-drawer');
  if (drawer && !isNarrow()) drawer.open = true;
  setViewMode(viewMode, { focus: shouldFollowFocus });
  if (shouldMoveOriginalCanvasFocus && recCanvas.tabIndex >= 0) {
    focusedOriginalCanvas = false;
    recCanvas.focus?.();
  }
  if (!shouldFollowFocus && activeElement && !activeIsViewTab) focusedViewTab = null;
  if (!shouldMoveOriginalCanvasFocus && activeElement && activeElement !== origCanvas) focusedOriginalCanvas = false;
}
narrowQuery?.addEventListener?.('change', syncViewportMode);
globalThis.addEventListener?.('resize', () => onPaint(() => preview.syncOverlays?.()));

function applyLocale() {
  document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  if ('title' in document) document.title = translate('pageTitle');
  for (const element of document.querySelectorAll('[data-label]')) element.textContent = translate(element.dataset.label);
  for (const element of document.querySelectorAll('[data-aria-label]')) {
    element.setAttribute('aria-label', translate(element.dataset.ariaLabel));
  }
  renderIdentity();
  renderState();
  renderProgress(presented);
  renderPhysicalBudget(presented);
  renderResult(presented);
  renderPixel();
  renderMulticomponent(presented);
  renderInspector(presented);
  get('progress').setAttribute('aria-label', translate('reconstruction'));
}

get('language').addEventListener('change', (event) => {
  locale = event.target.value;
  applyLocale();
});

const fileSinkOption = get('sink').querySelector?.('[value="file"]');
if (!globalThis.showSaveFilePicker && fileSinkOption) fileSinkOption.disabled = true;

setNearOptions(255);
setViewMode(viewMode);
applyLocale();
for (const option of document.querySelectorAll?.('.scientific-nav a') ?? []) {
  option.addEventListener('click', () => {
    const destination = get(option.hash.slice(1));
    if (destination?.tagName === 'DETAILS') destination.open = true;
  });
}
void mountCompatibility(() => translate('compatibilityUnavailable'));
void mountBuildIdentity();
