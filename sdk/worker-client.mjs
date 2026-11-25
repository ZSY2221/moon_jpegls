import { CodecError } from './index.mjs';

const wasmCache = new Map();
let canCloneWasmModule = true;

async function getWasmAsset() {
  const url = new URL('./generated/core.wasm', import.meta.url);
  if (url.protocol === 'file:' || typeof globalThis.fetch !== 'function' || typeof WebAssembly?.compile !== 'function') {
    return null;
  }
  const key = url.href;
  if (!wasmCache.has(key)) {
    const promise = (async () => {
      const response = await fetch(url);
      if (!response.ok) return null;
      const buffer = await response.arrayBuffer();
      try {
        const module = await WebAssembly.compile(buffer, { builtins: ['js-string'], importedStringConstants: '_' });
        return { module, buffer };
      } catch {
        return { module: null, buffer };
      }
    })().catch(() => {
      wasmCache.delete(key);
      return null;
    });
    wasmCache.set(key, promise);
  }
  return wasmCache.get(key);
}

export function startWorker(options) {
  const worker = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' });
  const { read, onEvent, onAck, signal, ...settings } = options;
  const Input = settings.mode === 'encode' ? Uint16Array : Uint8Array;
  let paused = false;
  let stopped = false;
  let releasePause;
  let complete;
  let fail;
  const result = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
  const stop = () => {
    stopped = true;
    releasePause?.();
    signal?.removeEventListener('abort', cancel);
    worker.terminate();
  };
  const cancel = () => {
    if (!stopped) worker.postMessage({ type: 'cancel' });
  };
  const reject = (error) => {
    if (stopped) return;
    stop();
    fail(error);
  };
  signal?.addEventListener('abort', cancel, { once: true });

  worker.onmessage = async ({ data }) => {
    if (stopped) return;
    try {
      switch (data.type) {
        case 'needInput': {
          while (paused && !stopped) {
            await new Promise((resume) => { releasePause = resume; });
          }
          if (stopped) return;
          let chunk = await read(data.maxElements);
          if (stopped) return;
          if (chunk !== null) {
            if (!(chunk instanceof Input) || chunk.length > data.maxElements) {
              throw new CodecError('InvalidArgument', `Worker requested at most ${data.maxElements} ${Input.name} elements`);
            }
            // Never transfer a small view backed by a larger input buffer. Slice also handles shared buffers.
            if (!(chunk.buffer instanceof ArrayBuffer) || chunk.byteOffset !== 0 || chunk.byteLength !== chunk.buffer.byteLength) {
              chunk = chunk.slice();
            }
          }
          worker.postMessage({ type: 'input', seq: data.seq, chunk }, chunk === null ? [] : [chunk.buffer]);
          break;
        }
        case 'progress':
        case 'bytes':
        case 'row':
        case 'rows': {
          const receivedAt = onAck ? performance.now() : 0;
          if (onEvent) await onEvent(data);
          if (!stopped) {
            worker.postMessage({ type: 'ack', seq: data.seq });
            onAck?.(data, performance.now() - receivedAt);
          }
          break;
        }
        case 'done':
          stop();
          complete(data);
          break;
        case 'error':
          reject(new CodecError(data.code, data.message));
          break;
        default:
          break;
      }
    } catch (error) {
      if (!stopped) reject(error);
    }
  };
  worker.onerror = (event) => reject(new Error(event.message || 'MoonJLS Worker failed to load'));
  worker.onmessageerror = () => reject(new Error('Could not read MoonJLS Worker message'));
  const startPayload = { ...settings, type: 'start' };
  const canPreload = settings.backend !== 'js'
    && typeof globalThis.fetch === 'function'
    && typeof WebAssembly?.compile === 'function'
    && new URL('./generated/core.wasm', import.meta.url).protocol !== 'file:';
  if (canPreload) {
    getWasmAsset().then((asset) => {
      if (stopped) return;
      if (asset?.module && canCloneWasmModule) {
        try {
          worker.postMessage({ ...startPayload, wasmModule: asset.module });
          if (signal?.aborted) cancel();
          return;
        } catch {
          canCloneWasmModule = false;
        }
      }
      if (asset?.buffer) {
        const copy = asset.buffer.slice(0);
        worker.postMessage({ ...startPayload, wasmBytes: copy }, [copy]);
      } else {
        worker.postMessage(startPayload);
      }
      if (signal?.aborted) cancel();
    });
  } else {
    worker.postMessage(startPayload);
  }
  if (signal?.aborted) cancel();

  return {
    result,
    pause() {
      if (stopped || paused) return;
      paused = true;
      worker.postMessage({ type: 'pause' });
    },
    resume() {
      if (stopped || !paused) return;
      paused = false;
      worker.postMessage({ type: 'resume' });
      releasePause?.();
      releasePause = undefined;
    },
    cancel,
  };
}
