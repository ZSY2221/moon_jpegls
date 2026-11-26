import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { promisify } from 'node:util';
import { buildIdentity, fileSha256 } from '../sdk/report-node.mjs';
import { codecMeasurements, createVerificationReport, serializeVerificationReport } from '../sdk/verification-report.mjs';

const exec = promisify(execFile);
const captureBytes = { encoding: 'buffer' };
const usage = 'Usage: node scripts/native_report.mjs [--wsl DISTRO] BINARY inspect|verify INPUT [CHUNK]';
const fileStat = (path) => stat(path, { bigint: true }).catch(() => null);
const sameFile = (before, after) => before?.isFile() && after?.isFile() &&
  ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every((key) => before[key] === after[key]);

function parse(args) {
  const wsl = args[0] === '--wsl';
  const distro = wsl ? args[1] : null;
  const [binary, operation, input, chunk, ...extra] = args.slice(wsl ? 2 : 0);
  if ((wsl && !distro) || !binary || !['inspect', 'verify'].includes(operation) || !input || input === '-' || extra.length) {
    throw new Error(usage);
  }
  return { binary: resolve(binary), operation, input: resolve(input), chunk, distro };
}

async function commandFor({ binary, operation, input, chunk, distro }) {
  const extra = chunk === undefined ? ['--json'] : [chunk, '--json'];
  if (!distro) return { executable: binary, args: [operation, input, ...extra] };
  const executable = 'wsl.exe';
  const prefix = ['--distribution', distro, '--exec'];
  const paths = await Promise.all([binary, input].map(async (file) => {
    const { stdout } = await exec(executable, [...prefix, 'wslpath', '-a', '-u', file], captureBytes);
    return decodeProcessText(stdout).trim();
  }));
  return { executable, args: [...prefix, paths[0], operation, paths[1], ...extra] };
}

function decodeProcessText(bytes) {
  if (!bytes) return '';
  // WSL can prefix UTF-8 subprocess stderr with UTF-16LE launcher messages.
  let offset = 0;
  while ((bytes[offset + 1] === 0 && bytes[offset + 3] === 0) ||
         (bytes[offset] === 255 && bytes[offset + 1] === 254)) {
    let end = offset;
    while (end + 1 < bytes.length && (bytes[end] !== 10 || bytes[end + 1] !== 0)) end += 2;
    offset = Math.min(end + 2, bytes.length);
  }
  return `${bytes.subarray(0, offset).toString('utf16le')}${bytes.subarray(offset).toString('utf8')}`.trimEnd();
}

function nativeError(error) {
  const stderr = decodeProcessText(error.stderr);
  const message = stderr || error.message;
  const category = /^(?:[\w./-]+\.)?(InvalidArgument|InvalidData|UnsupportedFeature|ResourceLimit|Truncated|Cancelled|Input|Usage)\b/m.exec(message)?.[1];
  const code = category === 'Input' && /trailing bytes after EOI/i.test(message) ? 'TrailingData' : category;
  return { code: code ?? (typeof error.code === 'string' ? error.code : 'NativeExit'), message };
}

function nativeMetrics(stdout) {
  const metrics = JSON.parse(stdout);
  const fields = ['width', 'height', 'bits', 'maxval', 'near', 'rows', 'inputBytes',
    'corePayloadBytes', 'inputPeakBytes', 'firstRowInputConsumed'];
  const components = metrics?.componentCount ?? 1;
  const geometry = metrics?.components;
  const validGeometry = Array.isArray(geometry) && geometry.length === components &&
    geometry.every((component) => Number.isSafeInteger(component?.width) &&
      component.width > 0 && component.width <= metrics.width &&
      Number.isSafeInteger(component.height) && component.height > 0 && component.height <= metrics.height);
  const rows = validGeometry ? geometry.reduce((sum, component) => sum + component.height, 0) : metrics?.height * components;
  const samples = validGeometry ? geometry.reduce((sum, component) => sum + component.width * component.height, 0) : metrics?.width * rows;
  if (!metrics || !fields.every((key) => Number.isSafeInteger(metrics[key]) && metrics[key] >= 0) ||
      metrics.bits < 2 || metrics.bits > 16 || metrics.width < 1 || metrics.height < 1 ||
      !Number.isSafeInteger(components) || components < 1 || components > 255 ||
      (geometry !== undefined && !validGeometry) || metrics.rows !== rows ||
      (metrics.samples !== undefined && metrics.samples !== samples) ||
      metrics.maxval < 1 || metrics.maxval > 2 ** metrics.bits - 1 ||
      metrics.near > Math.min(255, Math.floor(metrics.maxval / 2)) ||
      metrics.firstRowInputConsumed > metrics.inputBytes) {
    throw new Error('Native command returned invalid verification metrics');
  }
  const preset = metrics.preset;
  if (preset && (preset.maxval !== metrics.maxval ||
      !['t1', 't2', 't3', 'reset'].every((key) => Number.isSafeInteger(preset[key])) ||
      preset.t1 <= metrics.near || preset.t1 > preset.t2 || preset.t2 > preset.t3 ||
      preset.t3 > metrics.maxval || preset.reset < 3 || preset.reset > Math.max(255, metrics.maxval))) {
    throw new Error('Native command returned invalid coding parameters');
  }
  return metrics;
}

async function main(args) {
  if (args.length === 0 || args[0] === '--help') {
    process.stdout.write(`${usage}\n`);
    return;
  }
  const options = parse(args);
  const [binaryBefore, inputBefore] = await Promise.all([fileStat(options.binary), fileStat(options.input)]);
  const [{ source, artifact }, inputDigest] = await Promise.all([
    buildIdentity('native', binaryBefore?.isFile() ? options.binary : undefined),
    inputBefore?.isFile() ? fileSha256(options.input).catch(() => null) : null,
  ]);

  let metrics;
  let error;
  let elapsedMs = null;
  let exitCode = 0;
  let stage = 'not_run';
  try {
    const command = await commandFor(options);
    stage = 'failed';
    const started = performance.now();
    let stdout;
    try {
      ({ stdout } = await exec(command.executable, command.args, captureBytes));
    } finally {
      elapsedMs = performance.now() - started;
    }
    try {
      metrics = nativeMetrics(stdout.toString('utf8'));
      stage = 'passed';
    } catch (problem) {
      error = { code: 'InvalidNativeReport', message: problem.message };
      exitCode = 1;
    }
  } catch (problem) {
    if (problem.code === 'ENOENT' && !options.distro) stage = 'not_run';
    error = nativeError(problem);
    exitCode = Number.isInteger(problem.code) && problem.code > 0 ? problem.code : 1;
  }

  const [binaryAfter, inputAfter] = await Promise.all([fileStat(options.binary), fileStat(options.input)]);
  const inputUnchanged = sameFile(inputBefore, inputAfter);
  const binaryUnchanged = sameFile(binaryBefore, binaryAfter);
  if (metrics && (!binaryUnchanged || !artifact || !inputUnchanged || !inputDigest || BigInt(metrics.inputBytes) !== inputAfter?.size)) {
    error = { code: 'FingerprintUnavailable', message: 'The inspected input or executable could not be bound to a stable file fingerprint' };
    exitCode = 1;
  }

  const chunk = options.chunk === undefined ? 65536 : /^\+?\d+$/.test(options.chunk) ? Number(options.chunk) : null;
  const report = createVerificationReport({
    host: 'native-cli', backend: 'native', status: error ? 'failed' : 'passed', error,
    source, artifact: binaryUnchanged ? artifact : null,
    input: {
      name: basename(options.input), format: 'jls',
      bytes: metrics?.inputBytes ?? (inputUnchanged && inputAfter.size <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(inputAfter.size) : null),
      sha256: inputUnchanged ? inputDigest : null,
    },
    frame: metrics, preset: metrics?.preset,
    stages: { decode: stage },
    timing: { elapsedMs, boundary: 'Native child process launch through exit, including WSL launcher when used; excludes path conversion and hashing' },
    memory: { decode: codecMeasurements(metrics && {
      coreWorkspaceBytes: metrics.corePayloadBytes, inputPeakBytes: metrics.inputPeakBytes,
    }, 'native-cli') },
    stream: {
      rowsDecoded: metrics?.rows ?? null, rowsDelivered: 0, provisionalRows: 0,
      firstRowInputConsumed: metrics?.firstRowInputConsumed ?? null,
      trailingPolicy: 'reject', strictEoi: stage === 'not_run' ? null : stage === 'passed',
    },
    limits: {
      maxWidth: 65535, maxHeight: 65535, maxPixels: 100000000, maxMetadataBytes: 1048576,
      inputChunkSize: Number.isInteger(chunk) && chunk >= 1 && chunk <= 1048576 ? chunk : null,
    },
  });
  process.stdout.write(serializeVerificationReport(report));
  process.exitCode = exitCode;
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
