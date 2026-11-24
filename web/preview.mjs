const ids = ['original', 'reconstruction', 'difference'];

function color(data, index, r, g, b) {
  data[index] = r;
  data[index + 1] = g;
  data[index + 2] = b;
  data[index + 3] = 255;
}

function imagePoint(canvas, event, width, height) {
  // CSS gives the canvas a borderless box and uses centered object-fit: contain.
  const bounds = canvas.getBoundingClientRect();
  const boxWidth = bounds.width ?? canvas.clientWidth;
  const boxHeight = bounds.height ?? canvas.clientHeight;
  const scale = Math.min(boxWidth / width, boxHeight / height);
  if (scale === 0) return;
  const x = (event.clientX - bounds.left - (boxWidth - width * scale) / 2) / scale;
  const y = (event.clientY - bounds.top - (boxHeight - height * scale) / 2) / scale;
  if (x >= 0 && x < width && y >= 0 && y < height) return [Math.floor(x), Math.floor(y)];
}

export function createPreview(canvases, reportPixel) {
  let state;
  const clear = () => {
    state = undefined;
    for (const canvas of canvases) {
      canvas.width = 300;
      canvas.height = 200;
      canvas.tabIndex = -1;
    }
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
    }
    const contexts = canvases.map((canvas) => canvas.getContext('2d'));
    state = {
      frame, width, height, xMap, contexts, nextY: 0,
      scanlines: contexts.map((context) => context.createImageData(width, 1)),
      original: hasReference ? new Uint16Array(width * height) : null,
      reconstruction: new Uint16Array(width * height),
    };
  }

  function drawRow(index, reconstructed, original) {
    const { frame, width, height, xMap, contexts, scanlines, nextY } = state;
    if (nextY === height || index !== Math.floor(nextY * frame.height / height)) return;
    const base = nextY * width;
    const brightest = 2 ** frame.bits - 1;
    for (let x = 0; x < width; x++) {
      const after = reconstructed[xMap[x]];
      const i = x * 4;
      const gray = Math.round(after * 255 / brightest);
      state.reconstruction[base + x] = after;
      color(scanlines[1].data, i, gray, gray, gray);
      if (original !== null) {
        const before = original[xMap[x]];
        state.original[base + x] = before;
        const originalGray = Math.round(before * 255 / brightest);
        color(scanlines[0].data, i, originalGray, originalGray, originalGray);
        const difference = Math.abs(before - after);
        const heat = Math.min(1, difference / Math.max(1, frame.near));
        color(scanlines[2].data, i, Math.round(13 + 236 * heat), Math.round(24 + 91 * heat), 41);
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
    reportPixel({ x: state.xMap[x], y: Math.floor(y * state.frame.height / state.height),
      original, reconstructed, error: original === undefined ? undefined : Math.abs(original - reconstructed) });
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
      inspect(Math.max(0, Math.min(state.width - 1, x + dx)),
        Math.max(0, Math.min(state.nextY - 1, y + dy)));
    });
  }
  clear();
  return { clear, configure, drawRow };
}

export const previewIds = ids;
