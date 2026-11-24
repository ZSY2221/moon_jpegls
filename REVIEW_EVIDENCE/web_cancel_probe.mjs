import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The application, PGM reader, preview, and worker client below are unchanged.
// Only the DOM and Worker transport are simulated; no codec artifacts are used.
// Usage: node web_cancel_probe.mjs /absolute/path/to/moonjls [--expect-bug]
// Default mode is a correctness gate: it must FAIL on rc.1 and PASS after the fix.
const root = resolve(process.argv[2] ?? '.');
const expectBug = process.argv.includes('--expect-bug');
const moduleUrl = relative => pathToFileURL(resolve(root, relative)).href;
const { pgmHeader } = await import(moduleUrl('web/pgm.mjs'));
const elements = new Map();
class Element {
  constructor(id) {
    this.id = id; this.listeners = new Map(); this.style = {};
    this.classList = { add() {}, remove() {} };
    this.clientLeft = 0; this.clientTop = 0;
    this.clientWidth = 2; this.clientHeight = 2;
    this.textContent = ''; this.value = ''; this.draws = [];
  }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  setAttribute() {}
  querySelector() { return {}; }
  getBoundingClientRect() { return { left: 0, top: 0 }; }
  getContext() {
    return {
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: (image, x, y) => this.draws.push({ x, y, rgba: [...image.data] }),
    };
  }
}
globalThis.document = {
  getElementById(id) { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); },
  documentElement: {}, querySelectorAll() { return []; },
};
const get = id => document.getElementById(id);
const workers = [];
class FakeWorker {
  constructor() { workers.push(this); this.terminated = false; }
  postMessage(data) {
    if (data.type === 'start') this.settings = data;
    if (data.type === 'cancel') queueMicrotask(() => this.onmessage({ data: { type: 'error', code: 'Cancelled', message: 'cancel probe' } }));
  }
  terminate() { this.terminated = true; }
  emit(data) { return this.onmessage({ data }); }
}
globalThis.Worker = FakeWorker;
await import(moduleUrl('web/app.mjs'));
get('chunk').value = '32768'; get('near').value = '0';
get('backend').value = 'wasm-gc'; get('sink').value = 'bounded';

function pgm(name, samples, blockSecondRow = false) {
  const header = pgmHeader({ width: 2, height: 2, bits: 16 });
  const raster = new Uint8Array(8);
  const view = new DataView(raster.buffer);
  samples.forEach((sample, i) => view.setUint16(i * 2, sample, false));
  const blob = new Blob([header, raster]);
  let unblock;
  const barrier = new Promise(resolve => { unblock = resolve; });
  return {
    name, size: blob.size, unblock,
    slice(start, end) {
      const part = blob.slice(start, end);
      return { async arrayBuffer() {
        if (blockSecondRow && start === header.length + 4 && end === header.length + 8) await barrier;
        return part.arrayBuffer();
      } };
    },
  };
}
const choose = file => get('file').listeners.get('change')({ target: { files: [file] } });
const click = id => get(id).listeners.get('click')({});
const tick = () => new Promise(resolve => setImmediate(resolve));
async function waitWorkers(count) { for (let i = 0; i < 20 && workers.length < count; i++) await tick(); assert.equal(workers.length, count); }
function row(index, value) {
  return {
    type: 'row', seq: index + 1, index, row: Uint16Array.of(value, value),
    frame: { width: 2, height: 2, bits: 16, near: 0 },
    stats: { rows: index + 1, coreWorkspaceBytes: 1000, inputQueueBytes: 0, outputQueueBytes: 4, inputPeakBytes: 32, outputPeakBytes: 4 },
  };
}

const oldFile = pgm('old.pgm', [1000, 1000, 2000, 2000], true);
choose(oldFile);
const firstRun = click('run');
await waitWorkers(2);
await workers[0].emit(row(0, 1000));
const oldPendingCallback = workers[0].emit(row(1, 2000));
await tick();
click('cancel');
await firstRun;
assert.equal(get('status').textContent, 'Cancelled');

const newFile = pgm('new.pgm', [3000, 3000, 4000, 4000]);
choose(newFile);
const secondRun = click('run');
await waitWorkers(4);
await workers[2].emit(row(0, 3000));
oldFile.unblock();
await oldPendingCallback;
await workers[2].emit(row(1, 4000));
get('reconstruction').listeners.get('click')({ clientX: 0.5, clientY: 1.5 });
const observed = get('pixel').textContent;
console.log(JSON.stringify({
  test: 'cancelled old job must not overwrite new job preview',
  mode: expectBug ? 'record-known-bug' : 'correctness-gate',
  expectedNewPixel: 4000, observed,
  oldWorkerTerminated: workers[0].terminated,
  scope: 'unchanged app.mjs + worker-client.mjs + pgm.mjs + preview.mjs; fake DOM/Worker transport; no generated codec',
}));
try {
  assert.equal(workers[0].terminated, true);
  if (expectBug) {
    assert.match(observed, /original 2000 · reconstructed 2000/);
    assert.doesNotMatch(observed, /reconstructed 4000/);
  } else {
    assert.match(observed, /original 4000 · reconstructed 4000/,
      'A cancelled old callback must not replace the new job preview');
    assert.doesNotMatch(observed, /original 2000/);
  }
} finally {
  click('cancel');
  await secondRun;
}
