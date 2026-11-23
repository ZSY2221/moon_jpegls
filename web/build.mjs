import { copyFile, mkdir, writeFile } from 'node:fs/promises';

const dist = new URL('./dist/', import.meta.url);
const entries = {
  web: ['index.html', 'style.css', 'app.mjs', 'labels.mjs', 'pgm.mjs', 'preview.mjs', 'transport.mjs'],
  sdk: ['index.mjs', 'worker-client.mjs', 'worker.mjs', 'generated/core.mjs', 'generated/core.wasm'],
};

for (const [folder, names] of Object.entries(entries)) {
  for (const filename of names) {
    const destination = new URL(`${folder}/${filename}`, dist);
    await mkdir(new URL('./', destination), { recursive: true });
    await copyFile(new URL(`../${folder}/${filename}`, import.meta.url), destination);
  }
}

await writeFile(new URL('index.html', dist), '<!doctype html>\n<html lang="en"><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=web/"><title>MoonJLS</title><a href="web/">Open MoonJLS</a></html>\n');
console.log(`Static workbench prepared in ${dist.href}`);
