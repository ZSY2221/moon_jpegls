import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const generated = new URL('./generated/', import.meta.url);
mkdirSync(generated, { recursive: true });

for (const [target, extension] of [['js', 'js'], ['wasm-gc', 'wasm']]) {
  const result = spawnSync('moon', ['build', 'cmd/bridge', '--release', '--target', target], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  copyFileSync(
    new URL(`../_build/${target}/release/build/cmd/bridge/bridge.${extension}`, import.meta.url),
    new URL(target === 'js' ? 'core.mjs' : 'core.wasm', generated),
  );
}
