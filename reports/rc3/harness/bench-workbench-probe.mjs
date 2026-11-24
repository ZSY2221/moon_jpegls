// Benchmark-only code. The application sources on disk stay unchanged.
function replaceOnce(source, needle, replacement) {
  const index = source.indexOf(needle);
  if (index < 0 || source.indexOf(needle, index + needle.length) >= 0) {
    throw new Error(`Workbench probe anchor missing or ambiguous: ${needle}`);
  }
  return source.slice(0, index) + replacement + source.slice(index + needle.length);
}

export function instrumentApp(text, diagnostic) {
  let source = text.replaceAll('\r\n', '\n');
  const replace = (from, to) => { source = replaceOnce(source, from, to); };
  replace('  active = job;', '  active = job;\n  globalThis.__workbenchBench.start(job);');
  replace('    sink = await openSink(', '    const sinkOpenStart = performance.now();\n    sink = await openSink(');
  replace('    const started = performance.now();', '    const started = performance.now();\n    globalThis.__workbenchBench.mark(job, "sinkOpenMs", started - sinkOpenStart);');
  replace('    const artifact = await sink.close();', '    const sinkCloseStart = performance.now();\n    const artifact = await sink.close();\n    globalThis.__workbenchBench.mark(job, "sinkCloseMs", performance.now() - sinkCloseStart);');
  replace('\n  }\n}\n\nget(\'file\')', '\n    globalThis.__workbenchBench.finish(job);\n  }\n}\n\nget(\'file\')');
  if (diagnostic) {
    replace('  const input = await openPgm(file, near',
      '  const probe = globalThis.__workbenchBench.profile(job);\n  const input = await openPgm(probe.file(file), near');
    replace('      const original = await input.row(index);', '      const original = await probe.read("reference", () => input.row(index));');
    replace('      for (let i = 0; i < row.length; i++) maxError =',
      '      const compareStart = performance.now();\n      for (let i = 0; i < row.length; i++) maxError =');
    replace('      if (maxError > near)', '      probe.time("comparison", compareStart);\n      if (maxError > near)');
    replace('      preview.drawRow(index, row, original);',
      '      const previewStart = performance.now();\n      preview.drawRow(index, row, original);\n      probe.time("preview", previewStart);');
    replace('frame: input.frame, read: input.read,', 'frame: input.frame, read: capacity => probe.read("source", () => input.read(capacity)),');
    replace('        await sink.write(event.chunk);',
      '        const sinkStart = performance.now();\n        await sink.write(event.chunk);\n        probe.time("sinkWrite", sinkStart);');
    replace('        await pipe.write(event.chunk);',
      '        const pipeStart = performance.now();\n        await pipe.write(event.chunk);\n        probe.time("pipeWrite", pipeStart);');
    replace('  if (active !== job || job.abort.signal.aborted) throw',
      '  if (active !== job || job.abort.signal.aborted) globalThis.__workbenchBench.rejected(job, active);\n  if (active !== job || job.abort.signal.aborted) throw');
  }
  return source;
}

export function instrumentPgm(text) {
  let source = text.replaceAll('\r\n', '\n');
  const range = '  const readRange = async (start, size) => {';
  source = replaceOnce(source, range, `${range}\n    const currentRead = globalThis.__workbenchBench.captureRead();`);
  source = replaceOnce(source, '    const output = new Uint16Array(size);',
    '    const conversionStart = performance.now();\n    const output = new Uint16Array(size);');
  source = replaceOnce(source, '    return output;',
    '    currentRead?.materialize(performance.now() - conversionStart, output.byteLength, bytes.byteLength);\n    return output;');

  if (!source.includes('    async row(index) {')) return source;
  source = replaceOnce(source, '    async row(index) {',
    '    async row(index) {\n      const referenceRead = globalThis.__workbenchBench.captureRead();');
  const load = '            referenceWindow = { firstRow: index, count, bytes: new Uint8Array(buffer) };';
  source = replaceOnce(source, load, `${load}\n            referenceRead?.window(referenceWindow.bytes.byteLength);`);
  source = replaceOnce(source, '      const pixels = new Uint16Array(width);',
    '      const conversionStart = performance.now();\n      const pixels = new Uint16Array(width);');
  return replaceOnce(source, '      return pixels;\n    },\n    closeReference()',
    '      referenceRead?.materialize(performance.now() - conversionStart, pixels.byteLength, bytes.byteLength);\n      return pixels;\n    },\n    closeReference()');
}

// This function is serialized by Playwright and runs before the real UI modules.
export function installWorkbenchObserver({ diagnostic }) {
  if (!/^\/(baseline|candidate)\/web\//.test(location.pathname)) return;
  const now = () => performance.now();
  const jobs = new WeakMap();
  let run;
  let currentRead;
  let clickedAt;
  let jobCount = 0;
  const totals = () => ({ calls: 0, ms: 0 });
  const reads = () => ({ requests: 0, requestMs: 0, blobReads: 0, blobBytes: 0, peakBlobBytes: 0, arrayBufferMs: 0,
    materializeCalls: 0, materializeMs: 0, peakMaterializedBytes: 0, peakRawAndMaterializedBytes: 0 });

  document.addEventListener('click', (event) => {
    if (event.target.closest?.('#run')) clickedAt = now();
  }, true);

  function start(job) {
    const startedAt = now();
    let complete;
    const completion = new Promise((resolve) => { complete = resolve; });
    run = { id: ++jobCount, startedAt, clickedAt: clickedAt ?? startedAt, marks: {}, workers: [], complete, completion,
      ...(diagnostic && { diagnostic: {
        header: reads(), source: reads(), reference: reads(), comparison: totals(), preview: totals(),
        sinkWrite: totals(), pipeWrite: totals(), rejectedJobContinuations: 0, staleWorkerMessages: 0,
        referenceCachePeakBytes: 0, referenceWindowLoads: 0,
      } }),
    };
    jobs.set(job, run);
  }

  function finish(job) {
    const owner = jobs.get(job);
    if (!owner || owner.finishedAt !== undefined) return;
    owner.finishedAt = now();
    const value = (id) => document.getElementById(id).textContent;
    owner.complete({
      jobId: owner.id, timeOriginMs: performance.timeOrigin, clickAtMs: owner.clickedAt,
      startedAtMs: owner.startedAt, finishedAtMs: owner.finishedAt, wallMs: owner.finishedAt - owner.clickedAt,
      firstRowArrivalMs: owner.firstRowAt === undefined ? null : owner.firstRowAt - owner.clickedAt,
      firstDisplayMs: owner.firstDisplayAt === undefined ? null : owner.firstDisplayAt - owner.clickedAt,
      ...owner.marks,
      workers: owner.workers,
      ...(diagnostic && { diagnostic: owner.diagnostic }),
      status: value('status'), frame: value('frame'), encoded: value('encoded'), maxError: value('error'),
      appLatency: value('latency'), workspace: value('workspace'), queues: value('queues'),
      progress: document.getElementById('progress').value,
      downloadVisible: !document.getElementById('download').hidden,
    });
  }

  function profile(job) {
    const owner = jobs.get(job);
    const stats = owner.diagnostic;
    async function read(kind, callback) {
      const begin = now();
      const previous = currentRead;
      currentRead = stats[kind];
      stats[kind].requests++;
      let pending;
      try { pending = callback(); } finally { currentRead = previous; }
      try { return await pending; } finally { stats[kind].requestMs += now() - begin; }
    }
    return {
      read,
      time(kind, start) { stats[kind].calls++; stats[kind].ms += now() - start; },
      file(file) {
        const header = stats.header;
        return {
          name: file.name, size: file.size,
          slice(...args) {
            const blob = file.slice(...args);
            const scope = currentRead ?? header;
            return {
              async arrayBuffer() {
                const start = now();
                if (scope === header) header.requests++;
                scope.blobReads++;
                scope.blobBytes += blob.size;
                scope.peakBlobBytes = Math.max(scope.peakBlobBytes, blob.size);
                try { return await blob.arrayBuffer(); } finally { scope.arrayBufferMs += now() - start; }
              },
            };
          },
        };
      },
    };
  }

  globalThis.__workbenchBench = {
    start, finish, profile,
    wait() { return run?.completion; },
    mark(job, key, value) { jobs.get(job).marks[key] = value; },
    rejected(job) { const owner = jobs.get(job); if (owner) owner.diagnostic.rejectedJobContinuations++; },
    captureRead() {
      const stats = currentRead;
      if (!stats) return null;
      const owner = run;
      return {
        materialize(ms, pixelsBytes, rawBytes) {
          stats.materializeCalls++;
          stats.materializeMs += ms;
          stats.peakMaterializedBytes = Math.max(stats.peakMaterializedBytes, pixelsBytes);
          stats.peakRawAndMaterializedBytes = Math.max(stats.peakRawAndMaterializedBytes, pixelsBytes + rawBytes);
        },
        window(bytes) {
          owner.diagnostic.referenceWindowLoads++;
          owner.diagnostic.referenceCachePeakBytes = Math.max(owner.diagnostic.referenceCachePeakBytes, bytes);
        },
      };
    },
  };

  const putImageData = CanvasRenderingContext2D.prototype.putImageData;
  CanvasRenderingContext2D.prototype.putImageData = function (...args) {
    const result = Reflect.apply(putImageData, this, args);
    if (run && run.firstDisplayAt === undefined && this.canvas.id === 'reconstruction') run.firstDisplayAt = now();
    return result;
  };

  const WorkerBase = globalThis.Worker;
  globalThis.Worker = class extends WorkerBase {
    constructor(...args) {
      super(...args);
      const owner = run;
      if (!owner) return;
      const info = { createdMs: now() - owner.clickedAt };
      owner.workers.push(info);
      this.workbenchOwner = owner;
      this.workbenchInfo = info;
      if (diagnostic) info.protocol = { requests: 0, replies: 0, peakPending: 0, pending: 0, violations: 0 };
      this.addEventListener('message', ({ data }) => {
        if (diagnostic) {
          if (owner !== run || owner.finishedAt !== undefined) owner.diagnostic.staleWorkerMessages++;
          const protocol = info.protocol;
          if (['needInput', 'row', 'bytes', 'progress'].includes(data.type)) {
            protocol.requests++;
            protocol.pending++;
            protocol.peakPending = Math.max(protocol.peakPending, protocol.pending);
            if (protocol.pending !== 1) protocol.violations++;
            info.pendingSequence = data.seq;
          }
        }
        if (owner.firstRowAt === undefined && data.type === 'row') owner.firstRowAt = now();
        if (data.type === 'done') {
          info.loadMs = data.loadMs;
          info.doneMs = now() - owner.clickedAt;
          info.stats = data.stats;
        } else if (data.type === 'error') {
          info.error = { code: data.code, message: data.message };
        }
      });
    }

    postMessage(message, ...rest) {
      const info = this.workbenchInfo;
      if (info) {
        if (message.type === 'start') info.mode = message.mode;
        if (diagnostic && (message.type === 'input' || message.type === 'ack')) {
          const protocol = info.protocol;
          if (protocol.pending !== 1 || info.pendingSequence !== message.seq) protocol.violations++;
          protocol.replies++;
          protocol.pending--;
          delete info.pendingSequence;
        }
      }
      return super.postMessage(message, ...rest);
    }
  };
}
