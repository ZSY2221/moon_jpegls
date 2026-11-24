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

export function errorPalette(near) {
  const safeNear = Math.max(0, Math.min(3, Math.trunc(Number(near) || 0)));
  const stops = ERROR_STOPS[safeNear] ?? ERROR_STOPS[3];
  return stops.map((rgb, value) => ({ value, rgb: [...rgb], hex: rgbToHex(rgb) }));
}

export function errorColor(difference, near) {
  const safeNear = Math.max(0, Math.min(3, Math.trunc(Number(near) || 0)));
  const stops = ERROR_STOPS[safeNear] ?? ERROR_STOPS[3];
  if (difference < 0 || difference > safeNear) return ERROR_OVERFLOW_RGB;
  return stops[difference] ?? ERROR_OVERFLOW_RGB;
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

export function createPreview(canvases, reportPixel) {
  let state;
  let overlaysVisible = false;

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

  function configure(frame, hasReference) {
    const scale = Math.min(1, 480 / frame.width, 320 / frame.height);
    const width = Math.max(1, Math.floor(frame.width * scale));
    const height = Math.max(1, Math.floor(frame.height * scale));
    const xMap = Uint16Array.from({ length: width }, (_, x) => Math.floor(x * frame.width / width));
    for (const [index, canvas] of canvases.entries()) {
      canvas.width = width;
      canvas.height = height;
      canvas.tabIndex = hasReference || index === 1 ? 0 : -1;
      if (overlaysVisible) hideOverlay(canvas);
    }
    overlaysVisible = false;
    const contexts = canvases.map((canvas) => canvas.getContext('2d'));
    const stops = errorPalette(frame.near);
    const lutEntries = [...stops.map((stop) => stop.rgb), ERROR_OVERFLOW_RGB];
    const errorLut = new Uint8Array(lutEntries.length * 3);
    for (let s = 0; s < lutEntries.length; s++) {
      errorLut[s * 3] = lutEntries[s][0];
      errorLut[s * 3 + 1] = lutEntries[s][1];
      errorLut[s * 3 + 2] = lutEntries[s][2];
    }
    state = {
      frame, width, height, xMap, contexts, nextY: 0, errorLut,
      overflowOffset: (lutEntries.length - 1) * 3,
      scanlines: contexts.map((context) => context.createImageData(width, 1)),
      original: hasReference ? new Uint16Array(width * height) : null,
      reconstruction: new Uint16Array(width * height),
    };
  }

  function drawRow(index, reconstructed, original) {
    const { frame, width, height, xMap, contexts, scanlines, nextY, errorLut, overflowOffset } = state;
    if (nextY === height || index !== Math.floor(nextY * frame.height / height)) return;
    const base = nextY * width;
    const brightest = 2 ** frame.bits - 1;
    const nearLimit = frame.near;
    const recData = scanlines[1].data;
    const origData = scanlines[0].data;
    const errData = scanlines[2].data;
    for (let x = 0; x < width; x++) {
      const after = reconstructed[xMap[x]];
      const i = x * 4;
      const gray = Math.round(after * 255 / brightest);
      state.reconstruction[base + x] = after;
      color(recData, i, gray, gray, gray);
      if (original !== null) {
        const before = original[xMap[x]];
        state.original[base + x] = before;
        const originalGray = Math.round(before * 255 / brightest);
        color(origData, i, originalGray, originalGray, originalGray);
        const difference = before >= after ? before - after : after - before;
        const offset = difference <= nearLimit ? difference * 3 : overflowOffset;
        color(errData, i, errorLut[offset], errorLut[offset + 1], errorLut[offset + 2]);
      }
    }
    let firstCanvasAt;
    for (let i = original === null ? 1 : 0; i < (original === null ? 2 : contexts.length); i++) {
      contexts[i].putImageData(scanlines[i], 0, nextY);
      if (i === 1 && nextY === 0) firstCanvasAt = performance.now();
    }
    state.nextY++;
    return firstCanvasAt;
  }

  function inspect(x, y) {
    if (y >= state.nextY) return;
    state.selected = [x, y];
    const position = y * state.width + x;
    const reconstructed = state.reconstruction[position];
    const original = state.original?.[position];
    syncOverlays();
    reportPixel({
      x: state.xMap[x],
      y: Math.floor(y * state.frame.height / state.height),
      original,
      reconstructed,
      error: original === undefined ? undefined : Math.abs(original - reconstructed),
    });
  }

  const directions = new Map([
    ['ArrowLeft', [-1, 0]], ['ArrowRight', [1, 0]],
    ['ArrowUp', [0, -1]], ['ArrowDown', [0, 1]],
    ['Enter', [0, 0]],
  ]);
  for (const [index, canvas] of canvases.entries()) {
    const inspectable = () => state && state.nextY > 0 && (index === 1 || state.original);
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
        Math.max(0, Math.min(state.nextY - 1, y + dy)),
      );
    });
  }
  clear();
  return { clear, configure, drawRow, syncOverlays };
}

export const previewIds = ids;
