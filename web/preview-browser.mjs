import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const origin = process.env.MOONJLS_WEB_URL ?? 'http://127.0.0.1:8000';
const executablePath = process.env.MOONJLS_CHROME;
const browser = await chromium.launch(executablePath ? { executablePath } : { channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error));
page.on('console', (message) => { if (message.type() === 'error') pageErrors.push(message.text()); });

function sample(x, y) {
  return (x * 173 + y * 47 + ((x ^ y) & 31) * 3) & 65535;
}

function pgm(width, height) {
  const header = Buffer.from(`P5\n${width} ${height}\n65535\n`);
  const input = Buffer.alloc(header.length + width * height * 2);
  header.copy(input);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) input.writeUInt16BE(sample(x, y), header.length + (y * width + x) * 2);
  }
  return input;
}

async function render(width, height) {
  await page.locator('#file').setInputFiles({
    name: `preview-${width}x${height}.pgm`, mimeType: 'image/x-portable-graymap', buffer: pgm(width, height),
  });
  await page.locator('#near').selectOption('0');
  await page.locator('#sink').selectOption('bounded');
  const advanced = page.locator('#advanced');
  if (!(await advanced.evaluate((element) => element.open))) await advanced.locator('summary').click();
  await page.locator('#chunk').fill('4096');
  await page.locator('#run').click();
  await page.locator('#status[data-state="complete"]').waitFor({ state: 'attached' });
  assert.equal(await page.locator('#error').textContent(), '0');
}

async function geometry(id) {
  const canvas = page.locator(`#${id}`);
  await canvas.scrollIntoViewIfNeeded();
  const rect = await canvas.evaluate((element) => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return {
      left: bounds.left, top: bounds.top, w: bounds.width, h: bounds.height,
      naturalWidth: element.width, naturalHeight: element.height, fit: style.objectFit, position: style.objectPosition,
    };
  });
  assert.equal(rect.fit, 'contain');
  assert.equal(rect.position, '50% 50%');
  assert.ok(rect.h > 0 && rect.h <= 320, `The canvas box should remain bounded (got ${rect.h})`);
  const scale = Math.min(rect.w / rect.naturalWidth, rect.h / rect.naturalHeight);
  const w = rect.naturalWidth * scale;
  const h = rect.naturalHeight * scale;
  return { rect, w, h, left: rect.left + (rect.w - w) / 2, top: rect.top + (rect.h - h) / 2 };
}

async function assertPixel(x, y) {
  const value = sample(x, y);
  const text = await page.locator('#pixel').textContent();
  assert.ok(text.includes(`(${x}, ${y})`) && text.includes(`original ${value} · reconstructed ${value} · error 0`), text);
  assert.equal(await page.locator('#inspect-coord').textContent(), `(${x}, ${y})`);
  assert.equal(await page.locator('#inspect-original').textContent(), value.toLocaleString('en'));
  assert.equal(await page.locator('#inspect-reconstructed').textContent(), value.toLocaleString('en'));
  assert.equal(await page.locator('#inspect-error').textContent(), '0');
  return [x, y, value];
}

async function assertReticlesVisible(panes) {
  for (const pane of panes) {
    const box = await page.locator(`[data-pane="${pane}"] .reticle-layer .reticle-box`).evaluate((el) => {
      const layer = el.closest('.reticle-layer');
      const stage = el.closest('.image-stage');
      const canvas = stage.querySelector('canvas');
      const cRect = canvas.getBoundingClientRect();
      const scale = Math.min(cRect.width / canvas.width, cRect.height / canvas.height);
      const drawW = canvas.width * scale;
      const drawH = canvas.height * scale;
      const cLeft = cRect.left + (cRect.width - drawW) / 2;
      const cTop = cRect.top + (cRect.height - drawH) / 2;
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const hRect = layer.querySelector('.reticle-h').getBoundingClientRect();
      const vRect = layer.querySelector('.reticle-v').getBoundingClientRect();
      return {
        hidden: layer.hidden,
        centerInContent: cx >= cLeft - 1 && cx <= cLeft + drawW + 1 && cy >= cTop - 1 && cy <= cTop + drawH + 1,
        hairlinesFitContent: Math.abs(hRect.width - drawW) < 2 && Math.abs(vRect.height - drawH) < 2,
      };
    });
    assert.equal(box.hidden, false, `Expected reticle visible on ${pane}`);
    assert.equal(box.centerInContent, true, `Expected reticle center inside content box on ${pane}`);
    assert.equal(box.hairlinesFitContent, true, `Expected crosshair hairlines bounded to content box on ${pane}`);
  }
}

async function point(content, width, height, horizontal, vertical) {
  // Use whole CSS pixels so the click position is representable even on a downscaled canvas.
  const screenX = Math.round(content.left + content.w * horizontal);
  const screenY = Math.round(content.top + content.h * vertical);
  const sampledX = Math.floor((screenX - content.left) / content.w * content.rect.naturalWidth);
  const sampledY = Math.floor((screenY - content.top) / content.h * content.rect.naturalHeight);
  const x = Math.floor(sampledX * width / content.rect.naturalWidth);
  const y = Math.floor(sampledY * height / content.rect.naturalHeight);
  await page.mouse.click(screenX, screenY);
  return assertPixel(x, y);
}

async function ignoreLetterbox(content, side) {
  const before = await page.locator('#pixel').textContent();
  const { rect } = content;
  const x = side === 'left' ? Math.round((rect.left + content.left) / 2) : Math.round(rect.left + rect.w / 2);
  const y = side === 'top' ? Math.round((rect.top + content.top) / 2) : Math.round(rect.top + rect.h / 2);
  assert.ok(side === 'left' ? x < content.left : y < content.top);
  await page.mouse.click(x, y);
  assert.equal(await page.locator('#pixel').textContent(), before);
}

try {
  await page.goto(`${origin}/web/`);
  await render(128, 16);
  const horizontal = await geometry('original');
  await page.locator('#original').focus();
  await page.keyboard.press('Enter');
  const keyboardOrigin = await assertPixel(0, 0);
  await assertReticlesVisible(['original', 'reconstruction']);
  await page.keyboard.press('ArrowRight');
  const keyboardNeighbor = await assertPixel(1, 0);
  const widePoint = await point(horizontal, 128, 16, 0.52, 0.44);
  await ignoreLetterbox(horizontal, 'top');

  // Switching to Error view keeps the selected coordinate and shows the reticle there.
  await page.locator('.view-tab[data-view="difference"]').click();
  await assertReticlesVisible(['difference']);
  await page.locator('.view-tab[data-view="compare"]').click();

  await render(512, 4096);
  const tall = await geometry('reconstruction');
  assert.deepEqual([tall.rect.naturalWidth, tall.rect.naturalHeight], [40, 320]);
  const desktopPoint = await point(tall, 512, 4096, 0.62, 0.35);
  await ignoreLetterbox(tall, 'left');
  await assertReticlesVisible(['original', 'reconstruction']);

  await page.setViewportSize({ width: 390, height: 840 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await page.locator('.view-tab[data-view="difference"]').click();
  const narrow = await geometry('difference');
  const mobilePoint = await point(narrow, 512, 4096, 0.54, 0.66);
  await ignoreLetterbox(narrow, 'left');
  await assertReticlesVisible(['difference']);
  assert.ok([widePoint, desktopPoint, mobilePoint].every(([, , value]) => value > 255));
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({
    browser: browser.version(),
    scenarios: { widePoint, desktopPoint, mobilePoint, keyboardOrigin, keyboardNeighbor },
    tallBackingCanvas: [40, 320],
    letterboxIgnored: ['horizontal-top', 'tall-left', 'narrow-left'],
    state: 'passed',
  }));
} finally {
  await browser.close();
}
