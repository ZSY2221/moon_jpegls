import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';

const { values } = parseArgs({ options: { url: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' } } });
if (values.help) {
  console.log('Usage: node web/capture-presentation.mjs [--url http://127.0.0.1:8000] [--output .evidence/presentation]');
  process.exit(0);
}

const origin = new URL(values.url ?? process.env.MOONJLS_WEB_URL ?? 'http://127.0.0.1:8000');
const output = values.output ?? '.evidence/presentation';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const executablePath = process.env.MOONJLS_CHROME;
const formats = [
  { file: 'desktop-en.png', width: 1366, height: 768, language: 'en', near: 3 },
  { file: 'desktop-zh.png', width: 1440, height: 900, language: 'zh', near: 3, resources: true, fullPage: true },
  { file: 'narrow-390.png', width: 390, height: 844, language: 'zh', near: 0, fullPage: true },
];

await mkdir(output, { recursive: true });
const browser = await chromium.launch(executablePath ? { executablePath } : { channel: 'chrome' });
const responses = new Map();
const captures = [];
try {
  for (const { file, width, height, language, near, resources, fullPage } of formats) {
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
      await page.locator('#example').click();
      await page.locator('#near').selectOption(String(near));
      await page.locator('#run').click();
      await page.locator('#status[data-state="complete"]').waitFor({ timeout: 30_000 });
      assert.equal(Number(await page.locator('#error').textContent()), near);
      assert.equal(await page.locator('#download').isVisible(), true);

      const canvas = page.locator('#reconstruction');
      await canvas.focus();
      await page.keyboard.press('Enter');
      await page.keyboard.press('ArrowRight');
      assert.match(await page.locator('#pixel').textContent(), /\(1, 0\).*65535/);
      await canvas.blur();
      if (resources) await page.locator('#resource-details > summary').click();
      await page.evaluate(() => window.scrollTo(0, 0));
      const result = await page.evaluate(() => {
        const get = (id) => document.getElementById(id);
        const previews = [...document.querySelectorAll('.image-stage')].map((stage) => {
          const { width, height, top, bottom } = stage.getBoundingClientRect();
          return { width, height, top, bottom };
        });
        return {
          rootWidth: document.documentElement.scrollWidth,
          runBottom: get('run').getBoundingClientRect().bottom,
          htmlLanguage: document.documentElement.lang,
          previews,
          status: get('status').textContent,
          spec: get('frame').textContent,
          encoded: get('encoded').textContent,
          maxError: get('error').textContent,
          pixel: get('pixel').textContent,
        };
      });
      assert.equal(result.htmlLanguage, language === 'zh' ? 'zh-CN' : 'en');
      assert.ok(result.rootWidth <= width, `Horizontal overflow at ${width}px`);
      assert.ok(result.runBottom < height && result.previews[0].top < height);
      assert.equal(result.previews.length, 3);
      assert.ok(result.previews.every((preview) => preview.height > 0 && preview.height < 300));
      if (width > 620) assert.ok(result.previews.every((preview) => preview.bottom < height));

      const path = join(output, file);
      await page.screenshot({ path, fullPage: Boolean(fullPage) });
      assert.deepEqual(errors, [], `${file} emitted browser errors`);
      captures.push({ file, width, height, language, near, fullPage: Boolean(fullPage), ...result,
        sha256: sha256(await readFile(path)), browserErrors: errors });
      console.log(`${file} ${width}×${height} ${result.spec} · ${result.encoded} · max error ${result.maxError}`);
    } finally {
      await page.close();
    }
  }
  const loaded = Object.fromEntries(await Promise.all([...responses].map(async ([path, receipt]) => [path, await receipt])));
  for (const path of ['/web/', '/web/style.css', '/web/app.mjs', '/web/preview.mjs', '/sdk/worker.mjs', '/sdk/generated/core.wasm']) {
    assert.match(loaded[path]?.sha256 ?? '', /^[a-f0-9]{64}$/, `Missing browser receipt for ${path}`);
  }
  await writeFile(join(output, 'capture-receipt.json'), JSON.stringify({ browser: browser.version(), node: process.version,
    generatedUtc: new Date().toISOString(), captures, responses: loaded }, null, 2) + '\n');
} finally {
  await browser.close();
}
