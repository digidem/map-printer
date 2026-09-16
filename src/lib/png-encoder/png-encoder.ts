export type PngFilter = "none" | "sub";

export interface PngEncoderOptions {
  width: number;
  height: number;
  channels: 3 | 4;
  filter?: PngFilter;
}

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const IDAT_TARGET_BYTES = 64 * 1024;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, parts: readonly Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(12 + length);
  const view = new DataView(out.buffer);
  view.setUint32(0, length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let offset = 8;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  view.setUint32(offset, crc32(out.subarray(4, offset)));
  return out;
}

function headerBytes(width: number, height: number, channels: 3 | 4): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  const chunk = pngChunk("IHDR", [ihdr], ihdr.length);
  const out = new Uint8Array(SIGNATURE.length + chunk.length);
  out.set(SIGNATURE, 0);
  out.set(chunk, SIGNATURE.length);
  return out;
}

function validate(width: number, height: number, channels: number): Error | undefined {
  for (const [name, value] of [
    ["width", width],
    ["height", height],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0 || value > 0x7fffffff) {
      return new RangeError(`png-encoder: ${name} must be a positive integer, got ${value}`);
    }
  }
  if (channels !== 3 && channels !== 4) {
    return new RangeError(`png-encoder: channels must be 3 or 4, got ${channels}`);
  }
  return undefined;
}

export function createPngEncoder(
  options: PngEncoderOptions,
): TransformStream<Uint8Array, Uint8Array> {
  const { width, height, channels, filter = "sub" } = options;

  const invalid = validate(width, height, channels);
  if (invalid) {
    return new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        controller.error(invalid);
      },
    });
  }

  const deflate = new CompressionStream("deflate");
  const compressor = deflate.writable.getWriter();
  const compressed = deflate.readable.getReader();

  const rowBytes = width * channels;
  const expected = rowBytes * height;
  const row = new Uint8Array(rowBytes);
  let rowFill = 0;
  let received = 0;

  let readableController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let failure: Error | undefined;

  function fail(error: Error): Error {
    if (!failure) {
      failure = error;
      void compressor.abort(error).catch(() => {});
      void compressed.cancel(error).catch(() => {});
      readableController?.error(error);
    }
    return failure;
  }

  async function writeRow(src: Uint8Array): Promise<void> {
    const out = new Uint8Array(1 + rowBytes);
    if (filter === "sub") {
      out[0] = 1;
      for (let i = 0; i < channels; i++) out[1 + i] = src[i]!;
      for (let i = channels; i < rowBytes; i++) out[1 + i] = (src[i]! - src[i - channels]!) & 0xff;
    } else {
      out.set(src, 1);
    }
    await compressor.write(out);
  }

  const writable = new WritableStream<Uint8Array>({
    async write(chunk) {
      if (failure) throw failure;
      if (received + chunk.length > expected) {
        throw fail(
          new RangeError(`png-encoder: expected ${expected} bytes, received more`),
        );
      }
      received += chunk.length;
      let offset = 0;
      while (offset < chunk.length) {
        if (rowFill === 0 && chunk.length - offset >= rowBytes) {
          await writeRow(chunk.subarray(offset, offset + rowBytes));
          offset += rowBytes;
          continue;
        }
        const take = Math.min(rowBytes - rowFill, chunk.length - offset);
        row.set(chunk.subarray(offset, offset + take), rowFill);
        rowFill += take;
        offset += take;
        if (rowFill === rowBytes) {
          rowFill = 0;
          await writeRow(row);
        }
      }
    },
    async close() {
      if (failure) throw failure;
      if (received !== expected) {
        throw fail(
          new RangeError(`png-encoder: expected ${expected} bytes, received ${received}`),
        );
      }
      await compressor.close();
    },
    abort(reason) {
      fail(reason instanceof Error ? reason : new Error(String(reason)));
    },
  });

  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let finished = false;

  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      readableController = controller;
      controller.enqueue(headerBytes(width, height, channels));
      if (failure) controller.error(failure);
    },
    async pull(controller) {
      while (!finished && pendingBytes < IDAT_TARGET_BYTES) {
        const { value, done } = await compressed.read();
        if (done) {
          finished = true;
        } else if (value.length > 0) {
          pending.push(value);
          pendingBytes += value.length;
        }
      }
      if (pendingBytes > 0) {
        controller.enqueue(pngChunk("IDAT", pending, pendingBytes));
        pending = [];
        pendingBytes = 0;
      }
      if (finished) {
        controller.enqueue(pngChunk("IEND", [], 0));
        controller.close();
      }
    },
    cancel(reason) {
      failure ??= reason instanceof Error ? reason : new Error("png-encoder: cancelled");
      void compressor.abort(failure).catch(() => {});
      return compressed.cancel(reason).catch(() => {});
    },
  });

  return { readable, writable };
}
