import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { StyleSpecification } from "maplibre-gl";
import {
  fitBounds,
  project,
  tileGrid,
  type Bbox,
  type TileRect,
  type Viewport,
} from "../src/lib/viewport/index.ts";

const baseUrl = "http://localhost:4174";
const harnessUrl = `${baseUrl}/e2e/harness/index.html`;
const fixtureStyle = "/fixtures/style-geojson.json";

const chromiumArgs =
  process.platform === "darwin"
    ? ["--use-gl=angle", "--use-angle=metal"]
    : ["--use-gl=angle", "--use-angle=swiftshader"];

/** The red square in the fixture style. */
const SQUARE: Bbox = [-1, -1, 1, 1];
/** A view that places the square in the upper half of the tile. */
const VIEW_BBOX: Bbox = [-4, -6, 4, 2];
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

function pixelAt(pixels: Uint8Array, width: number, x: number, y: number) {
  const i = (Math.round(y) * width + Math.round(x)) * 3;
  return [pixels[i], pixels[i + 1], pixels[i + 2]];
}

function expectColor(actual: number[], expected: number[]) {
  for (let c = 0; c < 3; c++) {
    expect(Math.abs(actual[c] - expected[c])).toBeLessThanOrEqual(2);
  }
}

async function renderTile(
  page: Page,
  opts: {
    style: string | StyleSpecification;
    pixelRatio: number;
    tile: TileRect;
    zoom: number;
    renderTimeoutMs?: number;
  },
): Promise<Uint8Array> {
  // Serialized by hand: StyleSpecification is too deep for evaluate's arg typing.
  const pixels = await page.evaluate(async (json: string) => {
    const opts: {
      style: string | import("maplibre-gl").StyleSpecification;
      pixelRatio: number;
      tile: import("../src/lib/viewport/index.ts").TileRect;
      zoom: number;
      renderTimeoutMs?: number;
    } = JSON.parse(json);
    const renderer = await window.mapPrinter.createMapRenderer({
      style: opts.style,
      pixelRatio: opts.pixelRatio,
      tileSize: { width: 256, height: 256 },
      channels: 3,
      renderTimeoutMs: opts.renderTimeoutMs,
    });
    try {
      return await renderer.render(opts.tile, opts.zoom);
    } finally {
      renderer.destroy();
    }
  }, JSON.stringify(opts));
  return new Uint8Array(pixels);
}

describe("chromium", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      args: ["--ignore-gpu-blocklist", "--enable-webgl", ...chromiumArgs],
    });
    page = await browser.newPage();
    page.on("pageerror", (error) => console.error("[page]", error));
    await page.goto(harnessUrl);
    await page.waitForFunction(() => Boolean(window.mapPrinter));
  });

  afterAll(async () => {
    await browser?.close();
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
