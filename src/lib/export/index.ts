import type {
  RequestTransformFunction,
  StyleSpecification,
} from "maplibre-gl";
import { startDownload } from "../download/index.ts";
import {
  createMapRenderer,
  maxTileSize,
  type MapRenderer,
} from "../map-renderer/index.ts";
import { createMosaic } from "../mosaic/index.ts";
import { createPngEncoder } from "../png-encoder/index.ts";
import {
  fitBounds,
  fitsWorld,
  tileGrid,
  viewportBbox,
  type Bbox,
  type TileRect,
} from "../viewport/index.ts";

export interface ExportOptions {
  style: string | StyleSpecification;
  transformRequest?: RequestTransformFunction;
  bbox: Bbox;
  /** Output size in device px; both must be whole multiples of `pixelRatio`. */
  widthPx: number;
  heightPx: number;
  pixelRatio: number;
  filename: string;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** Test-only: renders this tile grid instead of the one derived from the
   *  GPU limits and the band budget. */
  tileSize?: { width: number; height: number };
}

export interface ExportResult {
  bbox: Bbox;
  zoom: number;
}

const CHANNELS = 3;

/** Caps the pixel buffers alive while a band is composed: the band itself, the
 *  tile the renderer just returned and its RGBA readPixels scratch. */
const MEMORY_BUDGET_BYTES = 64 * 1024 * 1024;

type ExportTile = {
  col: number;
  row: number;
  x: number;
  y: number;
  width: number;
  height: number;
  css: TileRect;
};

export async function exportMap(opts: ExportOptions): Promise<ExportResult> {
  const { widthPx, heightPx, pixelRatio, onProgress, signal } = opts;
  assertPositiveInteger(pixelRatio, "pixelRatio");
  assertPositiveInteger(widthPx, "widthPx");
  assertPositiveInteger(heightPx, "heightPx");
  if (widthPx % pixelRatio !== 0 || heightPx % pixelRatio !== 0) {
    throw new TypeError(
      `widthPx and heightPx must be whole multiples of pixelRatio (${pixelRatio}), got ${widthPx}×${heightPx}`,
    );
  }

  const viewport = fitBounds(opts.bbox, widthPx / pixelRatio, heightPx / pixelRatio);
  if (!fitsWorld(viewport)) {
    throw new RangeError(
      "This area is taller than the map at the zoom it would export at — " +
        "widen the area or reduce the height",
    );
  }

  const tileSize =
    opts.tileSize ?? chooseTileSize(viewport.width, viewport.height, pixelRatio);
  const tiles: ExportTile[] = tileGrid(viewport, tileSize).map((css) => ({
    col: css.col,
    row: css.row,
    x: css.x * pixelRatio,
    y: css.y * pixelRatio,
    width: css.width * pixelRatio,
    height: css.height * pixelRatio,
    css,
  }));

  const { writable, cleanup } = await startDownload({
    filename: opts.filename,
    contentType: "image/png",
  });

  let renderer: MapRenderer | undefined;
  try {
    renderer = await createMapRenderer({
      style: opts.style,
      transformRequest: opts.transformRequest,
      pixelRatio,
      tileSize,
      channels: CHANNELS,
    });
    const map = renderer;

    await createMosaic<ExportTile>({
      width: widthPx,
      height: heightPx,
      channels: CHANNELS,
      tiles,
      render: (tile) => map.render(tile.css, viewport.zoom),
      onProgress,
      signal,
    })
      .pipeThrough(
        createPngEncoder({
          width: widthPx,
          height: heightPx,
          channels: CHANNELS,
          filter: "sub",
        }),
      )
      .pipeTo(writable, { signal });
  } catch (err) {
    // The response only errors if the worker is told; a failure before or
    // outside `pipeTo` would otherwise leave a truncated file on disk.
    await writable.abort(err).catch(() => {});
    throw err;
  } finally {
    renderer?.destroy();
    cleanup();
  }

  return { bbox: viewportBbox(viewport), zoom: viewport.zoom };
}

/** The widest tile this GPU can render, and the tallest that keeps the buffers
 *  live during a band inside the memory budget. */
function chooseTileSize(
  cssWidth: number,
  cssHeight: number,
  pixelRatio: number,
): { width: number; height: number } {
  const max = maxTileSize(pixelRatio);
  const width = Math.min(max.width, cssWidth);
  const cols = Math.ceil(cssWidth / width);
  const devicePxPerRow = width * pixelRatio * pixelRatio;
  const bytesPerRow = devicePxPerRow * (CHANNELS * cols + CHANNELS + 4);
  const height = Math.max(
    1,
    Math.min(
      max.height,
      cssHeight,
      Math.floor(MEMORY_BUDGET_BYTES / bytesPerRow),
    ),
  );
  return { width, height };
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer, got ${value}`);
  }
}
