import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildIdentity } from '../sdk/report-node.mjs';

const dist = new URL('./dist/', import.meta.url);
const entries = {
  web: ['index.html', 'style.css', 'app.mjs', 'labels.mjs', 'pgm.mjs', 'ppm.mjs', 'scan-inspector.mjs', 'preview.mjs', 'transport.mjs', 'run-report.mjs', 'compatibility.mjs',
    'samples/lily-8.ppm', 'samples/lily-16.ppm', 'samples/lily-sampled.jls'],
  sdk: ['index.mjs', 'worker-client.mjs', 'worker.mjs', 'lunar.mjs', 'verification-report.mjs', 'generated/core.mjs', 'generated/core.wasm'],
};

for (const [folder, names] of Object.entries(entries)) {
  for (const filename of names) {
    const destination = new URL(`${folder}/${filename}`, dist);
    await mkdir(new URL('./', destination), { recursive: true });
    await copyFile(new URL(`../${folder}/${filename}`, import.meta.url), destination);
  }
}

await copyFile(new URL('../tests/conformance/manifest.json', import.meta.url), new URL('web/conformance-manifest.json', dist));

const [js, wasm] = await Promise.all([
  buildIdentity('js', fileURLToPath(new URL('sdk/generated/core.mjs', dist))),
  buildIdentity('wasm-gc', fileURLToPath(new URL('sdk/generated/core.wasm', dist))),
]);
await writeFile(new URL('web/build-info.json', dist), JSON.stringify({
  source: js.source, artifacts: { js: js.artifact, 'wasm-gc': wasm.artifact },
}) + '\n');
await writeFile(new URL('index.html', dist), '<!doctype html>\n<html lang="en"><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=web/"><title>MoonJLS</title><a href="web/">Open MoonJLS</a></html>\n');
console.log(`Static workbench prepared in ${dist.href}`);
