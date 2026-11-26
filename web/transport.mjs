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
      writeAt: (bytes, position) => writer.write({ type: 'write', position, data: bytes }),
      close: () => writer.close(),
      abort: () => writer.abort(),
    };
  }
  if (mode === 'buffered') {
    const parts = [];
    const limit = 64 * 1024 * 1024;
    const pageSize = 64 * 1024;
    let size = 0;
    const writeAt = (bytes, position) => {
      const end = position + bytes.byteLength;
      if (end > limit) throw new CodecError('ResourceLimit', 'Buffered download exceeds 64 MiB. Use a file sink or bounded verification.');
      size = Math.max(size, end);
      for (let offset = 0; offset < bytes.length;) {
        const pageIndex = Math.floor(position / pageSize);
        const withinPage = position % pageSize;
        const page = parts[pageIndex] ??= new Uint8Array(pageSize);
        const length = Math.min(bytes.length - offset, pageSize - withinPage);
        page.set(bytes.subarray(offset, offset + length), withinPage);
        offset += length;
        position += length;
      }
    };
    return {
      write: (bytes) => writeAt(bytes, size),
      writeAt,
      close(mimeType = type) {
        const tail = size % pageSize;
        if (tail) parts[parts.length - 1] = parts.at(-1).subarray(0, tail);
        const result = new Blob(parts, { type: mimeType });
        parts.length = 0;
        return result;
      },
      abort() { parts.length = 0; },
    };
  }
  return { write() {}, writeAt() {}, close() {}, abort() {} };
}
