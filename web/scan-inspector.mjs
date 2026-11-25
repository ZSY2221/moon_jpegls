const MARKER_NAMES = new Map([
  [0xD8, 'SOI'],
  [0xF7, 'SOF55'],
  [0xF8, 'LSE'],
  [0xDA, 'SOS'],
  [0xDD, 'DRI'],
  [0xD9, 'EOI'],
  [0xFE, 'COM'],
]);

function markerLabel(code) {
  if (MARKER_NAMES.has(code)) return MARKER_NAMES.get(code);
  if (code >= 0xE0 && code <= 0xEF) return `APP${code - 0xE0}`;
  return `0x${code.toString(16).toUpperCase().padStart(2, '0')}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

export function renderScanInspector({
  structure,
  selectedScanIndex,
  channelNames,
  errorLocation,
  errorMessage,
  translate,
  onSelectScan,
}) {
  const summaryEl = document.getElementById('scan-inspector-summary');
  const sofBody = document.getElementById('sof-components-body');
  const scansBody = document.getElementById('scan-table-body');
  const markersEl = document.getElementById('marker-timeline');
  const errorEl = document.getElementById('scan-error-location');
  if (!summaryEl || !sofBody || !scansBody || !markersEl || !errorEl) return;

  if (errorLocation || errorMessage) {
    errorEl.hidden = false;
    const locParts = [];
    if (errorLocation) {
      if (errorLocation.scanIndex >= 0) locParts.push(`${translate('scanCol')} #${errorLocation.scanIndex}`);
      if (errorLocation.componentId >= 0) locParts.push(`ID ${errorLocation.componentId}`);
      if (errorLocation.marker > 0) locParts.push(`${markerLabel(errorLocation.marker)}`);
      if (errorLocation.offset >= 0) locParts.push(`@${errorLocation.offset}`);
    }
    errorEl.textContent = locParts.length
      ? `${translate('scanErrorAt')} ${locParts.join(' · ')}${errorMessage ? ` — ${errorMessage}` : ''}`
      : (errorMessage ?? '');
  } else {
    errorEl.hidden = true;
    errorEl.textContent = '';
  }

  if (!structure) {
    summaryEl.textContent = translate('scanInspectorEmpty');
    sofBody.replaceChildren();
    scansBody.replaceChildren();
    markersEl.replaceChildren();
    return;
  }

  const { frame, scans, markers, soiOffset, sofOffset, sofLength, eoiOffset } = structure;
  const eoiText = eoiOffset >= 0 ? `EOI @${eoiOffset}` : translate('scanPending');
  summaryEl.textContent = `${frame.width}×${frame.height} · P=${frame.bits} · SOI @${soiOffset} · SOF55 @${sofOffset} (${sofLength} B) · ${eoiText}`;

  sofBody.replaceChildren(...frame.components.map((comp, idx) => {
    const tr = el('tr');
    const role = channelNames?.[idx] ?? `C${idx}`;
    tr.append(
      el('td', 'mono', idx),
      el('td', 'mono', comp.id),
      el('td', '', role),
      el('td', 'mono', `${comp.hSampling}×${comp.vSampling}`),
    );
    return tr;
  }));

  scansBody.replaceChildren(...scans.map((scan) => {
    const tr = el('tr', scan.scanIndex === selectedScanIndex ? 'scan-row is-selected' : 'scan-row');
    tr.tabIndex = 0;
    tr.dataset.scanIndex = String(scan.scanIndex);
    tr.dataset.componentIndex = String(scan.componentIndex);
    const select = () => onSelectScan?.(scan);
    tr.addEventListener('click', select);
    tr.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        select();
      }
    });
    const role = channelNames?.[scan.componentIndex] ?? `C${scan.componentIndex}`;
    const p = scan.preset;
    const presetText = p ? `${p.maxval} · ${p.t1}/${p.t2}/${p.t3} r=${p.reset}` : '—';
    const rangeText = scan.endOffset >= 0
      ? `@${scan.headerOffset}..${scan.endOffset} (${scan.endOffset - scan.headerOffset} B)`
      : `@${scan.headerOffset} (entropy @${scan.entropyOffset})`;
    const stText = scan.completed ? translate('scanStateDone') : `${scan.rows ?? 0}/${frame.height}`;
    tr.append(
      el('td', 'mono', scan.scanIndex),
      el('td', '', `${role} (ID ${scan.componentId})`),
      el('td', 'mono', scan.near),
      el('td', 'mono', presetText),
      el('td', 'mono', rangeText),
      el('td', scan.completed ? 'scan-status is-done' : 'scan-status is-active', stText),
    );
    return tr;
  }));

  markersEl.replaceChildren(...markers.map((m) => {
    const tag = markerLabel(m.code);
    const detail = m.code === 0xF8 ? ` ID=${m.detail}` : m.code === 0xDA ? ` Cs=${m.detail}` : m.code === 0xF7 ? ` Nf=${m.detail}` : '';
    const chip = el('span', 'marker-chip mono', `${tag}${detail} @${m.offset} (${m.length} B)`);
    return chip;
  }));
}
