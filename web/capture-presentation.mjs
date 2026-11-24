import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';

const { values } = parseArgs({ options: { url: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' } } });
if (values.help) {
  console.log('Usage: node web/capture-presentation.mjs [--url http://127.0.0.1:8000] [--output .evidence/visual-polish]');
  process.exit(0);
}

const origin = new URL(values.url ?? process.env.MOONJLS_WEB_URL ?? 'http://127.0.0.1:8000');
const output = values.output ?? '.evidence/visual-polish';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const executablePath = process.env.MOONJLS_CHROME;
const lolaPath = process.env.MOONJLS_LOLA ?? '.evidence/real/lola.pgm';

let hasLola = false;
try {
  await access(lolaPath);
  hasLola = true;
} catch {
  hasLola = false;
}

const scenarios = [
  { file: 'desktop-zh-1440.png', width: 1440, height: 900, language: 'zh', near: 3, useLola: true, view: 'compare' },
  { file: 'desktop-en-1366.png', width: 1366, height: 768, language: 'en', near: 3, useLola: true, view: 'compare' },
  { file: 'desktop-zh-error-mode.png', width: 1440, height: 900, language: 'zh', near: 3, useLola: true, view: 'difference' },
  { file: 'desktop-zh-near0.png', width: 1440, height: 900, language: 'zh', near: 0, useLola: false, view: 'compare', resources: true, fullPage: true },
  { file: 'narrow-390.png', width: 390, height: 844, language: 'zh', near: 0, useLola: false, view: 'reconstruction', fullPage: true },
  { file: 'jls-no-reference.png', width: 1440, height: 900, language: 'zh', near: 3, decodeOnly: true, view: 'reconstruction' },
];

await mkdir(output, { recursive: true });
const browser = await chromium.launch(executablePath ? { executablePath } : { channel: 'chrome' });
const responses = new Map();
const captures = [];

try {
  // Build one real JLS stream from the built-in 16-bit sample for standalone decode verification.
  const prepPage = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  let sampleJlsBytes;
  try {
    await prepPage.goto(new URL('/web/', origin).href);
    await prepPage.locator('#example').click();
    await prepPage.locator('#near').selectOption('3');
    await prepPage.locator('#run').click();
    await prepPage.locator('#status[data-state="complete"]').waitFor({ timeout: 30_000 });
    const pending = prepPage.waitForEvent('download');
    await prepPage.locator('#download').click();
    sampleJlsBytes = await readFile(await (await pending).path());
  } finally {
    await prepPage.close();
  }

  for (const spec of scenarios) {
    const { file, width, height, language, near, useLola, decodeOnly, view, resources, fullPage } = spec;
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    try {
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
      page.context().on('response', (response) => {
        const url = new URL(response.url());
        const path = url.pathname;
        if (url.origin !== origin.origin || !response.ok() || responses.has(path)) return;
        if (path !== '/web/' && !/\.(css|mjs|wasm)$/.test(path)) return;
        responses.set(path, response.body().then((body) => ({ bytes: body.length, sha256: sha256(body) }),
          (error) => ({ error: error.message })));
      });

      await page.goto(new URL('/web/', origin).href);
      await page.locator('#language').selectOption(language);

      let sourceLabel = 'ripple-16.pgm';
      if (decodeOnly) {
        sourceLabel = 'ripple-16-near3.jls';
        await page.locator('#file').setInputFiles({
          name: sourceLabel,
          mimeType: 'application/octet-stream',
          buffer: sampleJlsBytes,
        });
      } else if (useLola && hasLola) {
        sourceLabel = 'lola.pgm';
        await page.locator('#file').setInputFiles(lolaPath);
        await page.locator('#near').selectOption(String(near));
      } else {
        await page.locator('#example').click();
        await page.locator('#near').selectOption(String(near));
      }

      await page.locator('#run').click();
      await page.locator('#status[data-state="complete"]').waitFor({ timeout: 30_000 });

      if (decodeOnly) {
        assert.equal(await page.locator('#error').textContent(), language === 'zh' ? '未比较' : 'Not compared');
      } else {
        assert.equal(Number(await page.locator('#error').textContent()), near);
      }
      assert.equal(await page.locator('#download').isVisible(), true);

      if (view && view !== 'compare') {
        await page.locator(`.view-tab[data-view="${view}"]`).click();
      }

      if (decodeOnly) {
        await page.locator('#reconstruction').click();
        assert.equal(await page.locator('#inspect-original').textContent(), '未比较');
        assert.equal(await page.locator('#inspect-error').textContent(), '未比较');
        await page.locator('.view-tab[data-view="difference"]').click();
        assert.equal(await page.locator('#difference').isVisible(), false);
        assert.equal(await page.locator('[data-pane="difference"] .reference-placeholder').isVisible(), true);
        await page.locator('.view-tab[data-view="reconstruction"]').click();
      } else if (sourceLabel === 'lola.pgm') {
        const targetId = view === 'difference' ? '#difference' : '#reconstruction';
        const box = await page.locator(targetId).evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const scale = Math.min(bounds.width / element.width, bounds.height / element.height);
          const drawW = element.width * scale;
          const drawH = element.height * scale;
          return {
            x: bounds.left + (bounds.width - drawW) / 2 + drawW * 0.42,
            y: bounds.top + (bounds.height - drawH) / 2 + drawH * 0.36,
          };
        });
        await page.mouse.click(box.x, box.y);
      } else {
        const canvas = page.locator('#reconstruction');
        await canvas.focus();
        await page.keyboard.press('Enter');
        await page.keyboard.press('ArrowRight');
        assert.match(await page.locator('#pixel').textContent(), /\(1, 0\).*65535/);
        await canvas.blur();
      }

      if (resources) await page.locator('#resource-details > summary').click();
      await page.evaluate(() => window.scrollTo(0, 0));

      const result = await page.evaluate((currentView) => {
        const get = (id) => document.getElementById(id);
        const visibleStages = [...document.querySelectorAll('.preview-card')]
          .filter((card) => getComputedStyle(card).display !== 'none')
          .map((card) => {
            const stage = card.querySelector('.image-stage').getBoundingClientRect();
            return { pane: card.dataset.pane, width: stage.width, height: stage.height, top: stage.top, bottom: stage.bottom };
          });
        return {
          rootWidth: document.documentElement.scrollWidth,
          runBottom: get('run').getBoundingClientRect().bottom,
          resultsBottom: document.querySelector('.results').getBoundingClientRect().bottom,
          htmlLanguage: document.documentElement.lang,
          activeView: get('workspace-view').getAttribute('data-view'),
          expectedView: currentView,
          previews: visibleStages,
          status: get('status').textContent,
          spec: get('frame').textContent,
          encoded: get('encoded').textContent,
          maxError: get('error').textContent,
          pixel: get('pixel').textContent,
          inspectCoord: get('inspect-coord').textContent,
          inspectOriginal: get('inspect-original').textContent,
          inspectReconstructed: get('inspect-reconstructed').textContent,
          inspectError: get('inspect-error').textContent,
        };
      }, view);

      assert.equal(result.htmlLanguage, language === 'zh' ? 'zh-CN' : 'en');
      assert.ok(result.rootWidth <= width, `Horizontal overflow at ${width}px: ${result.rootWidth}`);
      assert.ok(result.previews.length >= 1 && result.previews.every((p) => p.height > 0 && p.height <= 325));
      if (width > 640) {
        assert.ok(result.previews[0].top <= 220, `${file}: expected image stage top <= 220px, got ${result.previews[0].top}`);
        assert.ok(result.runBottom < height, `${file}: expected run button inside viewport height`);
        assert.ok(result.previews.every((p) => p.bottom < height), `${file}: expected previews above fold`);
      }
      if (width === 1366 && height === 768 && !resources) {
        assert.ok(result.resultsBottom <= height + 2, `${file}: expected primary KPI cards visible on 1366x768 fold, bottom=${result.resultsBottom}`);
      }

      const path = join(output, file);
      await page.screenshot({ path, fullPage: Boolean(fullPage) });
      assert.deepEqual(errors, [], `${file} emitted browser errors`);
      captures.push({
        file, width, height, language, near, source: sourceLabel, view: result.activeView,
        fullPage: Boolean(fullPage), ...result, sha256: sha256(await readFile(path)), browserErrors: errors,
      });
      console.log(`${file} [${sourceLabel}] ${width}×${height} stageTop=${result.previews[0].top.toFixed(1)}px ${result.spec} · ${result.encoded} · err=${result.maxError}`);
    } finally {
      await page.close();
    }
  }

  const loaded = Object.fromEntries(await Promise.all([...responses].map(async ([path, receipt]) => [path, await receipt])));
  for (const path of ['/web/', '/web/style.css', '/web/app.mjs', '/web/preview.mjs', '/web/labels.mjs', '/sdk/worker.mjs', '/sdk/generated/core.wasm']) {
    assert.match(loaded[path]?.sha256 ?? '', /^[a-f0-9]{64}$/, `Missing browser receipt for ${path}`);
  }
  await writeFile(join(output, 'capture-receipt.json'), JSON.stringify({
    browser: browser.version(), node: process.version,
    lolaFixtureUsed: hasLola ? lolaPath : null,
    generatedUtc: new Date().toISOString(), captures, responses: loaded,
  }, null, 2) + '\n');
} finally {
  await browser.close();
}
