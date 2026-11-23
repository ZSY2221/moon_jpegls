import { CodecError } from './index.mjs';

export function startWorker(options) {
  const worker = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' });
  const { read, onEvent, signal, ...settings } = options;
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
  const reject = (error) => { stop(); fail(error); };
  signal?.addEventListener('abort', cancel, { once: true });

  worker.onmessage = async ({ data }) => {
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
          if (onEvent) await onEvent(data);
          if (!stopped) worker.postMessage({ type: 'ack', seq: data.seq });
          break;
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
  worker.postMessage({ ...settings, type: 'start' });
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
