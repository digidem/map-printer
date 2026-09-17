import type { Page } from "playwright";
import { beforeAll, expect, test } from "vitest";
import type { StyleSpecification } from "maplibre-gl";
import { baseUrl, describeEngines, harnessUrl, usePage } from "./browsers.ts";
import {
  fitBounds,
  project,
  rotateOffset,
  tileGrid,
  type Bbox,
  type LngLat,
  type TileRect,
  type Viewport,
} from "../src/lib/viewport/index.ts";

const fixtureStyle = "/fixtures/style-geojson.json";

/** The red square in the fixture style. */
const SQUARE: Bbox = [-1, -1, 1, 1];
/** A view that places the square in the upper half of the tile. */
const VIEW_BBOX: Bbox = [-4, -6, 4, 2];
/** Twice as wide: two tiles, with the square inside the right-hand one. */
const WIDE_VIEW_BBOX: Bbox = [-12, -6, 4, 2];
const TILE_SIZE = { width: 256, height: 256 };
const RED = [255, 0, 0];
const WHITE = [255, 255, 255];

const hangingStyle: StyleSpecification = {
  version: 8,
  sources: {
    hang: {
      type: "raster",
      tiles: [`${baseUrl}/hang/{z}/{x}/{y}.png`],
      tileSize: 256,
    },
  },
  layers: [{ id: "hang", type: "raster", source: "hang" }],
};

type Rect = { left: number; top: number; right: number; bottom: number };

/** Where `bbox` lands in the tile's output pixels. */
function projectedRect(
  bbox: Bbox,
  v: Viewport,
  tile: TileRect,
  pixelRatio: number,
): Rect {
  const [cx, cy] = project(v.center, v.zoom);
  const originX = cx - v.width / 2 + tile.x;
  const originY = cy - v.height / 2 + tile.y;
  const [left, top] = project([bbox[0], bbox[3]], v.zoom);
  const [right, bottom] = project([bbox[2], bbox[1]], v.zoom);
  return {
    left: (left - originX) * pixelRatio,
    top: (top - originY) * pixelRatio,
    right: (right - originX) * pixelRatio,
    bottom: (bottom - originY) * pixelRatio,
  };
}

/** Where a lng/lat lands in the viewport's pixels, at any bearing. */
function toScreen(v: Viewport, point: LngLat): [number, number] {
  const [cx, cy] = project(v.center, v.zoom);
  const [x, y] = project(point, v.zoom);
  const [sx, sy] = rotateOffset([x - cx, y - cy], -(v.bearing ?? 0));
  return [sx + v.width / 2, sy + v.height / 2];
}

/** `[a, b]` corners in screen order, from the square's NW clockwise. */
function squareCorners([west, south, east, north]: Bbox): LngLat[] {
  return [
    [west, north],
    [east, north],
    [east, south],
    [west, south],
  ];
}

function pixelAt(
  pixels: Uint8Array,
  width: number,
  x: number,
  y: number,
  channels: 3 | 4 = 3,
) {
  const i = (Math.round(y) * width + Math.round(x)) * channels;
  return [pixels[i], pixels[i + 1], pixels[i + 2]];
}

function expectColor(actual: number[], expected: number[]) {
  for (let c = 0; c < 3; c++) {
    expect(Math.abs(actual[c] - expected[c])).toBeLessThanOrEqual(2);
  }
}

interface RenderOptions {
  style: string | StyleSpecification;
  pixelRatio: number;
  tileSize?: { width: number; height: number };
  channels?: 3 | 4;
  tiles: TileRect[];
  zoom: number;
  bearing?: number;
  renderTimeoutMs?: number;
}

/** Renders every tile from one renderer, as the export layer does. */
async function renderTiles(
  page: Page,
  opts: RenderOptions,
): Promise<Uint8Array[]> {
  // Serialized by hand: StyleSpecification is too deep for evaluate's arg typing.
  const rendered = await page.evaluate(async (json: string) => {
    const opts: {
      style: string | import("maplibre-gl").StyleSpecification;
      pixelRatio: number;
      tileSize?: { width: number; height: number };
      channels?: 3 | 4;
      tiles: import("../src/lib/viewport/index.ts").TileRect[];
      zoom: number;
      bearing?: number;
      renderTimeoutMs?: number;
    } = JSON.parse(json);
    const renderer = await window.mapPrinter.createMapRenderer({
      style: opts.style,
      pixelRatio: opts.pixelRatio,
      tileSize: opts.tileSize ?? { width: 256, height: 256 },
      channels: opts.channels ?? 3,
      renderTimeoutMs: opts.renderTimeoutMs,
    });
    try {
      const out: Uint8Array[] = [];
      for (const tile of opts.tiles) {
        out.push(await renderer.render(tile, opts.zoom, opts.bearing));
      }
      return out;
    } finally {
      renderer.destroy();
    }
  }, JSON.stringify(opts));
  return rendered.map((pixels) => new Uint8Array(pixels));
}

async function renderTile(
  page: Page,
  opts: Omit<RenderOptions, "tiles"> & { tile: TileRect },
): Promise<Uint8Array> {
  const { tile, ...rest } = opts;
  const [pixels] = await renderTiles(page, { ...rest, tiles: [tile] });
  return pixels;
}

async function createRenderer(
  page: Page,
  opts: {
    style: string | StyleSpecification;
    pixelRatio: number;
    tileSize: { width: number; height: number };
  },
): Promise<void> {
  await page.evaluate(async (json: string) => {
    const opts: {
      style: string | import("maplibre-gl").StyleSpecification;
      pixelRatio: number;
      tileSize: { width: number; height: number };
    } = JSON.parse(json);
    const renderer = await window.mapPrinter.createMapRenderer({
      ...opts,
      channels: 3,
      renderTimeoutMs: 20_000,
    });
    renderer.destroy();
  }, JSON.stringify(opts));
}

describeEngines((engine) => {
  const browser = usePage(engine);
  let page: Page;

  beforeAll(async () => {
    page = browser.page;
    await page.goto(harnessUrl);
    await page.waitForFunction(() => Boolean(window.mapPrinter));
  });

  test("maxTileSize reports a usable size", async () => {
    const size = await page.evaluate(() => window.mapPrinter.maxTileSize(2));
    expect(size.width).toBeGreaterThanOrEqual(1024);
    expect(size.width).toBeLessThanOrEqual(4096);
    expect(size.height).toBe(size.width);
  });

  test.each([
    { pixelRatio: 1, viewport: TILE_SIZE, style: fixtureStyle },
    { pixelRatio: 2, viewport: TILE_SIZE, style: fixtureStyle },
    {
      pixelRatio: 1,
      viewport: { width: 256, height: 200 },
      style: fixtureStyle,
    },
    // No background layer in the style: the renderer must insert the white one.
    {
      pixelRatio: 1,
      viewport: TILE_SIZE,
      style: "/fixtures/style-geojson-nobg.json",
    },
    // A sprite that 404s is an error event MapLibre recovers from.
    {
      pixelRatio: 1,
      viewport: TILE_SIZE,
      style: "/fixtures/style-geojson-badsprite.json",
    },
  ])(
    "renders the square at pixel ratio $pixelRatio in a $viewport.width×$viewport.height tile from $style",
    async ({ pixelRatio, viewport, style }) => {
      const v = fitBounds(VIEW_BBOX, viewport.width, viewport.height);
      const tiles = tileGrid(v, TILE_SIZE);
      expect(tiles).toHaveLength(1);
      const tile = tiles[0];
      const width = tile.width * pixelRatio;
      const height = tile.height * pixelRatio;

      const pixels = await renderTile(page, {
        style,
        pixelRatio,
        tile,
        zoom: v.zoom,
      });
      expect(pixels).toHaveLength(width * height * 3);

      const square = projectedRect(SQUARE, v, tile, pixelRatio);
      const margin = 3 * pixelRatio;
      expect(square.top).toBeGreaterThan(margin);
      expect(square.bottom).toBeLessThan(height / 2);
      const midX = (square.left + square.right) / 2;
      const midY = (square.top + square.bottom) / 2;

      for (const [x, y] of [
        [midX, midY],
        [square.left + margin, square.top + margin],
        [square.right - margin, square.bottom - margin],
      ]) {
        expectColor(pixelAt(pixels, width, x, y), RED);
      }
      for (const [x, y] of [
        [0, 0],
        [width - 1, 0],
        [0, height - 1],
        [width - 1, height - 1],
        [midX, square.top - margin],
        [midX, square.bottom + margin],
        [square.left - margin, midY],
        [square.right + margin, midY],
      ]) {
        expectColor(pixelAt(pixels, width, x, y), WHITE);
      }
    },
  );

  test("renders both tiles of a grid from one renderer", async () => {
    const v = fitBounds(WIDE_VIEW_BBOX, 512, 256);
    const tiles = tileGrid(v, TILE_SIZE);
    expect(tiles).toHaveLength(2);

    const rendered = await renderTiles(page, {
      style: fixtureStyle,
      pixelRatio: 1,
      tiles,
      zoom: v.zoom,
    });

    const square = projectedRect(SQUARE, v, tiles[1], 1);
    const margin = 3;
    expect(square.left).toBeGreaterThan(margin);
    expect(square.right).toBeLessThan(tiles[1].width - margin);
    const midX = (square.left + square.right) / 2;
    const midY = (square.top + square.bottom) / 2;

    expectColor(pixelAt(rendered[1], tiles[1].width, midX, midY), RED);
    // The square is in the right-hand tile only, so the left one stays white.
    for (const [x, y] of [
      [0, 0],
      [tiles[0].width - 1, TILE_SIZE.height - 1],
      [tiles[0].width / 2, midY],
      [tiles[0].width - 1, midY],
    ]) {
      expectColor(pixelAt(rendered[0], tiles[0].width, x, y), WHITE);
    }
  });

  test("viewport's rotation convention matches MapLibre's", async () => {
    const v = fitBounds(VIEW_BBOX, 256, 200, 30);
    const points = squareCorners(SQUARE);
    const theirs = await page.evaluate(
      (json: string) => {
        const { camera, points } = JSON.parse(json) as {
          camera: import("../src/lib/viewport/index.ts").Viewport;
          points: import("../src/lib/viewport/index.ts").LngLat[];
        };
        return window.mapPrinter.mapLibreProject(camera, points);
      },
      JSON.stringify({ camera: v, points }),
    );
    for (const [i, point] of points.entries()) {
      const [x, y] = toScreen(v, point);
      expect(theirs[i][0], `x of corner ${i}`).toBeCloseTo(x, 3);
      expect(theirs[i][1], `y of corner ${i}`).toBeCloseTo(y, 3);
    }
  });

  test.each([
    { bearing: 90, pixelRatio: 1 },
    { bearing: 30, pixelRatio: 1 },
    { bearing: -135, pixelRatio: 2 },
  ])(
    "renders the square turned by $bearing° at pixel ratio $pixelRatio",
    async ({ bearing, pixelRatio }) => {
      // Square: the tile is square too, so any bearing keeps it inside.
      const v = fitBounds([-4, -4, 4, 4], 256, 256, bearing);
      const [tile] = tileGrid(v, TILE_SIZE);
      const width = tile.width * pixelRatio;
      const pixels = await renderTile(page, {
        style: fixtureStyle,
        pixelRatio,
        tile,
        zoom: v.zoom,
        bearing,
      });

      const centre = toScreen(v, [0, 0]);
      const corners = squareCorners(SQUARE).map((c) => toScreen(v, c));
      const toward = (
        [x, y]: [number, number],
        fraction: number,
      ): [number, number] => [
        (centre[0] + (x - centre[0]) * fraction) * pixelRatio,
        (centre[1] + (y - centre[1]) * fraction) * pixelRatio,
      ];
      expectColor(
        pixelAt(pixels, width, centre[0] * pixelRatio, centre[1] * pixelRatio),
        RED,
      );
      for (const corner of corners) {
        expectColor(pixelAt(pixels, width, ...toward(corner, 0.85)), RED);
        expectColor(pixelAt(pixels, width, ...toward(corner, 1.15)), WHITE);
      }
      // Each edge midpoint, just inside and just outside.
      for (let i = 0; i < 4; i++) {
        const a = corners[i];
        const b = corners[(i + 1) % 4];
        const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        expectColor(pixelAt(pixels, width, ...toward(mid, 0.9)), RED);
        expectColor(pixelAt(pixels, width, ...toward(mid, 1.1)), WHITE);
      }
    },
  );

  test("renders RGBA with an opaque alpha channel", async () => {
    const v = fitBounds(VIEW_BBOX, 256, 256);
    const [tile] = tileGrid(v, TILE_SIZE);
    const pixels = await renderTile(page, {
      style: fixtureStyle,
      pixelRatio: 1,
      channels: 4,
      tile,
      zoom: v.zoom,
    });
    expect(pixels).toHaveLength(tile.width * tile.height * 4);
    for (let i = 3; i < pixels.length; i += 4) {
      expect(pixels[i]).toBe(255);
    }

    const square = projectedRect(SQUARE, v, tile, 1);
    const midX = (square.left + square.right) / 2;
    const midY = (square.top + square.bottom) / 2;
    expectColor(pixelAt(pixels, tile.width, midX, midY, 4), RED);
    expectColor(pixelAt(pixels, tile.width, 0, tile.height - 1, 4), WHITE);
  });

  test("renders a canvas larger than MapLibre's default maxCanvasSize", async () => {
    // 5120×2048 device px, above the 4096×4096 default.
    await expect(
      createRenderer(page, {
        style: fixtureStyle,
        pixelRatio: 2,
        tileSize: { width: 2560, height: 1024 },
      }),
    ).resolves.toBeUndefined();
  });

  test("rejects a tile larger than the GPU can render", async () => {
    await expect(
      createRenderer(page, {
        style: fixtureStyle,
        pixelRatio: 4,
        tileSize: { width: 8192, height: 8192 },
      }),
    ).rejects.toThrow(/canvas for a 32768×32768 tile/);
  });

  test("rejects with a timeout when a tile source never responds", async () => {
    const v = fitBounds(VIEW_BBOX, 256, 256);
    const [tile] = tileGrid(v, TILE_SIZE);
    const started = Date.now();
    await expect(
      renderTile(page, {
        style: hangingStyle,
        pixelRatio: 1,
        tile,
        zoom: v.zoom,
        renderTimeoutMs: 2_000,
      }),
    ).rejects.toThrow(/Tile 0,0 did not finish rendering within 2000 ms/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("a hidden tab pauses the render timeout", async () => {
    // A slow style rather than a hanging tile source: WebKit keeps a hung
    // request's connection after the map is destroyed, and a second one would
    // starve the tests that follow.
    const result = await page.evaluate(async () => {
      let state: DocumentVisibilityState = "visible";
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => state,
      });
      const setVisibility = (next: DocumentVisibilityState) => {
        state = next;
        document.dispatchEvent(new Event("visibilitychange"));
      };
      const sleep = (ms: number) =>
        new Promise((resolve) => setTimeout(resolve, ms));
      try {
        setVisibility("hidden");
        let settled = false;
        const creating = window.mapPrinter
          .createMapRenderer({
            style: "/fixtures/style-geojson.json?delay=6000",
            pixelRatio: 1,
            tileSize: { width: 256, height: 256 },
            channels: 3,
            renderTimeoutMs: 1_000,
          })
          .then(
            (renderer) => {
              renderer.destroy();
              return "resolved";
            },
            (err: Error) => err.message,
          )
          .finally(() => (settled = true));
        await sleep(2_000);
        const settledWhileHidden = settled;
        setVisibility("visible");
        const t0 = performance.now();
        const message = await creating;
        return { settledWhileHidden, message, visibleMs: performance.now() - t0 };
      } finally {
        setVisibility("visible");
        delete (document as { visibilityState?: unknown }).visibilityState;
      }
    });

    expect(result.settledWhileHidden).toBe(false);
    expect(result.message).toMatch(/did not finish rendering within 1000 ms/);
    expect(result.visibleMs).toBeGreaterThanOrEqual(900);
    expect(result.visibleMs).toBeLessThan(5_000);
  });

  test("rejects when the style cannot be loaded", async () => {
    const v = fitBounds(VIEW_BBOX, 256, 256);
    const [tile] = tileGrid(v, TILE_SIZE);
    await expect(
      renderTile(page, {
        style: "/fixtures/missing.json",
        pixelRatio: 1,
        tile,
        zoom: v.zoom,
      }),
    ).rejects.toThrow(/Map style failed/);
  });
});
