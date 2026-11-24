"""Verify local Moon and SDK archives from unrelated, extracted consumer directories."""

import argparse
from datetime import datetime, timedelta, timezone
from hashlib import file_digest, sha256
import json
from pathlib import Path
import shlex
import shutil
import struct
import subprocess
import tempfile
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parents[2]
SDK_FILES = ('index.mjs', 'index.d.mts', 'worker-client.mjs', 'worker-client.d.mts', 'worker.mjs', 'cli.mjs', 'README.md')
GENERATED = ('core.mjs', 'core.wasm')
MOON_MAIN = r'''fn main {
  let cases : Array[(Int32, FixedArray[Int32])] = [
    (8, [0, 1, 127, 128, 254, 255]),
    (12, [0, 255, 256, 2048, 4094, 4095]),
    (16, [0, 255, 256, 32768, 65534, 65535]),
  ]
  for entry in cases {
    let (bits, original) = entry
    for near in [0, 3] {
      let frame : @jls.Frame = { width: 3, height: 2, bits, near }
      let coded = @jls.encode(frame, original)
      let (reconstructed_frame, pixels) = @jls.decode(coded)
      assert_eq(reconstructed_frame, frame)
      assert_eq(frame.maxval(), (1 << bits) - 1)
      assert_eq(pixels.length(), original.length())
      let mut maximum = 0
      for offset in 0..<pixels.length() {
        let delta = (pixels[offset] - original[offset]).abs()
        assert_true(delta <= near)
        if delta > maximum { maximum = delta }
      }
      let decoder = @jls.Decoder::new(@jls.Limits::default())
      let first = decoder.step(coded, 0, coded.length(), false)
      assert_true(first.status is RowReady)
      assert_eq(decoder.row().length(), frame.width)
      assert_true(decoder.workspace_bytes() > 0)
      let encoder = @jls.Encoder::new(frame, @jls.Limits::default())
      let block = FixedArray::make(4, b'\x00')
      assert_true(encoder.step(original, 0, original.length(), block, false).produced > 0)
      println("package-case bits=\{bits} near=\{near} maxError=\{maximum}")
    }
  }
}
'''
SDK_MAIN = r'''import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { CodecError, loadCore, encodeImage, decodeImage, encodeStream, decodeStream } from './sdk/index.mjs';
import { startWorker } from './sdk/worker-client.mjs';

assert.equal(typeof startWorker, 'function');
assert.equal(typeof encodeStream, 'function');
assert.equal(typeof decodeStream, 'function');
const fixtures = JSON.parse(await readFile('fixtures.json', 'utf8'));
const trials = [];
for (const backend of ['js', 'wasm-gc']) {
  const core = await loadCore({ backend });
  for (const { id, frame, original, expected } of fixtures) {
    const fromReference = await readFile(`fixtures/${id}.charls.jls`);
    const decoded = await decodeImage(core, fromReference, { inputChunkSize: 1 });
    assert.deepEqual(decoded.frame, frame);
    assert.ok(decoded.samples instanceof Uint16Array);
    assert.deepEqual([...decoded.samples], expected);
    const encoded = await encodeImage(core, frame, Uint16Array.from(original), { inputChunkSize: 1, outputChunkSize: 3 });
    assert.ok(encoded.bytes instanceof Uint8Array);
    const rebuilt = await decodeImage(core, encoded.bytes, { inputChunkSize: 1 });
    const maxError = Math.max(...rebuilt.samples.map((value, i) => Math.abs(value - original[i])));
    assert.ok(maxError <= frame.near);
    await writeFile(`fixtures/${id}.${backend}.jls`, encoded.bytes);
    const littleEndian = Buffer.alloc(rebuilt.samples.length * 2);
    for (let i = 0; i < rebuilt.samples.length; i++) littleEndian.writeUInt16LE(rebuilt.samples[i], i * 2);
    await writeFile(`fixtures/${id}.${backend}.raw`, littleEndian);
    trials.push({ id, backend, maxError, oracleDecodedExactly: true });
  }
  const malformed = Uint8Array.from([0xff, 0xd8, 0xff]);
  await assert.rejects(decodeImage(core, malformed), (error) => error instanceof CodecError && error.code === 'Truncated');
}
console.log(JSON.stringify({ trials, workerExportPresent: true, typedTruncated: true }));
'''
TYPES = '''import { loadCore, encodeImage, type Frame } from './sdk/index.mjs';
import { startWorker, type WorkerJob } from './sdk/worker-client.mjs';

const frame: Frame = { width: 1, height: 1, bits: 16, near: 0 };
await encodeImage(await loadCore({ backend: 'js' }), frame, Uint16Array.of(65535));
export const run = (): WorkerJob => startWorker({ mode: 'decode', read: () => null });
'''


def digest(path):
    with path.open('rb') as stream:
        return file_digest(stream, 'sha256').hexdigest()


def save(path, data):
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n', encoding='utf-8', newline='\n')


def int_samples(path):
    data = path.read_bytes()
    return list(struct.unpack('<' + 'H' * (len(data) // 2), data))


def verify(args, evidence, directory):
    def run(step, command, cwd=directory):
        result = subprocess.run(command, cwd=cwd, capture_output=True, timeout=90)
        log = {'step': step, 'cwd': str(cwd), 'command': [str(item) for item in command], 'exitCode': result.returncode,
               'stdout': result.stdout.decode('utf-8', errors='replace').replace('\0', '').strip(),
               'stderr': result.stderr.decode('utf-8', errors='replace').replace('\0', '').strip()}
        evidence['commands'].append(log)
        if result.returncode:
            raise RuntimeError(f'{step}: {log["stdout"]}\n{log["stderr"]}')
        return result.stdout

    commit = run('resolve-source', ['git', '-C', ROOT, 'rev-parse', args.commit + '^{commit}']).decode().strip()
    evidence['sourceCommit'] = commit
    source_zip = directory / 'exported-source.zip'
    run('export-git-snapshot', ['git', '-C', ROOT, 'archive', '--format=zip', f'--output={source_zip}', commit])
    source = directory / 'source'
    with ZipFile(source_zip) as archive:
        archive.extractall(source)
    run('moon-package', ['moon', 'package', '--frozen'], source)
    packages = list((source / '_build' / 'publish').glob('*.zip'))
    assert len(packages) == 1, packages
    moon_archive = directory / packages[0].name
    shutil.copyfile(packages[0], moon_archive)
    unpacked = directory / 'moon-package'
    with ZipFile(moon_archive) as archive:
        archive.extractall(unpacked)
        files = archive.namelist()
    assert (unpacked / 'core' / 'moon.pkg').is_file()
    assert digest(unpacked / 'moon.mod') == digest(source / 'moon.mod')
    assert all(not name.startswith(('.git/', '.tools/')) for name in files)
    evidence['moonArchive'] = {'file': moon_archive.name, 'sha256': digest(moon_archive), 'bytes': moon_archive.stat().st_size, 'entries': len(files)}

    moon_consumer = directory / 'moon-consumer'
    moon_consumer.mkdir()
    (moon_consumer / 'moon.work').write_text('members = [".", "../moon-package"]\n', encoding='utf-8')
    (moon_consumer / 'moon.mod').write_text(
        'name = "rc3/package_consumer"\nversion = "0.1.0"\nimport { "ZSY2221/moon_jpegls@0.1.0" }\n', encoding='utf-8')
    (moon_consumer / 'moon.pkg').write_text('import { "ZSY2221/moon_jpegls/core" @jls }\npkgtype(kind: "executable")\n', encoding='utf-8')
    (moon_consumer / 'main.mbt').write_text(MOON_MAIN, encoding='utf-8')

    build = json.loads(args.build.read_bytes())
    for name in SDK_FILES:
        author_hash = build['source']['participatingFiles'][f'sdk/{name}']
        assert digest(source / 'sdk' / name) == author_hash, name
    sdk_archive = directory / 'MoonJLS-SDK-consumption-check.zip'
    with ZipFile(sdk_archive, 'w', compression=ZIP_DEFLATED) as archive:
        for name in SDK_FILES:
            archive.write(source / 'sdk' / name, 'sdk/' + name)
        for name in GENERATED:
            path = ROOT / 'sdk' / 'generated' / name
            assert digest(path) == build['artifacts'][f'sdk/generated/{name}'], name
            archive.write(path, 'sdk/generated/' + name)
    sdk_consumer = directory / 'sdk-consumer'
    with ZipFile(sdk_archive) as archive:
        archive.extractall(sdk_consumer)
        evidence['sdkArchive'] = {'file': sdk_archive.name, 'sha256': digest(sdk_archive), 'bytes': sdk_archive.stat().st_size,
                                  'files': archive.namelist(), 'generatedFromBuildSource': build['source']['commit']}
    # The extracted archive is the only Moon workspace member for this dependency.
    # Removing source resolution from this step is enforced by its relative workspace declaration.
    evidence['moonWorkspaceMembers'] = ['moon-consumer', 'moon-package']
    for target in ('js', 'wasm-gc', 'native'):
        command = ['moon', 'run', '--release', '--frozen', '--target', target, '.']
        if target == 'native' and args.native_wsl:
            command = ['wsl', '-d', args.native_wsl, '--exec', 'bash', '-lc',
                       shlex.join(['env', 'CC=clang', '/root/.moon/bin/moon', *command[1:]])]
        result = run(f'moon-consumer-{target}', command, moon_consumer)
        assert result.count(b'package-case') == 6, result

    fixtures = sdk_consumer / 'fixtures'
    fixtures.mkdir()
    sample_sets = {8: [0, 1, 127, 128, 254, 255], 12: [0, 255, 256, 2048, 4094, 4095],
                   16: [0, 255, 256, 32768, 65534, 65535]}
    recorded = []
    for bits, samples in sample_sets.items():
        for near in (0, 3):
            id = f'b{bits}-n{near}'
            original = fixtures / f'{id}.raw'
            original.write_bytes(struct.pack('<6H', *samples))
            coded = fixtures / f'{id}.charls.jls'
            reference = fixtures / f'{id}.reference.raw'
            run(f'prepare-{id}-charls-encode', ['node', ROOT / 'scripts/oracle.mjs', 'encode', original, coded,
                                               '3', '2', str(bits), str(near), '4'])
            run(f'prepare-{id}-charls-decode', [args.oracle_python, ROOT / 'scripts/oracle.py', 'decode', coded, reference])
            recorded.append({'id': id, 'frame': {'width': 3, 'height': 2, 'bits': bits, 'near': near}, 'original': samples,
                             'expected': int_samples(reference), 'sourceSha256': digest(original),
                             'charlsEncodedSha256': digest(coded), 'charlsReconstructedSha256': digest(reference)})
    evidence['fixtures'] = recorded
    save(sdk_consumer / 'fixtures.json', recorded)
    (sdk_consumer / 'consumer.mjs').write_text(SDK_MAIN, encoding='utf-8')
    evidence['sdkResult'] = json.loads(run('node-extracted-sdk', ['node', 'consumer.mjs'], sdk_consumer))
    for trial in evidence['sdkResult']['trials']:
        stem = f"{trial['id']}.{trial['backend']}"
        independently_decoded = fixtures / (stem + '.charls-check.raw')
        run(f'check-sdk-{stem}-charls-decode', [args.oracle_python, ROOT / 'scripts/oracle.py', 'decode',
                                              fixtures / (stem + '.jls'), independently_decoded])
        assert independently_decoded.read_bytes() == (fixtures / (stem + '.raw')).read_bytes(), stem
        trial['charlsMatchedSdkBitstream'] = True
    if args.tsc:
        (sdk_consumer / 'types.mts').write_text(TYPES, encoding='utf-8')
        run('typecheck-extracted-sdk-declarations', ['node', args.tsc, '--noEmit', '--strict', '--module', 'node16',
                                                     '--target', 'es2022', 'types.mts'], sdk_consumer)
    else:
        evidence['typecheck'] = 'Not run; declaration files were present in the extracted archive.'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--commit', required=True, help='Commit supplying the package source and exact SDK wrapper bytes')
    parser.add_argument('--build', type=Path, default=ROOT / 'reports/rc2/build.json', help='Manifest for existing SDK generated assets')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--oracle-python', type=Path, required=True, help='Environment containing the pinned imagecodecs wheel')
    parser.add_argument('--native-wsl', help='Author Linux distribution with Moon and clang')
    parser.add_argument('--tsc', type=Path, help='Optional path to an already installed typescript/bin/tsc')
    args = parser.parse_args()
    args.oracle_python = args.oracle_python.resolve(strict=True)
    args.build = args.build.resolve(strict=True)
    if args.tsc:
        args.tsc = args.tsc.resolve(strict=True)
    directory = Path(tempfile.mkdtemp(prefix='moonjls-rc3-package-')).resolve()
    assert ROOT != directory and ROOT not in directory.parents
    evidence = {'recordedAtSingapore': datetime.now(timezone(timedelta(hours=8))).isoformat(), 'tempDirectory': str(directory),
                'scope': 'Author local consumption checks using extracted Moon and SDK archives in an external directory',
                'commands': []}
    try:
        verify(args, evidence, directory)
        evidence['verdict'] = 'passed'
    except Exception as error:
        evidence['verdict'] = 'failed'
        evidence['error'] = str(error)
        raise
    finally:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        save(args.output, evidence)
    print(f'Wrote {args.output} from {directory}')


if __name__ == '__main__':
    main()
