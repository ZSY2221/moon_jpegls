import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPreview } from './preview.mjs';

class Canvas {
  clientLeft = 0;
  clientTop = 0;
  listeners = new Map();
  draws = [];

  constructor(clientWidth, clientHeight) {
    this.clientWidth = clientWidth;
    this.clientHeight = clientHeight;
  }

  addEventListener(type, handler) {
    this.listeners.set(type, handler);
  }

  getBoundingClientRect() {
    return { left: 10, top: 15 };
  }

  getContext() {
    return {
      createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
      putImageData: ({ data }, x, y) => this.draws.push({ x, y, data: data.slice(), at: performance.now() }),
    };
  }

  click(boxX, boxY) {
    return this.listeners.get('click')({ clientX: boxX + 10, clientY: boxY + 15 });
  }

  key(key) {
    let prevented = false;
    this.listeners.get('keydown')({ key, preventDefault: () => { prevented = true; } });
    return prevented;
  }
}

function surfaces(width, height) {
  const canvases = [new Canvas(width, height), new Canvas(width, height), new Canvas(width, height)];
  const [original, reconstructed, difference] = canvases;
  const pixels = [];
  const preview = createPreview(canvases, (value) => pixels.push(value));
  return { original, reconstructed, difference, pixels, preview };
}

test('wide preview ignores letterbox and preserves equal grayscale mapping and full integers', () => {
  const { original, reconstructed, difference, pixels, preview } = surfaces(240, 160);
  preview.configure({ width: 4, height: 2, bits: 16, near: 3 }, true);
  const firstTime = preview.drawRow(0, Uint16Array.of(0, 32768, 65535, 1025), Uint16Array.of(0, 32768, 65535, 1028));
  assert.ok(firstTime >= reconstructed.draws[0].at);
  assert.ok(firstTime <= difference.draws[0].at);
  assert.deepEqual([...original.draws[0].data.subarray(0, 12)], [...reconstructed.draws[0].data.subarray(0, 12)]);

  reconstructed.click(150, 10); // The first 20 CSS px are blank.
  reconstructed.click(150, 110); // A row that has yet to arrive.
  assert.equal(pixels.length, 0);
  reconstructed.click(150, 50);
  assert.deepEqual(pixels.at(-1), { x: 2, y: 0, original: 65535, reconstructed: 65535, error: 0 });
  assert.equal(reconstructed.key('ArrowRight'), true);
  assert.deepEqual(pixels.at(-1), { x: 3, y: 0, original: 1028, reconstructed: 1025, error: 3 });
  assert.equal(preview.drawRow(1, Uint16Array.of(0, 256, 41000, 65535), Uint16Array.of(0, 256, 41000, 65535)), undefined);
  assert.equal(reconstructed.key('ArrowDown'), true);
  assert.deepEqual(pixels.at(-1), { x: 3, y: 1, original: 65535, reconstructed: 65535, error: 0 });
});

test('tall sampled preview maps across desktop and narrow content boxes without borrowing input rows', () => {
  const { original, reconstructed, difference, pixels, preview } = surfaces(360, 240);
  preview.configure({ width: 512, height: 4096, bits: 16, near: 0 }, true);
  assert.deepEqual([reconstructed.width, reconstructed.height], [40, 320]);
  const input = new Uint16Array(512);
  input[256] = 65535;
  preview.drawRow(0, input, input);
  input[256] = 1; // A later input cannot overwrite an already retained sampled row.
  for (let y = 1; y < 17; y++) preview.drawRow(Math.floor(y * 4096 / 320), input, input);
  input[256] = 32768;
  preview.drawRow(Math.floor(17 * 4096 / 320), input, input);
  input[256] = 2;

  reconstructed.click(10, 13);
  assert.equal(pixels.length, 0); // Horizontal blank area in the tall fitted image.
  reconstructed.click(180 + 0.375, 0.375);
  assert.deepEqual(pixels.at(-1), { x: 256, y: 0, original: 65535, reconstructed: 65535, error: 0 });
  original.clientWidth = 320;
  original.clientHeight = 128;
  original.click(160 + 0.2, 7);
  assert.deepEqual(pixels.at(-1), { x: 256, y: 217, original: 32768, reconstructed: 32768, error: 0 });
  difference.click(180 + 0.375, 13.125);
  assert.deepEqual(pixels.at(-1), { x: 256, y: 217, original: 32768, reconstructed: 32768, error: 0 });
});

test('standalone decode exposes the reconstructed integers with no original or error', () => {
  const { original, reconstructed, difference, pixels, preview } = surfaces(160, 160);
  preview.configure({ width: 1, height: 1, bits: 12, near: 3 }, false);
  const firstTime = preview.drawRow(0, Uint16Array.of(4095), null);
  assert.ok(Number.isFinite(firstTime));
  assert.equal(original.tabIndex, -1);
  assert.equal(difference.tabIndex, -1);
  assert.equal(reconstructed.tabIndex, 0);
  original.click(80, 80);
  difference.click(80, 80);
  assert.equal(pixels.length, 0);
  assert.equal(reconstructed.key('Enter'), true);
  assert.deepEqual(pixels.at(-1), { x: 0, y: 0, original: undefined, reconstructed: 4095, error: undefined });
  preview.clear();
  assert.equal(reconstructed.tabIndex, -1);
  assert.equal(reconstructed.key('Enter'), false);
});
