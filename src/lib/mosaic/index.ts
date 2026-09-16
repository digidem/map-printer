export type MosaicTile = {
  col: number;
  row: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type MosaicOptions = {
  width: number;
  height: number;
  channels: 3 | 4;
  tiles: readonly MosaicTile[];
  render: (tile: MosaicTile) => Promise<Uint8Array>;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
};

type Band = { tiles: readonly MosaicTile[]; height: number };

const CHUNK_TARGET_BYTES = 256 * 1024;

export function createMosaic(opts: MosaicOptions): ReadableStream<Uint8Array> {
  const { width, channels, render, onProgress, signal } = opts;
  const rowBytes = width * channels;
  const rowsPerChunk = Math.max(1, Math.floor(CHUNK_TARGET_BYTES / rowBytes));

  let bands: Band[] = [];
  let bandIndex = 0;
  let band = new Uint8Array(0);
  let bandRows = 0;
  let rowsSent = 0;
  let stopped = false;
  let abortListener: (() => void) | undefined;

  function unlisten() {
    if (abortListener) signal?.removeEventListener("abort", abortListener);
    abortListener = undefined;
  }

  async function renderBand(next: Band) {
    const buf = new Uint8Array(rowBytes * next.height);
    for (const tile of next.tiles) {
      if (stopped) return;
      const pixels = await render(tile);
      if (stopped) return;
      const expected = tile.width * tile.height * channels;
      if (pixels.length !== expected) {
        throw new RangeError(
          `render(${tile.col},${tile.row}) returned ${pixels.length} bytes, expected ${expected}`,
        );
      }
      const tileRowBytes = tile.width * channels;
      for (let r = 0; r < tile.height; r++) {
        const from = r * tileRowBytes;
        buf.set(
          pixels.subarray(from, from + tileRowBytes),
          r * rowBytes + tile.x * channels,
        );
      }
    }
    band = buf;
    bandRows = next.height;
    rowsSent = 0;
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      try {
        bands = planBands(opts);
      } catch (err) {
        stopped = true;
        controller.error(err);
        return;
      }
      if (!signal) return;
      if (signal.aborted) {
        stopped = true;
        controller.error(signal.reason);
        return;
      }
      abortListener = () => {
        stopped = true;
        controller.error(signal.reason);
      };
      signal.addEventListener("abort", abortListener, { once: true });
    },

    async pull(controller) {
      if (rowsSent === bandRows) {
        if (bandIndex === bands.length) {
          unlisten();
          controller.close();
          return;
        }
        await renderBand(bands[bandIndex]);
        if (stopped) return;
        bandIndex++;
        onProgress?.(bandIndex / bands.length);
      }
      const rows = Math.min(rowsPerChunk, bandRows - rowsSent);
      const from = rowsSent * rowBytes;
      controller.enqueue(band.slice(from, from + rows * rowBytes));
      rowsSent += rows;
    },

    cancel() {
      stopped = true;
      band = new Uint8Array(0);
      unlisten();
    },
  });
}

function planBands({ width, height, channels, tiles }: MosaicOptions): Band[] {
  if (!isPositiveInt(width) || !isPositiveInt(height)) {
    throw new RangeError(`width and height must be positive integers`);
  }
  if (channels !== 3 && channels !== 4) {
    throw new RangeError(`channels must be 3 or 4, got ${channels}`);
  }
  const bands: Band[] = [];
  let y = 0;
  let i = 0;
  while (i < tiles.length) {
    const row = bands.length;
    const bandTiles: MosaicTile[] = [];
    let x = 0;
    let bandHeight = 0;
    for (; i < tiles.length && tiles[i].row === row; i++) {
      const tile = tiles[i];
      if (!isPositiveInt(tile.width) || !isPositiveInt(tile.height)) {
        throw new RangeError(`tile ${tile.col},${tile.row} has a non-positive size`);
      }
      if (tile.col !== bandTiles.length || tile.x !== x || tile.y !== y) {
        throw new RangeError(`tile ${tile.col},${tile.row} is not adjacent to its neighbours`);
      }
      if (bandTiles.length === 0) bandHeight = tile.height;
      else if (tile.height !== bandHeight) {
        throw new RangeError(`tile ${tile.col},${tile.row} does not match the height of its band`);
      }
      bandTiles.push(tile);
      x += tile.width;
    }
    if (x !== width) {
      throw new RangeError(`row ${row} spans ${x}px, expected ${width}px`);
    }
    bands.push({ tiles: bandTiles, height: bandHeight });
    y += bandHeight;
  }
  if (y !== height) {
    throw new RangeError(`tiles span ${y}px of height, expected ${height}px`);
  }
  return bands;
}

function isPositiveInt(n: number): boolean {
  return Number.isInteger(n) && n > 0;
}
