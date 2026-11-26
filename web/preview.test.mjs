import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPreview, errorColor, errorLegendStops, errorPalette, ERROR_OVERFLOW_RGB } from './preview.mjs';

function makeLayer() {
  const mkNode = () => ({ style: {} });
  const nodes = { '.reticle-h': mkNode(), '.reticle-v': mkNode(), '.reticle-box': mkNode() };
  return {
    hidden: true,
    querySelector: (selector) => nodes[selector],
    nodes,
  };
}

class Canvas {
  clientLeft = 0;
  clientTop = 0;
  listeners = new Map();
  draws = [];

  constructor(clientWidth, clientHeight, withOverlay = false) {
    this.clientWidth = clientWidth;
    this.clientHeight = clientHeight;
    if (withOverlay) {
      const layer = makeLayer();
      this.overlay = layer;
      this.parentElement = { querySelector: (sel) => (sel === '.reticle-layer' ? layer : null) };
    }
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

function surfaces(width, height, withOverlay = false) {
  const canvases = [
    new Canvas(width, height, withOverlay),
    new Canvas(width, height, withOverlay),
    new Canvas(width, height, withOverlay),
  ];
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

test('wide decoded planes retain the full inverse point transform and account for four bytes per sample', () => {
  const { reconstructed, pixels, preview } = surfaces(160, 160);
  const near = 0;
  const pointTransform = 15;
  const value = 65535 * 2 ** pointTransform;
  preview.configure({ width: 1, height: 1, bits: 16, near, pointTransform }, false, { sampleFormat: 'u32' });
  preview.drawRow(0, Uint32Array.of(value), null);
  assert.equal(reconstructed.key('Enter'), true);
  assert.equal(pixels.at(-1).reconstructed, value);
  assert.equal(preview.bufferBytes(), 4);
  assert.deepEqual([...reconstructed.draws[0].data], [255, 255, 255, 255]);
});

test('a wide round trip scales its preview to the achievable reconstruction range', () => {
  const { original, reconstructed, preview } = surfaces(160, 160);
  preview.configure({ width: 1, height: 1, bits: 16, near: 2, pointTransform: 2 }, true,
    { sampleFormat: 'u32', sourceMaxval: 65535 });
  preview.drawRow(0, Uint32Array.of(65540), Uint16Array.of(65535), {
    near: 2, pointTransform: 2, preset: { maxval: 65535 },
  });
  assert.deepEqual([...original.draws[0].data], [255, 255, 255, 255]);
  assert.deepEqual([...reconstructed.draws[0].data], [255, 255, 255, 255]);
  assert.equal(preview.bufferBytes(), 6);
});

test('errorPalette and errorColor provide calibrated monotonic discrete stops and mark overflow beyond NEAR', () => {
  const p0 = errorPalette(0);
  assert.equal(p0.length, 1);
  assert.deepEqual(p0[0].rgb, [12, 19, 28]);

  const p3 = errorPalette(3);
  assert.equal(p3.length, 4);
  const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  for (let i = 1; i < p3.length; i++) {
    assert.ok(luminance(p3[i].rgb) > luminance(p3[i - 1].rgb), `Stop ${i} should be brighter than stop ${i - 1}`);
  }
  assert.deepEqual(errorColor(0, 3), p3[0].rgb);
  assert.deepEqual(errorColor(3, 3), p3[3].rgb);
  assert.deepEqual(errorColor(4, 3), ERROR_OVERFLOW_RGB);
  assert.deepEqual(errorColor(1, 0), ERROR_OVERFLOW_RGB);
});

test('high NEAR uses the same calibrated colors in the legend and canvas', () => {
  const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  for (const near of [4, 127, 255]) {
    const palette = errorPalette(near);
    const legend = errorLegendStops(near);
    assert.equal(palette.length, near + 1);
    assert.deepEqual(palette[0].rgb, errorColor(0, 3));
    assert.deepEqual(palette[near].rgb, errorColor(3, 3));
    assert.ok(palette.every((stop, index) => index === 0 || luminance(stop.rgb) >= luminance(palette[index - 1].rgb)));
    assert.deepEqual(legend.map(({ value }) => value), [0, Math.round(near / 4), Math.round(near / 2), Math.round(near * 3 / 4), near]);
    assert.deepEqual(legend, legend.map(({ value }) => palette[value]));

    const { preview, difference } = surfaces(100, 100);
    const diffs = [0, Math.round(near / 2), near, near + 1];
    preview.configure({ width: diffs.length, height: 1, bits: 16, near }, true);
    preview.drawRow(0, new Uint16Array(diffs.length), Uint16Array.from(diffs));
    assert.deepEqual([...difference.draws[0].data], diffs.flatMap(value => [...errorColor(value, near), 255]));
    assert.deepEqual(errorColor(near + 1, near), ERROR_OVERFLOW_RGB);
  }
});

test('synchronized reticle overlays stay inside content area across resize and clear', () => {
  const { original, reconstructed, difference, preview } = surfaces(240, 160, true);
  preview.configure({ width: 4, height: 2, bits: 16, near: 3 }, true);
  preview.drawRow(0, Uint16Array.of(0, 100, 200, 300), Uint16Array.of(0, 100, 200, 303));
  reconstructed.click(150, 50); // sampled x=2, y=0 -> box scale 60, content top=20, left=0
  assert.equal(original.overlay.hidden, false);
  assert.equal(reconstructed.overlay.hidden, false);
  assert.equal(difference.overlay.hidden, false);
  assert.equal(original.overlay.nodes['.reticle-box'].style.left, '150px');
  assert.equal(original.overlay.nodes['.reticle-box'].style.top, '50px');
  assert.equal(original.overlay.nodes['.reticle-h'].style.left, '0px');
  assert.equal(original.overlay.nodes['.reticle-h'].style.width, '240px');

  reconstructed.clientWidth = 120;
  reconstructed.clientHeight = 120;
  preview.syncOverlays();
  assert.equal(reconstructed.overlay.nodes['.reticle-h'].style.width, '120px');
  assert.equal(reconstructed.overlay.nodes['.reticle-box'].style.left, '75px');

  preview.clear();
  assert.equal(original.overlay.hidden, true);
  assert.equal(reconstructed.overlay.hidden, true);
  assert.equal(difference.overlay.hidden, true);
});

test('multicomponent preview preserves >255 raw integers, switches composite/channels and reports bufferBytes', () => {
  const { original, reconstructed, difference, pixels, preview } = surfaces(240, 160);
  const frame = {
    width: 2,
    height: 1,
    bits: 16,
    near: 0,
    maxval: 65535,
    components: [
      { id: 10, hSampling: 1, vSampling: 1 },
      { id: 20, hSampling: 1, vSampling: 1 },
      { id: 30, hSampling: 1, vSampling: 1 },
    ],
  };
  preview.configure(frame, true, { componentCount: 3, componentLabels: ['Band 0', 'Band 1', 'Band 2'], initialChannel: 'composite' });
  assert.equal(preview.bufferBytes(), 3 * 2 * 1 * 2 * 2);
  preview.drawRow(0, Uint16Array.of(65535, 1025), Uint16Array.of(65535, 1025), { componentIndex: 0, near: 0 });
  preview.drawRow(0, Uint16Array.of(32768, 512), Uint16Array.of(32768, 513), { componentIndex: 1, near: 2 });
  preview.drawRow(0, Uint16Array.of(4095, 65000), Uint16Array.of(4095, 65000), { componentIndex: 2, near: 0 });

  reconstructed.click(120, 80); // x=1, y=0
  assert.equal(pixels.at(-1).x, 1);
  assert.equal(pixels.at(-1).channel, 'composite');
  assert.deepEqual(pixels.at(-1).components.map((c) => [c.label, c.original, c.reconstructed, c.error, c.near]), [
    ['Band 0', 1025, 1025, 0, 0],
    ['Band 1', 513, 512, 1, 2],
    ['Band 2', 65000, 65000, 0, 0],
  ]);

  preview.setChannel(1);
  assert.equal(pixels.at(-1).channel, 1);
  assert.equal(pixels.at(-1).original, 513);
  assert.equal(pixels.at(-1).reconstructed, 512);
  assert.equal(pixels.at(-1).error, 1);
  assert.equal(pixels.at(-1).near, 2);
  assert.deepEqual([...original.draws.at(-1).data.subarray(0, 3)], [...reconstructed.draws.at(-1).data.subarray(0, 3)]);
});
