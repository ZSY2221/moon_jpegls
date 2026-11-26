import { componentDimensions } from '../sdk/index.mjs';
import { reconstructionErrorBound } from '../sdk/verification-report.mjs';
import { reconstructionMaximum, sampleMaximum } from './pgm.mjs';

const ids = ['original', 'reconstruction', 'difference'];

const ERROR_STOPS = {
  0: [[12, 19, 28]],
  1: [[12, 19, 28], [208, 162, 96]],
  2: [[12, 19, 28], [45, 88, 104], [208, 162, 96]],
  3: [[12, 19, 28], [30, 60, 76], [74, 124, 134], [212, 165, 98]],
};

export const ERROR_OVERFLOW_RGB = [232, 106, 122];

function rgbToHex([r, g, b]) {
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase()}`;
}

function normalizeNear(near) {
  return Math.max(0, Math.min(8388607, Math.trunc(Number(near) || 0)));
}

function colorWithinBound(value, near) {
  if (near <= 3) return ERROR_STOPS[near][value];
  const anchors = ERROR_STOPS[3];
  const position = value * (anchors.length - 1) / near;
  const left = Math.floor(position);
  const right = Math.min(left + 1, anchors.length - 1);
  return anchors[left].map((channel, index) =>
    Math.round(channel + (anchors[right][index] - channel) * (position - left)));
}

function paletteStop(value, near) {
  const rgb = [...colorWithinBound(value, near)];
  return { value, rgb, hex: rgbToHex(rgb) };
}

export function errorPalette(near) {
  const safeNear = normalizeNear(near);
  const steps = Math.min(255, safeNear);
  return Array.from({ length: steps + 1 }, (_, step) =>
    paletteStop(steps === safeNear ? step : Math.round(step * safeNear / steps), safeNear));
}

export function errorLegendStops(near) {
  const safeNear = normalizeNear(near);
  if (safeNear <= 3) return errorPalette(safeNear);
  return Array.from({ length: 5 }, (_, index) => paletteStop(Math.round(safeNear * index / 4), safeNear));
}

export function errorColor(difference, near) {
  const safeNear = normalizeNear(near);
  if (!Number.isInteger(difference) || difference < 0 || difference > safeNear) return ERROR_OVERFLOW_RGB;
  return colorWithinBound(difference, safeNear);
}

function buildErrorLut(near) {
  const safeNear = normalizeNear(near);
  const stops = errorPalette(safeNear);
  const entries = [...stops.map((stop) => stop.rgb), ERROR_OVERFLOW_RGB];
  const lut = new Uint8Array(entries.length * 3);
  for (let s = 0; s < entries.length; s++) {
    lut[s * 3] = entries[s][0];
    lut[s * 3 + 1] = entries[s][1];
    lut[s * 3 + 2] = entries[s][2];
  }
  return { near: safeNear, lut, scale: safeNear <= 255 ? 1 : 255 / safeNear, overflowOffset: (entries.length - 1) * 3 };
}

function color(data, index, r, g, b) {
  data[index] = r;
  data[index + 1] = g;
  data[index + 2] = b;
  data[index + 3] = 255;
}

function contentRect(canvas, width, height) {
  // CSS gives the canvas a borderless box and uses centered object-fit: contain.
  const bounds = canvas.getBoundingClientRect();
  const boxWidth = bounds.width ?? canvas.clientWidth;
  const boxHeight = bounds.height ?? canvas.clientHeight;
  const scale = Math.min(boxWidth / width, boxHeight / height);
  if (!scale || !Number.isFinite(scale)) return null;
  const drawWidth = width * scale;
  const drawHeight = height * scale;
  return {
    left: (boxWidth - drawWidth) / 2,
    top: (boxHeight - drawHeight) / 2,
    width: drawWidth,
    height: drawHeight,
    scale,
    boundsLeft: bounds.left,
    boundsTop: bounds.top,
  };
}

function imagePoint(canvas, event, width, height) {
  const rect = contentRect(canvas, width, height);
  if (!rect) return;
  const x = (event.clientX - rect.boundsLeft - rect.left) / rect.scale;
  const y = (event.clientY - rect.boundsTop - rect.top) / rect.scale;
  if (x >= 0 && x < width && y >= 0 && y < height) return [Math.floor(x), Math.floor(y)];
}

function hideOverlay(canvas) {
  const layer = canvas?.parentElement?.querySelector?.('.reticle-layer');
  if (layer) layer.hidden = true;
}

function previewMaximum(frame, wide, sourceMaxval) {
  if (!wide) return sampleMaximum(frame);
  const decodedMaxval = reconstructionMaximum(frame);
  if (sourceMaxval === undefined) return decodedMaxval;
  const step = 2 ** (frame.pointTransform ?? 0);
  const largestReconstruction = (Math.floor(sourceMaxval / step) + (frame.near ?? 0)) * step;
  return Math.max(sourceMaxval, Math.min(decodedMaxval, largestReconstruction));
}

export function createPreview(canvases, reportPixel, magnifiers = []) {
  let state;
  let overlaysVisible = false;

  const getLut = (near) => {
    const safeNear = normalizeNear(near);
    let cached = state.errorLuts.get(safeNear);
    if (!cached) {
      cached = buildErrorLut(safeNear);
      state.errorLuts.set(safeNear, cached);
    }
    return cached;
  };

  const arrivedLimit = () => {
    if (!state) return 0;
    if (state.channel === 'composite') {
      let m = 0;
      for (let c = 0; c < state.componentCount; c++) {
        if (state.nextY[c] > m) m = state.nextY[c];
      }
      return m;
    }
    return state.nextY[state.channel] ?? 0;
  };

  const renderCanvasRow = (py) => {
    const { width, contexts, scanlines, original, reconstruction, componentCount, componentMaxvals, componentNears, nextY, channel } = state;
    const recData = scanlines[1].data;
    const origData = scanlines[0].data;
    const errData = scanlines[2].data;
    const base = py * width;
    let hasOrigRow = false;

    if (channel === 'composite' && componentCount >= 3) {
      const has0 = py < nextY[0];
      const has1 = py < nextY[1];
      const has2 = py < nextY[2];
      const m0 = componentMaxvals[0];
      const m1 = componentMaxvals[1];
      const m2 = componentMaxvals[2];
      hasOrigRow = original !== null && (has0 || has1 || has2);
      const maxNear = Math.max(componentNears[0], componentNears[1], componentNears[2]);
      const { lut, scale, overflowOffset } = getLut(maxNear);
      for (let x = 0; x < width; x++) {
        const pos = base + x;
        const i = x * 4;
        const r = has0 ? Math.round(reconstruction[0][pos] * 255 / m0) : 0;
        const g = has1 ? Math.round(reconstruction[1][pos] * 255 / m1) : 0;
        const b = has2 ? Math.round(reconstruction[2][pos] * 255 / m2) : 0;
        color(recData, i, r, g, b);
        if (hasOrigRow) {
          const or0 = has0 ? Math.round(original[0][pos] * 255 / m0) : 0;
          const og0 = has1 ? Math.round(original[1][pos] * 255 / m1) : 0;
          const ob0 = has2 ? Math.round(original[2][pos] * 255 / m2) : 0;
          color(origData, i, or0, og0, ob0);
          let peakDiff = 0;
          let exceeded = false;
          for (let c = 0; c < 3; c++) {
            if (py < nextY[c]) {
              const d = Math.abs(original[c][pos] - reconstruction[c][pos]);
              if (d > componentNears[c]) exceeded = true;
              if (d > peakDiff) peakDiff = d;
            }
          }
          const offset = exceeded || peakDiff > maxNear ? overflowOffset : Math.round(peakDiff * scale) * 3;
          color(errData, i, lut[offset], lut[offset + 1], lut[offset + 2]);
        }
      }
    } else {
      const c = typeof channel === 'number' ? channel : 0;
      if (py >= nextY[c]) return undefined;
      const brightest = componentMaxvals[c];
      const nearLimit = componentNears[c];
      const { lut, scale, overflowOffset } = getLut(nearLimit);
      const recPlane = reconstruction[c];
      const origPlane = original?.[c] ?? null;
      hasOrigRow = origPlane !== null;
      for (let x = 0; x < width; x++) {
        const pos = base + x;
        const after = recPlane[pos];
        const i = x * 4;
        const gray = Math.round(after * 255 / brightest);
        color(recData, i, gray, gray, gray);
        if (origPlane !== null) {
          const before = origPlane[pos];
          const originalGray = Math.round(before * 255 / brightest);
          color(origData, i, originalGray, originalGray, originalGray);
          const difference = before >= after ? before - after : after - before;
          const offset = difference <= nearLimit ? Math.round(difference * scale) * 3 : overflowOffset;
          color(errData, i, lut[offset], lut[offset + 1], lut[offset + 2]);
        }
      }
    }

    let firstCanvasAt;
    for (let i = hasOrigRow ? 0 : 1; i < (hasOrigRow ? contexts.length : 2); i++) {
      contexts[i].putImageData(scanlines[i], 0, py);
      if (i === 1 && !state.drewFirst) {
        state.drewFirst = true;
        firstCanvasAt = performance.now();
      }
    }
    return firstCanvasAt;
  };

  const syncOverlays = () => {
    let anyVisible = false;
    for (const [index, canvas] of canvases.entries()) {
      const layer = canvas?.parentElement?.querySelector?.('.reticle-layer');
      if (!layer) continue;
      if (!state?.selected || !(index === 1 || state.original)) {
        layer.hidden = true;
        continue;
      }
      const rect = contentRect(canvas, state.width, state.height);
      if (!rect) {
        layer.hidden = true;
        continue;
      }
      const [sx, sy] = state.selected;
      const cx = rect.left + (sx + 0.5) * rect.scale;
      const cy = rect.top + (sy + 0.5) * rect.scale;
      const box = Math.max(8, Math.min(24, Math.round(rect.scale)));
      const horizontal = layer.querySelector?.('.reticle-h');
      const vertical = layer.querySelector?.('.reticle-v');
      const marker = layer.querySelector?.('.reticle-box');
      if (horizontal) {
        horizontal.style.left = `${rect.left}px`;
        horizontal.style.width = `${rect.width}px`;
        horizontal.style.top = `${cy}px`;
      }
      if (vertical) {
        vertical.style.top = `${rect.top}px`;
        vertical.style.height = `${rect.height}px`;
        vertical.style.left = `${cx}px`;
      }
      if (marker) {
        marker.style.left = `${cx}px`;
        marker.style.top = `${cy}px`;
        marker.style.width = `${box}px`;
        marker.style.height = `${box}px`;
      }
      layer.hidden = false;
      anyVisible = true;
    }
    overlaysVisible = anyVisible;
  };

  const clear = () => {
    state = undefined;
    for (const canvas of canvases) {
      canvas.width = 300;
      canvas.height = 200;
      canvas.tabIndex = -1;
      if (overlaysVisible) hideOverlay(canvas);
    }
    overlaysVisible = false;
  };

  function configure(frame, hasReference, options = {}) {
    const scale = Math.min(1, 480 / frame.width, 320 / frame.height);
    const width = Math.max(1, Math.floor(frame.width * scale));
    const height = Math.max(1, Math.floor(frame.height * scale));
    const componentCount = options.componentCount ?? frame.components?.length ?? 1;
    const { widths, heights } = componentDimensions(frame);
    const sourceHeights = Array.from({ length: componentCount }, (_, c) => heights[c] ?? frame.height);
    const xMaps = Array.from({ length: componentCount }, (_, c) =>
      Uint16Array.from({ length: width }, (_, x) => Math.floor(x * (widths[c] ?? frame.width) / width)));
    const sampled = widths.some((w, c) => w !== frame.width || heights[c] !== frame.height);
    const composite = componentCount >= 3 && !sampled && (options.allowComposite ?? true);
    const requestedChannel = options.initialChannel ?? (componentCount === 3 ? 'composite' : 0);
    const channel = requestedChannel === 'composite' && !composite ? 0 : requestedChannel;
    for (const [index, canvas] of canvases.entries()) {
      canvas.width = width;
      canvas.height = height;
      canvas.tabIndex = hasReference || index === 1 ? 0 : -1;
      if (overlaysVisible) hideOverlay(canvas);
    }
    overlaysVisible = false;
    const contexts = canvases.map((canvas) => canvas.getContext('2d'));
    const displayMaxval = options.displayMaxval;
    const wide = options.sampleFormat === 'u32';
    const Reconstruction = wide ? Uint32Array : Uint16Array;
    const defaultMaxval = displayMaxval ?? previewMaximum(frame, wide, options.sourceMaxval);
    const componentLabels = options.componentLabels
      ?? Array.from({ length: componentCount }, (_, c) => `C${c}`);
    const errorLuts = new Map();
    const initialLut = buildErrorLut(reconstructionErrorBound(frame.near, frame.pointTransform));
    errorLuts.set(initialLut.near, initialLut);
    state = {
      width,
      height,
      xMaps,
      sourceHeights,
      sampled,
      composite,
      displayMaxval,
      wide,
      sourceMaxval: options.sourceMaxval,
      bits: frame.bits,
      contexts,
      componentCount,
      channel,
      componentLabels: [...componentLabels],
      componentNears: Array.from({ length: componentCount }, () => initialLut.near),
      componentCodedNears: Array(componentCount).fill(frame.near ?? 0),
      componentTransforms: Array(componentCount).fill(frame.pointTransform ?? 0),
      componentMappings: Array(componentCount).fill(0),
      componentMaxvals: Array.from({ length: componentCount }, () => defaultMaxval),
      nextY: new Int32Array(componentCount),
      errorLuts,
      drewFirst: false,
      scanlines: contexts.map((context) => context.createImageData(width, 1)),
      original: hasReference ? Array.from({ length: componentCount }, () => new Uint16Array(width * height)) : null,
      reconstruction: Array.from({ length: componentCount }, () => new Reconstruction(width * height)),
    };
  }

  function drawRow(index, reconstructed, original, meta = undefined) {
    const { width, height, xMaps, sourceHeights, nextY, componentCount } = state;
    const c = meta?.componentIndex ?? 0;
    if (c < 0 || c >= componentCount) return;
    if (meta?.near !== undefined) {
      state.componentTransforms[c] = meta.pointTransform ?? 0;
      state.componentMappings[c] = meta.mappingSelector ?? 0;
      state.componentCodedNears[c] = meta.near;
      state.componentNears[c] = reconstructionErrorBound(meta.near, meta.pointTransform);
    }
    if (state.displayMaxval === undefined && meta?.preset?.maxval !== undefined) {
      state.componentMaxvals[c] = meta.mappingSelector ? 255 : previewMaximum({
        bits: state.bits, maxval: meta.preset.maxval, pointTransform: meta.pointTransform, near: meta.near,
      }, state.wide, state.sourceMaxval);
    }
    const xMap = xMaps[c];
    const recPlane = state.reconstruction[c];
    const origPlane = state.original?.[c] ?? null;
    let firstCanvasAt;
    for (let py = nextY[c]; py < height && index === Math.floor(py * sourceHeights[c] / height); py++) {
      const base = py * width;
      for (let x = 0; x < width; x++) {
        recPlane[base + x] = reconstructed[xMap[x]];
        if (original !== null && origPlane !== null) origPlane[base + x] = original[xMap[x]];
      }
      nextY[c] = py + 1;
      if (state.channel === c || state.channel === 'composite') {
        const painted = renderCanvasRow(py);
        firstCanvasAt ??= painted;
      }
    }
    return firstCanvasAt;
  }

  function setChannel(channel) {
    if (!state) return;
    const nextChannel = channel === 'composite' && state.composite
      ? 'composite'
      : Math.max(0, Math.min(state.componentCount - 1, Number(channel) || 0));
    state.channel = nextChannel;
    for (const ctx of state.contexts) {
      ctx?.clearRect?.(0, 0, state.width, state.height);
    }
    const maxPy = arrivedLimit();
    for (let py = 0; py < maxPy; py++) {
      renderCanvasRow(py);
    }
    if (state.selected) {
      const [sx, sy] = state.selected;
      if (sy < maxPy) inspect(sx, sy);
      else {
        state.selected = undefined;
        reportPixel(undefined);
        syncOverlays();
      }
    }
  }

  function drawMagnifiers(x, y) {
    const { width, original, reconstruction, componentCount, componentNears, componentMaxvals, nextY, channel } = state;
    const size = 7;
    const center = Math.floor(size / 2);
    const limitY = arrivedLimit();
    for (const [plane, canvas] of magnifiers.entries()) {
      if (!canvas) continue;
      const available = plane === 1 || original !== null;
      if (canvas.parentElement) canvas.parentElement.hidden = !available;
      if (!available) continue;
      const context = canvas.getContext('2d');
      const image = context.createImageData(size, size);
      for (let dy = 0; dy < size; dy++) {
        const row = y + dy - center;
        if (row < 0 || row >= limitY) continue;
        for (let dx = 0; dx < size; dx++) {
          const column = x + dx - center;
          if (column < 0 || column >= width) continue;
          const source = row * width + column;
          const pixel = (dy * size + dx) * 4;
          if (channel === 'composite' && componentCount >= 3) {
            if (plane === 2) {
              let peakDiff = 0;
              let maxNear = 0;
              let exceeded = false;
              for (let c = 0; c < 3; c++) {
                if (row < nextY[c]) {
                  const d = Math.abs(original[c][source] - reconstruction[c][source]);
                  if (d > componentNears[c]) exceeded = true;
                  if (d > peakDiff) peakDiff = d;
                  if (componentNears[c] > maxNear) maxNear = componentNears[c];
                }
              }
              color(image.data, pixel, ...errorColor(exceeded ? maxNear + 1 : peakDiff, maxNear));
            } else {
              const r = row < nextY[0] ? Math.round((plane === 0 ? original[0][source] : reconstruction[0][source]) * 255 / componentMaxvals[0]) : 0;
              const g = row < nextY[1] ? Math.round((plane === 0 ? original[1][source] : reconstruction[1][source]) * 255 / componentMaxvals[1]) : 0;
              const b = row < nextY[2] ? Math.round((plane === 0 ? original[2][source] : reconstruction[2][source]) * 255 / componentMaxvals[2]) : 0;
              color(image.data, pixel, r, g, b);
            }
          } else {
            const c = typeof channel === 'number' ? channel : 0;
            if (row >= nextY[c]) continue;
            if (plane === 2) {
              color(image.data, pixel, ...errorColor(Math.abs(original[c][source] - reconstruction[c][source]), componentNears[c]));
            } else {
              const sample = plane === 0 ? original[c][source] : reconstruction[c][source];
              const gray = Math.round(sample * 255 / componentMaxvals[c]);
              color(image.data, pixel, gray, gray, gray);
            }
          }
        }
      }
      context.putImageData(image, 0, 0);
    }
  }

  function sampleTransformMetadata(index) {
    const pointTransform = state.componentTransforms[index];
    const mappingSelector = state.componentMappings[index];
    if (mappingSelector) return { mappingSelector, codedNear: state.componentCodedNears[index] };
    return pointTransform ? { pointTransform, codedNear: state.componentCodedNears[index] } : {};
  }

  function inspect(x, y) {
    if (y >= arrivedLimit()) return;
    state.selected = [x, y];
    const position = y * state.width + x;
    syncOverlays();
    drawMagnifiers(x, y);
    if (state.componentCount === 1 || state.sampled) {
      const c = state.sampled ? state.channel : 0;
      const reconstructed = state.reconstruction[c][position];
      const original = state.original?.[c][position];
      reportPixel({
        x: state.xMaps[c][x],
        y: Math.floor(y * state.sourceHeights[c] / state.height),
        ...(state.sampled || state.componentTransforms[c] ? { near: state.componentNears[c] } : {}),
        ...sampleTransformMetadata(c),
        original,
        reconstructed,
        error: original === undefined ? undefined : Math.abs(original - reconstructed),
      });
      return;
    }
    const components = Array.from({ length: state.componentCount }, (_, idx) => {
      const arrived = y < state.nextY[idx];
      const rec = arrived ? state.reconstruction[idx][position] : undefined;
      const orig = arrived && state.original ? state.original[idx][position] : undefined;
      return {
        index: idx,
        label: state.componentLabels[idx],
        original: orig,
        reconstructed: rec,
        error: orig === undefined || rec === undefined ? undefined : Math.abs(orig - rec),
        near: state.componentNears[idx],
        ...sampleTransformMetadata(idx),
      };
    });
    const activeComp = typeof state.channel === 'number' ? components[state.channel] : components[0];
    reportPixel({
      x: state.xMaps[0][x],
      y: Math.floor(y * state.sourceHeights[0] / state.height),
      channel: state.channel,
      original: activeComp.original,
      reconstructed: activeComp.reconstructed,
      error: activeComp.error,
      near: activeComp.near,
      ...sampleTransformMetadata(activeComp.index),
      components,
    });
  }

  const bufferBytes = () => {
    if (!state) return 0;
    const reconstruction = state.reconstruction[0].byteLength;
    const original = state.original?.[0].byteLength ?? 0;
    return state.componentCount * (reconstruction + original);
  };

  const directions = new Map([
    ['ArrowLeft', [-1, 0]], ['ArrowRight', [1, 0]],
    ['ArrowUp', [0, -1]], ['ArrowDown', [0, 1]],
    ['Enter', [0, 0]],
  ]);
  for (const [index, canvas] of canvases.entries()) {
    const inspectable = () => state && arrivedLimit() > 0 && (index === 1 || state.original);
    canvas.addEventListener('click', (event) => {
      if (!inspectable()) return;
      const point = imagePoint(canvas, event, state.width, state.height);
      if (point) inspect(...point);
    });
    canvas.addEventListener('keydown', (event) => {
      const direction = directions.get(event.key);
      if (!direction || !inspectable() || event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      const [x, y] = state.selected ?? [0, 0];
      const [dx, dy] = direction;
      inspect(
        Math.max(0, Math.min(state.width - 1, x + dx)),
        Math.max(0, Math.min(arrivedLimit() - 1, y + dy)),
      );
    });
  }
  clear();
  return { clear, configure, drawRow, setChannel, bufferBytes, syncOverlays };
}

export const previewIds = ids;
