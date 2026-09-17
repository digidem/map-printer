import { describe, expect, it } from "vitest";
import { decode } from "fast-png";
import { createPngEncoder, type PngEncoderOptions } from "./index.ts";

function pixels(width: number, height: number, channels: 3 | 4): Uint8Array {
  const data = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      data[i] = (x * 7 + y * 3) & 0xff;
      data[i + 1] = (x ^ y) & 0xff;
      data[i + 2] = (x + y * 11) & 0xff;
      if (channels === 4) data[i + 3] = 255 - ((x * y) & 0xff);
    }
  }
  return data;
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function collect(readable: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const reader = readable.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return parts;
    parts.push(value);
  }
}

async function inflate(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new DecompressionStream("deflate");
  const output = collect(stream.readable);
  const writer = stream.writable.getWriter();
  await writer.write(data);
  await writer.close();
  return concat(await output);
}

function idatPayload(png: Uint8Array): Uint8Array<ArrayBuffer> {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const parts: Uint8Array[] = [];
  for (let offset = 8; offset < png.length; ) {
    const length = view.getUint32(offset);
    if (new TextDecoder().decode(png.subarray(offset + 4, offset + 8)) === "IDAT") {
      parts.push(png.subarray(offset + 8, offset + 8 + length));
    }
    offset += 12 + length;
  }
  return concat(parts);
}

async function feed(
  writable: WritableStream<Uint8Array>,
  data: Uint8Array,
  chunkSize: number,
): Promise<void> {
  const writer = writable.getWriter();
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    await writer.write(data.subarray(offset, Math.min(offset + chunkSize, data.length)));
  }
  await writer.close();
}

async function encode(
  data: Uint8Array,
  opts: PngEncoderOptions,
  chunkSize = data.length,
): Promise<Uint8Array[]> {
  const encoder = createPngEncoder(opts);
  const output = collect(encoder.readable);
  await feed(encoder.writable, data, chunkSize);
  return await output;
}

describe("createPngEncoder", () => {
  for (const channels of [3, 4] as const) {
    for (const filter of ["none", "sub"] as const) {
      it(`round-trips ${channels} channels with filter "${filter}"`, async () => {
        const [width, height] = [37, 19];
        const data = pixels(width, height, channels);
        const png = concat(await encode(data, { width, height, channels, filter }));
        const decoded = decode(png);
        expect(decoded.width).toBe(width);
        expect(decoded.height).toBe(height);
        expect(decoded.channels).toBe(channels);
        expect(decoded.depth).toBe(8);
        expect(new Uint8Array(decoded.data as Uint8Array)).toEqual(data);
      });
    }
  }

  for (const [filter, filterByte] of [
    ["none", 0],
    ["sub", 1],
  ] as const) {
    it(`emits filter byte ${filterByte} for filter "${filter}"`, async () => {
      const [width, height, channels] = [11, 7, 3] as const;
      const data = pixels(width, height, channels);
      const png = concat(await encode(data, { width, height, channels, filter }));
      const raw = await inflate(idatPayload(png));
      const stride = width * channels + 1;
      expect(raw.length).toBe(height * stride);
      for (let y = 0; y < height; y++) expect(raw[y * stride]).toBe(filterByte);
    });
  }

  it("defaults to the sub filter", async () => {
    const data = pixels(9, 5, 3);
    const withDefault = concat(await encode(data, { width: 9, height: 5, channels: 3 }));
    const withSub = concat(
      await encode(data, { width: 9, height: 5, channels: 3, filter: "sub" }),
    );
    expect(withDefault).toEqual(withSub);
  });

  for (const chunkSize of [1, 7, 13, 1000]) {
    it(`accepts ${chunkSize}-byte chunks that split rows`, async () => {
      const [width, height, channels] = [11, 7, 3] as const;
      const data = pixels(width, height, channels);
      const png = concat(await encode(data, { width, height, channels }, chunkSize));
      const decoded = decode(png);
      expect(decoded.width).toBe(width);
      expect(new Uint8Array(decoded.data as Uint8Array)).toEqual(data);
    });
  }

  it("encodes a 1x1 image", async () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const png = concat(await encode(data, { width: 1, height: 1, channels: 4 }));
    const decoded = decode(png);
    expect(decoded.width).toBe(1);
    expect(decoded.height).toBe(1);
    expect(new Uint8Array(decoded.data as Uint8Array)).toEqual(data);
  });

  it("encodes a wide, short image", async () => {
    const [width, height, channels] = [4096, 2, 3] as const;
    const data = pixels(width, height, channels);
    const png = concat(await encode(data, { width, height, channels }, 4999));
    const decoded = decode(png);
    expect(decoded.width).toBe(width);
    expect(decoded.height).toBe(height);
    expect(new Uint8Array(decoded.data as Uint8Array)).toEqual(data);
  });

  it("starts with the signature and IHDR and ends with IEND", async () => {
    const png = concat(await encode(pixels(4, 4, 3), { width: 4, height: 4, channels: 3 }));
    expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(new TextDecoder().decode(png.subarray(12, 16))).toBe("IHDR");
    expect(new TextDecoder().decode(png.subarray(png.length - 8, png.length - 4))).toBe("IEND");
  });

  it("streams a 2000x2000 image without buffering the whole compressed file", async () => {
    const [width, height, channels] = [2000, 2000, 3] as const;
    const encoder = createPngEncoder({ width, height, channels });
    const noisyRow = () => crypto.getRandomValues(new Uint8Array(width * channels));

    let maxQueued = 0;
    const reader = encoder.readable.getReader();
    const output = (async () => {
      let bytes = 0;
      let idats = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return { bytes, idats };
        bytes += value.length;
        maxQueued = Math.max(maxQueued, value.length);
        if (new TextDecoder().decode(value.subarray(4, 8)) === "IDAT") idats++;
      }
    })();

    const writer = encoder.writable.getWriter();
    for (let y = 0; y < height; y++) await writer.write(noisyRow());
    await writer.close();

    const { bytes, idats } = await output;
    expect(bytes).toBeGreaterThan(0);
    expect(idats).toBeGreaterThan(20);
    expect(maxQueued).toBeLessThan(256 * 1024);
  }, 60_000);

  it("errors when too few bytes arrive", async () => {
    const encoder = createPngEncoder({ width: 4, height: 4, channels: 3 });
    const output = collect(encoder.readable);
    const writer = encoder.writable.getWriter();
    await writer.write(new Uint8Array(12));
    await expect(writer.close()).rejects.toThrow(/received 12/);
    await expect(output).rejects.toThrow(/received 12/);
  });

  it("errors when too many bytes arrive", async () => {
    const encoder = createPngEncoder({ width: 4, height: 4, channels: 3 });
    const output = collect(encoder.readable);
    const writer = encoder.writable.getWriter();
    await expect(writer.write(new Uint8Array(4 * 4 * 3 + 1))).rejects.toThrow(/received more/);
    await expect(output).rejects.toThrow(/received more/);
  });

  for (const [label, opts] of [
    ["zero width", { width: 0, height: 4, channels: 3 }],
    ["fractional height", { width: 4, height: 2.5, channels: 3 }],
    ["negative height", { width: 4, height: -1, channels: 3 }],
  ] as const) {
    it(`errors on ${label}`, async () => {
      const encoder = createPngEncoder(opts as PngEncoderOptions);
      await expect(collect(encoder.readable)).rejects.toThrow(/positive integer/);
      const writer = encoder.writable.getWriter();
      await expect(writer.write(new Uint8Array(3))).rejects.toThrow(/positive integer/);
    });
  }

  it("cancelling the readable stops the writable", async () => {
    const [width, height, channels] = [64, 64, 3] as const;
    const encoder = createPngEncoder({ width, height, channels });
    const reader = encoder.readable.getReader();
    await reader.read();
    await reader.cancel(new Error("nope"));

    const writer = encoder.writable.getWriter();
    await expect(
      (async () => {
        for (let y = 0; y < height; y++) await writer.write(new Uint8Array(width * channels));
      })(),
    ).rejects.toThrow();
  });
});
