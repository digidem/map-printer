import {
  Map as MapLibreMap,
  setWorkerUrl,
  type ErrorEvent,
  type RequestTransformFunction,
  type StyleSpecification,
} from "maplibre-gl";
// `?worker&url`, not `?url`: the worker imports a sibling shared chunk that `?url` doesn't emit.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import {
  ensureOpaqueBackground,
  OPAQUE_BACKGROUND_LAYER,
} from "../styles/index.ts";
import { project, unproject, type TileRect } from "../viewport/index.ts";

setWorkerUrl(maplibreWorkerUrl);

export interface MapRendererOptions {
  style: string | StyleSpecification;
  pixelRatio: number;
  tileSize: { width: number; height: number };
  channels: 3 | 4;
  transformRequest?: RequestTransformFunction;
  renderTimeoutMs?: number;
}

export interface MapRenderer {
  render(tile: TileRect, zoom: number): Promise<Uint8Array>;
  destroy(): void;
}

/** Textures above this are slow and unreliable even on GPUs that report a
 *  larger MAX_TEXTURE_SIZE. */
const MAX_DEVICE_PX = 8192;

const DEFAULT_RENDER_TIMEOUT_MS = 60_000;

export function maxTileSize(pixelRatio: number): {
  width: number;
  height: number;
} {
  assertPositive(pixelRatio, "pixelRatio");
  const gl = requireWebGl2(document.createElement("canvas"));
  const maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  const px = Math.floor(Math.min(maxTexture, MAX_DEVICE_PX) / pixelRatio);
  return { width: px, height: px };
}

export async function createMapRenderer(
  opts: MapRendererOptions,
): Promise<MapRenderer> {
  const {
    pixelRatio,
    tileSize,
    channels,
    renderTimeoutMs = DEFAULT_RENDER_TIMEOUT_MS,
  } = opts;
  assertPositive(pixelRatio, "pixelRatio");
  assertPositiveInteger(tileSize.width, "tileSize.width");
  assertPositiveInteger(tileSize.height, "tileSize.height");
  if (channels !== 3 && channels !== 4) {
    throw new TypeError(`channels must be 3 or 4, got ${channels}`);
  }
  assertPositive(renderTimeoutMs, "renderTimeoutMs");

  const canvasWidth = Math.floor(tileSize.width * pixelRatio);
  const canvasHeight = Math.floor(tileSize.height * pixelRatio);

  const container = document.createElement("div");
  container.style.cssText =
    "position:fixed;top:0;left:-100000px;" +
    `width:${tileSize.width}px;height:${tileSize.height}px`;
  document.body.append(container);

  const map = new MapLibreMap({
    container,
    style:
      typeof opts.style === "string"
        ? opts.style
        : ensureOpaqueBackground(opts.style),
    transformRequest: opts.transformRequest,
    pixelRatio,
    maxCanvasSize: [canvasWidth, canvasHeight],
    canvasContextAttributes: { preserveDrawingBuffer: true },
    fadeDuration: 0,
    trackResize: false,
    interactive: false,
    attributionControl: false,
  });

  let styleFailure: Error | undefined;
  let sourceFailure: Error | undefined;
  let styleLoaded = false;
  let rejectPending: ((error: Error) => void) | undefined;

  function destroy() {
    rejectPending?.(new Error("Map renderer destroyed"));
    map.remove();
    container.remove();
  }

  map.on("error", (event: ErrorEvent & { sourceId?: string }) => {
    if (event.sourceId !== undefined) {
      const error = describeError(event);
      if (rejectPending) rejectPending(error);
      else sourceFailure ??= error;
      return;
    }
    // Sprite, image and layer-validation errors are all fired after
    // `style.load`, and leave a map that still renders; a style that fails to
    // load or parse never gets there.
    if (styleLoaded) return;
    styleFailure ??= describeError(event);
    rejectPending?.(styleFailure);
  });

  // A style loaded by URL cannot be rewritten before construction, so the
  // background layer is inserted once MapLibre has parsed it.
  map.on("style.load", () => {
    styleLoaded = true;
    const layers = map.getStyle().layers;
    if (layers.some((layer) => layer.type === "background")) return;
    map.addLayer(OPAQUE_BACKGROUND_LAYER, layers[0]?.id);
  });

  try {
    const canvas = map.getCanvas();
    if (canvas.width !== canvasWidth || canvas.height !== canvasHeight) {
      throw new Error(
        `MapLibre created a ${canvas.width}×${canvas.height} canvas for a ` +
          `${canvasWidth}×${canvasHeight} tile; the tile exceeds this GPU's ` +
          "limits (see maxTileSize)",
      );
    }
    const gl = requireWebGl2(canvas);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => fail(timeoutError("The style", renderTimeoutMs)),
        renderTimeoutMs,
      );
      const fail = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
      rejectPending = fail;
      map.once("style.load", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    rejectPending = undefined;

    const scratch = new Uint8Array(canvasWidth * canvasHeight * 4);
    let rendering = false;

    async function render(tile: TileRect, zoom: number): Promise<Uint8Array> {
      if (rendering) {
        throw new Error("render() called while a render is in progress");
      }
      if (styleFailure) throw styleFailure;
      if (sourceFailure) {
        const error = sourceFailure;
        sourceFailure = undefined;
        throw error;
      }
      if (tile.width > tileSize.width || tile.height > tileSize.height) {
        throw new RangeError(
          `Tile ${tile.width}×${tile.height} exceeds the renderer's tile size`,
        );
      }
      rendering = true;
      const width = Math.floor(tile.width * pixelRatio);
      const height = Math.floor(tile.height * pixelRatio);
      try {
        await new Promise<void>((resolve, reject) => {
          const onIdle = () => {
            finish();
            try {
              // Read inside the idle handler, before a later frame repaints.
              gl.readPixels(
                0,
                canvasHeight - height,
                width,
                height,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                scratch,
              );
            } catch (error) {
              reject(error instanceof Error ? error : new Error(String(error)));
              return;
            }
            resolve();
          };
          const timer = setTimeout(
            () =>
              fail(
                timeoutError(`Tile ${tile.col},${tile.row}`, renderTimeoutMs),
              ),
            renderTimeoutMs,
          );
          const finish = () => {
            clearTimeout(timer);
            map.off("idle", onIdle);
            rejectPending = undefined;
          };
          const fail = (error: Error) => {
            finish();
            reject(error);
          };
          rejectPending = fail;
          map.once("idle", onIdle);
          map.jumpTo({ center: alignedCenter(tile, tileSize, zoom), zoom });
        });
      } finally {
        rendering = false;
      }
      return flipAndCrop(scratch, width, height, channels);
    }

    return { render, destroy };
  } catch (error) {
    destroy();
    throw error;
  }
}

/** The camera center that puts `tile`'s rect in the canvas's top-left corner,
 *  so edge tiles are cropped from the origin rather than at a fractional
 *  offset. */
function alignedCenter(
  tile: TileRect,
  tileSize: { width: number; height: number },
  zoom: number,
): [number, number] {
  const [x, y] = project(tile.center, zoom);
  return unproject(
    [
      x + (tileSize.width - tile.width) / 2,
      y + (tileSize.height - tile.height) / 2,
    ],
    zoom,
  );
}

/** readPixels rows are bottom-up; the result is top-down, RGB or RGBA. */
function flipAndCrop(
  rgba: Uint8Array,
  width: number,
  height: number,
  channels: 3 | 4,
): Uint8Array {
  const out = new Uint8Array(width * height * channels);
  const rowBytes = width * 4;
  for (let row = 0; row < height; row++) {
    const src = (height - 1 - row) * rowBytes;
    const dst = row * width * channels;
    if (channels === 4) {
      out.set(rgba.subarray(src, src + rowBytes), dst);
      continue;
    }
    for (let px = 0; px < width; px++) {
      out[dst + px * 3] = rgba[src + px * 4];
      out[dst + px * 3 + 1] = rgba[src + px * 4 + 1];
      out[dst + px * 3 + 2] = rgba[src + px * 4 + 2];
    }
  }
  return out;
}

function describeError(event: ErrorEvent & { sourceId?: string }): Error {
  const { error } = event;
  const message = error instanceof Error ? error.message : String(error);
  const what = event.sourceId
    ? `Map source "${event.sourceId}" failed`
    : "Map style failed";
  return new Error(`${what}: ${message}`);
}

function timeoutError(what: string, ms: number): Error {
  const hidden =
    document.visibilityState === "hidden"
      ? " (the tab is hidden, which pauses map rendering)"
      : "";
  return new Error(`${what} did not finish rendering within ${ms} ms${hidden}`);
}

function requireWebGl2(canvas: HTMLCanvasElement): WebGL2RenderingContext {
  const gl = canvas.getContext("webgl2");
  if (!gl) throw new Error("WebGL2 is not available");
  return gl;
}

function assertPositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive number, got ${value}`);
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer, got ${value}`);
  }
}
