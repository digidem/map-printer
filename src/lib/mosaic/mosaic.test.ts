import { describe, expect, it, vi } from "vitest";
import { createMosaic, type MosaicOptions, type MosaicTile } from "./index.ts";

function grid(colWidths: number[], rowHeights: number[]): MosaicTile[] {
  const tiles: MosaicTile[] = [];
  let y = 0;
  for (const [row, height] of rowHeights.entries()) {
    let x = 0;
    for (const [col, width] of colWidths.entries()) {
      tiles.push({ col, row, x, y, width, height });
      x += width;
    }
    y += height;
  }
  return tiles;
}

const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

function byteFor(col: number, row: number, channel: number): number {
  return (col * 37 + row * 91 + channel * 17 + 5) % 256;
}

function fakeRender(channels: 3 | 4) {
  return async (tile: MosaicTile) => {
    const out = new Uint8Array(tile.width * tile.height * channels);
    for (let i = 0; i < out.length; i++) {
      out[i] = byteFor(tile.col, tile.row, i % channels);
    }
    return out;
  };
}

function expectedImage(
  colWidths: number[],
  rowHeights: number[],
  channels: 3 | 4,
): Uint8Array {
  const width = sum(colWidths);
  const out = new Uint8Array(width * sum(rowHeights) * channels);
  const colAt = (x: number) => colWidths.findIndex((_, i) => x < sum(colWidths.slice(0, i + 1)));
  const rowAt = (y: number) => rowHeights.findIndex((_, i) => y < sum(rowHeights.slice(0, i + 1)));
  for (let y = 0; y < sum(rowHeights); y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < channels; c++) {
        out[(y * width + x) * channels + c] = byteFor(colAt(x), rowAt(y), c);
      }
    }
  }
  return out;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    chunks.push(value);
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(sum(chunks.map((c) => c.length)));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function mosaicFor(
  colWidths: number[],
  rowHeights: number[],
  channels: 3 | 4,
  overrides: Partial<MosaicOptions> = {},
) {
  return createMosaic({
    width: sum(colWidths),
    height: sum(rowHeights),
    channels,
    tiles: grid(colWidths, rowHeights),
    render: fakeRender(channels),
    ...overrides,
  });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createMosaic", () => {
  it.for([
    { name: "1x1", cols: [1], rows: [1], channels: 3 },
    { name: "1x1 rgba", cols: [1], rows: [1], channels: 4 },
    { name: "single tile", cols: [7], rows: [5], channels: 3 },
    { name: "one row, ragged last column", cols: [4, 4, 3], rows: [6], channels: 3 },
    { name: "one column, ragged last row", cols: [5], rows: [4, 4, 1], channels: 4 },
    { name: "n x m ragged both ways", cols: [3, 3, 2], rows: [3, 3, 1], channels: 3 },
    { name: "n x m ragged both ways, rgba", cols: [2, 2, 1], rows: [2, 2, 1], channels: 4 },
  ] as const)("composes $name pixel-exactly", async ({ cols, rows, channels }) => {
    const bytes = concat(await readAll(mosaicFor([...cols], [...rows], channels)));
    expect(bytes).toEqual(expectedImage([...cols], [...rows], channels));
  });

  it("emits whole scanlines in chunks of at most ~256 KiB", async () => {
    const cols = [400, 400, 200];
    const rows = [100, 100];
    const chunks = await readAll(mosaicFor(cols, rows, 3));
    const rowBytes = sum(cols) * 3;
    expect(chunks.length).toBeGreaterThan(rows.length);
    for (const chunk of chunks) {
      expect(chunk.length % rowBytes).toBe(0);
      expect(chunk.length).toBeLessThanOrEqual(256 * 1024);
    }
    expect(concat(chunks)).toEqual(expectedImage(cols, rows, 3));
  });

  it("renders tiles in row-major order, one band at a time", async () => {
    const seen: string[] = [];
    const render = vi.fn(async (tile: MosaicTile) => {
      seen.push(`${tile.col},${tile.row}`);
      return fakeRender(3)(tile);
    });
    await readAll(mosaicFor([2, 2], [2, 2, 2], 3, { render }));
    expect(seen).toEqual(["0,0", "1,0", "0,1", "1,1", "0,2", "1,2"]);
  });

  it("reports progress up to 1 after each band", async () => {
    const fractions: number[] = [];
    await readAll(mosaicFor([2, 2], [2, 2, 2], 3, { onProgress: (f) => fractions.push(f) }));
    expect(fractions).toEqual([1 / 3, 2 / 3, 1]);
  });

  it("does not render further bands after the consumer cancels", async () => {
    const rendered: number[] = [];
    const render = vi.fn(async (tile: MosaicTile) => {
      rendered.push(tile.row);
      await flush();
      return fakeRender(3)(tile);
    });
    const reader = mosaicFor([2, 2], [2, 2, 2, 2], 3, { render }).getReader();
    await reader.read();
    await reader.cancel();
    const after = rendered.length;
    await flush();
    await flush();
    expect(rendered.length).toBe(after);
    expect(rendered).not.toContain(2);
  });

  it("errors the stream and stops rendering when the signal aborts", async () => {
    const rendered: number[] = [];
    const controller = new AbortController();
    const render = vi.fn(async (tile: MosaicTile) => {
      rendered.push(tile.row);
      await flush();
      return fakeRender(3)(tile);
    });
    const reader = mosaicFor([2, 2], [2, 2, 2, 2], 3, {
      render,
      signal: controller.signal,
    }).getReader();
    await reader.read();
    controller.abort(new Error("stop"));
    await expect(reader.read()).rejects.toThrow("stop");
    await flush();
    await flush();
    expect(rendered).not.toContain(2);
  });

  it("errors immediately when the signal is already aborted", async () => {
    const render = vi.fn(fakeRender(3));
    const signal = AbortSignal.abort(new Error("gone"));
    const stream = mosaicFor([2], [2], 3, { render, signal });
    await expect(readAll(stream)).rejects.toThrow("gone");
    expect(render).not.toHaveBeenCalled();
  });

  it("errors the stream when render rejects", async () => {
    const render = vi.fn(async (tile: MosaicTile) => {
      if (tile.row === 1) throw new Error("tile server down");
      return fakeRender(3)(tile);
    });
    await expect(readAll(mosaicFor([2, 2], [2, 2], 3, { render }))).rejects.toThrow(
      "tile server down",
    );
  });

  it("errors the stream when a render result has the wrong byte length", async () => {
    const render = async (tile: MosaicTile) =>
      new Uint8Array(tile.width * tile.height * 3 - 1);
    await expect(readAll(mosaicFor([2, 2], [2], 3, { render }))).rejects.toThrow(
      /returned 11 bytes, expected 12/,
    );
  });

  it.for([
    { name: "rows that do not span the width", tiles: grid([2], [2, 2]), width: 4, height: 4 },
    { name: "bands that do not span the height", tiles: grid([2, 2], [2]), width: 4, height: 4 },
    { name: "no tiles at all", tiles: [], width: 4, height: 4 },
    {
      name: "a gap between tiles",
      tiles: [
        { col: 0, row: 0, x: 0, y: 0, width: 2, height: 2 },
        { col: 1, row: 0, x: 3, y: 0, width: 1, height: 2 },
      ],
      width: 4,
      height: 2,
    },
    {
      name: "mismatched heights within a band",
      tiles: [
        { col: 0, row: 0, x: 0, y: 0, width: 2, height: 2 },
        { col: 1, row: 0, x: 2, y: 0, width: 2, height: 3 },
      ],
      width: 4,
      height: 2,
    },
    { name: "a non-integer size", tiles: grid([2, 2], [2]), width: 4, height: 2.5 },
  ])("errors the stream for $name", async ({ tiles, width, height }) => {
    const render = vi.fn(fakeRender(3));
    const stream = createMosaic({ width, height, channels: 3, tiles, render });
    await expect(readAll(stream)).rejects.toThrow(RangeError);
    expect(render).not.toHaveBeenCalled();
  });
});
