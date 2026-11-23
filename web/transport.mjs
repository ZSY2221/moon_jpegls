import { CodecError } from '../sdk/index.mjs';

// One encoder output may be offered at a time. Its acknowledgement waits until every byte is pulled.
export function createPipe() {
  let pending;
  let reader;
  let closed = false;
  let failure;
  const deliver = () => {
    if (!reader) return;
    const { resolve, reject, capacity } = reader;
    if (failure) {
      reader = undefined;
      reject(failure);
    } else if (pending) {
      const end = Math.min(pending.offset + capacity, pending.bytes.length);
      const bytes = pending.bytes.slice(pending.offset, end);
      pending.offset = end;
      reader = undefined;
      resolve(bytes);
      if (end === pending.bytes.length) {
        pending.resolve();
        pending = undefined;
      }
    } else if (closed) {
      reader = undefined;
      resolve(null);
    }
  };
  return {
    read: (capacity) => new Promise((resolve, reject) => {
      if (reader) { reject(new Error('A read is already pending')); return; }
      reader = { capacity, resolve, reject };
      deliver();
    }),
    write: (bytes) => new Promise((resolve, reject) => {
      if (failure || closed || pending) { reject(failure ?? new Error('Pipe cannot accept another chunk')); return; }
      pending = { bytes, offset: 0, resolve, reject };
      deliver();
    }),
    close() { closed = true; deliver(); },
    fail(error) {
      failure = error;
      pending?.reject(error);
      pending = undefined;
      deliver();
    },
  };
}

export function readBlob(file) {
  let offset = 0;
  return async (capacity) => {
    if (offset === file.size) return null;
    const end = Math.min(file.size, offset + capacity);
    const chunk = new Uint8Array(await file.slice(offset, end).arrayBuffer());
    offset = end;
    return chunk;
  };
}

export async function openSink(mode, name, type) {
  if (mode === 'file') {
    const handle = await globalThis.showSaveFilePicker({ suggestedName: name });
    const writer = await handle.createWritable();
    return {
      write: (bytes) => writer.write(bytes),
      close: () => writer.close(),
      abort: () => writer.abort(),
    };
  }
  if (mode === 'buffered') {
    const parts = [];
    const limit = 64 * 1024 * 1024;
    const pageSize = 64 * 1024;
    let size = 0;
    let page;
    let used = 0;
    return {
      write(bytes) {
        size += bytes.byteLength;
        if (size > limit) throw new CodecError('ResourceLimit', 'Buffered download exceeds 64 MiB. Use a file sink or bounded verification.');
        for (let offset = 0; offset < bytes.length;) {
          page ??= new Uint8Array(pageSize);
          const length = Math.min(bytes.length - offset, pageSize - used);
          page.set(bytes.subarray(offset, offset + length), used);
          offset += length;
          used += length;
          if (used === pageSize) {
            parts.push(page);
            page = undefined;
            used = 0;
          }
        }
      },
      close() {
        if (page) parts.push(page.subarray(0, used));
        const result = new Blob(parts, { type });
        parts.length = 0;
        page = undefined;
        return result;
      },
      abort() { parts.length = 0; page = undefined; },
    };
  }
  return { write() {}, close() {}, abort() {} };
}
