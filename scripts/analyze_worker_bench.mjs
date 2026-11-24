import { readFile } from 'node:fs/promises';

if (process.argv.length !== 3 || process.argv[2] === '--help') {
  console.log('Usage: node scripts/analyze_worker_bench.mjs <paired-browser-report.json>');
  process.exit(process.argv[2] === '--help' ? 0 : 1);
}
const evidence = JSON.parse(await readFile(process.argv[2], 'utf8'));

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const configs = ['js', 'wasm-gc'].flatMap((backend) => [0, 3].flatMap((near) => [4096, 1].map((chunk) => ({ backend, near, chunk }))));
const incomplete = [];
const results = [];
for (const config of configs) {
  const group = evidence.trials.filter((trial) => Object.entries(config).every(([key, value]) => trial[key] === value));
  const select = (variant, phase) => group.filter((item) => item.variant === variant && item.phase === phase).sort((a, b) => a.index - b.index);
  const baseline = select('baseline', 'formal');
  const candidate = select('candidate', 'formal');
  if (baseline.length !== 5 || candidate.length !== 5
    || select('baseline', 'warmup').length !== 2 || select('candidate', 'warmup').length !== 2) {
    incomplete.push({ ...config, baselineSamples: baseline.length, candidateSamples: candidate.length });
    continue;
  }
  const beforeMs = median(baseline.map((row) => row.wallMs));
  const afterMs = median(candidate.map((row) => row.wallMs));
  const regressions = candidate.map((row, i) => 100 * (row.wallMs / baseline[i].wallMs - 1));
  const slowdownPercent = 100 * (afterMs / beforeMs - 1);
  const beforeFirstRowMs = median(baseline.map((row) => row.firstRowWallMs));
  const afterFirstRowMs = median(candidate.map((row) => row.firstRowWallMs));
  const headAllowanceMs = Math.max(beforeFirstRowMs * 0.10, 2);
  const requiredFields = ['coreWorkspaceBytes', 'bridgeBufferPeakBytes', 'inputPeakBytes', 'outputPeakBytes', 'inputQueueBytes', 'outputQueueBytes'];
  const trialContract = candidate.every((row, index) => {
    const reference = baseline[index];
    return row.firstRowBytes === reference.firstRowBytes && row.checksum === reference.checksum
      && row.rows === 4096 && row.rows === reference.rows && row.messages.peakPending === 1
      && row.messages.sent.rowAck === 4096 && row.messages.received.row === 4096
      && row.messages.sent.progressAck < reference.messages.sent.progressAck
      && row.source.reads === reference.source.reads
      && requiredFields.every((field) => row.stats[field] === reference.stats[field]);
  });
  const gatePrimary = config.backend === 'wasm-gc' && config.near === 0 && config.chunk === 4096;
  results.push({
    ...config, beforeMs, afterMs, slowdownPercent, pairedSlowdownPercent: regressions,
    beforeMadMs: median(baseline.map((row) => Math.abs(row.wallMs - beforeMs))),
    afterMadMs: median(candidate.map((row) => Math.abs(row.wallMs - afterMs))),
    beforeFirstRowMs, afterFirstRowMs, headAllowanceMs,
    primary: gatePrimary, timingPass: gatePrimary ? slowdownPercent <= -10 : slowdownPercent <= 5,
    stableRegression: !gatePrimary && slowdownPercent > 5 && regressions.filter((change) => change > 5).length >= 4,
    firstRowPass: afterFirstRowMs <= beforeFirstRowMs + headAllowanceMs,
    trialContract,
  });
}

const decision = incomplete.length ? 'incomplete'
  : results.every((item) => item.timingPass && item.firstRowPass && item.trialContract) ? 'timing-and-per-trial-contract-pass' : 'do-not-retain-on-this-evidence';
console.log(JSON.stringify({
  decision, results, incomplete,
  rules: 'Other-configuration slowdowns over 5% are considered stable if at least four paired samples also exceed 5%. Uncertain results over the median threshold do not clear the conservative retention gate. First-row threshold is max(10%, 2 ms). Held ACK, cancellation, browser smoke, full interoperability and bounded-memory gates must be verified separately.',
}, null, 2));
