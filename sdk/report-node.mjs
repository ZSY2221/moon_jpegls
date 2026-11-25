import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

export async function fileSha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function sourceIdentity() {
  try {
    const [revision, changes] = await Promise.all([
      exec('git', ['rev-parse', 'HEAD'], { cwd: root }),
      exec('git', ['status', '--porcelain', '--', 'core', 'cmd', 'sdk', 'web', 'scripts', 'moon.mod'], { cwd: root }),
    ]);
    return { revision: revision.stdout.trim(), dirty: changes.stdout.length > 0 };
  } catch {
    return null;
  }
}

export async function buildIdentity(backend, artifactPath) {
  const generated = { js: 'core.mjs', 'wasm-gc': 'core.wasm' }[backend];
  const file = artifactPath ?? (generated && fileURLToPath(new URL(`./generated/${generated}`, import.meta.url)));
  const [source, artifact] = await Promise.all([
    sourceIdentity(),
    file ? fileSha256(file).then((sha256) => ({ name: basename(file), sha256 }), () => null) : null,
  ]);
  return { source, artifact };
}
