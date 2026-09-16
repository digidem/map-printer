import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decode, type DecodedPng } from "fast-png";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  fitBounds,
  project,
  type Bbox,
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
/** Room around the square, in the 4:3 aspect of the small export. */
const VIEW_BBOX: Bbox = [-4, -3, 4, 3];
/** Tight enough that the square crosses every tile seam of the big export. */
const TIGHT_BBOX: Bbox = [-2, -1.5, 2, 1.5];
const RED = [255, 0, 0];
const WHITE = [255, 255, 255];

type Rect = { left: number; top: number; right: number; bottom: number };

/** Where `bbox` lands in the exported image's pixels. */
function projectedRect(bbox: Bbox, v: Viewport, pixelRatio: number): Rect {
  const [cx, cy] = project(v.center, v.zoom);
  const originX = cx - v.width / 2;
  const originY = cy - v.height / 2;
  const [left, top] = project([bbox[0], bbox[3]], v.zoom);
  const [right, bottom] = project([bbox[2], bbox[1]], v.zoom);
  return {
    left: (left - originX) * pixelRatio,
    top: (top - originY) * pixelRatio,
    right: (right - originX) * pixelRatio,
    bottom: (bottom - originY) * pixelRatio,
  };
}

function pixelAt(png: DecodedPng, x: number, y: number): number[] {
  const i = (Math.round(y) * png.width + Math.round(x)) * png.channels;
  return [png.data[i], png.data[i + 1], png.data[i + 2]];
}

function expectColor(actual: number[], expected: number[], where: string) {
  for (let c = 0; c < 3; c++) {
    expect(Math.abs(actual[c] - expected[c]), where).toBeLessThanOrEqual(2);
  }
}

/** `count` positions spread across `[from + margin, to - margin]`. */
function sampleAlong(
  from: number,
  to: number,
  margin: number,
  count = 9,
): number[] {
  const start = from + margin;
  const step = (to - margin - start) / (count - 1);
  return Array.from({ length: count }, (_, i) => start + i * step);
}

interface ExportRequest {
  style: string;
  bbox: Bbox;
  widthPx: number;
  heightPx: number;
  pixelRatio: number;
  filename: string;
  tileSize?: { width: number; height: number };
}

describe("chromium", () => {
  let browser: Browser;
  let page: Page;
  let downloadDir: string;

  beforeAll(async () => {
    downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "map-printer-e2e-"));
    browser = await chromium.launch({
      headless: true,
      args: ["--ignore-gpu-blocklist", "--enable-webgl", ...chromiumArgs],
    });
    page = await browser.newPage({ acceptDownloads: true });
    page.on("pageerror", (error) => console.error("[page]", error));
    await page.goto(harnessUrl);
    await page.waitForFunction(() => Boolean(window.mapPrinter));
    await page.evaluate(() => window.mapPrinter.downloadReady());
  });

  afterAll(async () => {
    await browser?.close();
    if (downloadDir) fs.rmSync(downloadDir, { recursive: true, force: true });
  });

  /** Exports through the service worker and decodes what reached disk. */
  async function exportPng(request: ExportRequest) {
    const [download, result] = await Promise.all([
      page.waitForEvent("download", { timeout: 60_000 }),
      page.evaluate(async (json: string) => {
        const opts = JSON.parse(json) as {
          style: string;
          bbox: [number, number, number, number];
          widthPx: number;
          heightPx: number;
          pixelRatio: number;
          filename: string;
          tileSize?: { width: number; height: number };
        };
        const progress: number[] = [];
        const done = await window.mapPrinter.exportMap({
          ...opts,
          onProgress: (fraction) => progress.push(fraction),
        });
        return { ...done, progress };
      }, JSON.stringify(request)),
    ]);
    expect(download.suggestedFilename()).toBe(request.filename);
    const file = path.join(downloadDir, download.suggestedFilename());
    await download.saveAs(file);
    return { result, png: decode(fs.readFileSync(file)) };
  }

  test("exports a single-tile map", async () => {
    const widthPx = 320;
    const heightPx = 240;
    const pixelRatio = 1;
    const { result, png } = await exportPng({
      style: fixtureStyle,
      bbox: VIEW_BBOX,
      widthPx,
      heightPx,
      pixelRatio,
      filename: "small.png",
    });

    const v = fitBounds(VIEW_BBOX, widthPx / pixelRatio, heightPx / pixelRatio);
    expect(png.width).toBe(widthPx);
    expect(png.height).toBe(heightPx);
    expect(png.channels).toBe(3);
    expect(result.zoom).toBeCloseTo(v.zoom, 9);
    expect(result.bbox[0]).toBeLessThanOrEqual(VIEW_BBOX[0] + 1e-9);
    expect(result.bbox[2]).toBeGreaterThanOrEqual(VIEW_BBOX[2] - 1e-9);

    const square = projectedRect(SQUARE, v, pixelRatio);
    const margin = 3;
    const midX = (square.left + square.right) / 2;
    const midY = (square.top + square.bottom) / 2;

    for (const [x, y] of [
      [midX, midY],
      [square.left + margin, square.top + margin],
      [square.right - margin, square.bottom - margin],
    ]) {
      expectColor(pixelAt(png, x, y), RED, `red at ${x},${y}`);
    }
    for (const [x, y] of [
      [0, 0],
      [png.width - 1, 0],
      [0, png.height - 1],
      [png.width - 1, png.height - 1],
      [midX, square.top - margin],
      [midX, square.bottom + margin],
      [square.left - margin, midY],
      [square.right + margin, midY],
    ]) {
      expectColor(pixelAt(png, x, y), WHITE, `white at ${x},${y}`);
    }
  });

  test("exports a 3×3 tile grid without seams", async () => {
    const widthPx = 900;
    const heightPx = 700;
    const pixelRatio = 2;
    const tileSize = { width: 150, height: 120 };
    const { result, png } = await exportPng({
      style: fixtureStyle,
      bbox: TIGHT_BBOX,
      widthPx,
      heightPx,
      pixelRatio,
      filename: "big.png",
      tileSize,
    });

    const v = fitBounds(TIGHT_BBOX, widthPx / pixelRatio, heightPx / pixelRatio);
    expect(png.width).toBe(widthPx);
    expect(png.height).toBe(heightPx);
    expect(result.progress).toHaveLength(3);
    expect(result.progress[result.progress.length - 1]).toBe(1);

    const square = projectedRect(SQUARE, v, pixelRatio);
    const margin = 2 * pixelRatio;
    const midX = (square.left + square.right) / 2;
    const midY = (square.top + square.bottom) / 2;

    // Every seam of the grid crosses the square, so an off-by-one tile would
    // show up as a stripe of the wrong colour along one of them.
    const seamsX = [tileSize.width, tileSize.width * 2].map(
      (x) => x * pixelRatio,
    );
    const seamsY = [tileSize.height, tileSize.height * 2].map(
      (y) => y * pixelRatio,
    );
    for (const x of seamsX) {
      expect(x).toBeGreaterThan(square.left);
      expect(x).toBeLessThan(square.right);
      for (const dx of [-1, 0, 1]) {
        expectColor(pixelAt(png, x + dx, midY), RED, `seam x ${x + dx}`);
      }
    }
    for (const y of seamsY) {
      expect(y).toBeGreaterThan(square.top);
      expect(y).toBeLessThan(square.bottom);
      for (const dy of [-1, 0, 1]) {
        expectColor(pixelAt(png, midX, y + dy), RED, `seam y ${y + dy}`);
      }
    }

    for (const y of sampleAlong(square.top, square.bottom, margin)) {
      expectColor(pixelAt(png, square.left + margin, y), RED, `left in ${y}`);
      expectColor(pixelAt(png, square.left - margin, y), WHITE, `left out ${y}`);
      expectColor(pixelAt(png, square.right - margin, y), RED, `right in ${y}`);
      expectColor(
        pixelAt(png, square.right + margin, y),
        WHITE,
        `right out ${y}`,
      );
    }
    for (const x of sampleAlong(square.left, square.right, margin)) {
      expectColor(pixelAt(png, x, square.top + margin), RED, `top in ${x}`);
      expectColor(pixelAt(png, x, square.top - margin), WHITE, `top out ${x}`);
      expectColor(
        pixelAt(png, x, square.bottom - margin),
        RED,
        `bottom in ${x}`,
      );
      expectColor(
        pixelAt(png, x, square.bottom + margin),
        WHITE,
        `bottom out ${x}`,
      );
    }
  });

  test("aborting mid-export fails the download", async () => {
    const request: ExportRequest = {
      style: fixtureStyle,
      bbox: TIGHT_BBOX,
      widthPx: 900,
      heightPx: 700,
      pixelRatio: 2,
      filename: "aborted.png",
      tileSize: { width: 150, height: 120 },
    };
    const [download, message] = await Promise.all([
      page.waitForEvent("download", { timeout: 60_000 }),
      page.evaluate(async (json: string) => {
        const opts = JSON.parse(json) as ExportRequest;
        const controller = new AbortController();
        try {
          await window.mapPrinter.exportMap({
            ...opts,
            signal: controller.signal,
            onProgress: () => controller.abort(new Error("cancelled by test")),
          });
          return "resolved";
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      }, JSON.stringify(request)),
    ]);

    expect(message).toBe("cancelled by test");
    expect(await download.failure()).not.toBeNull();
    expect(
      await page.evaluate(() => document.querySelectorAll("iframe").length),
    ).toBe(0);

    // A wedged port or a sink left closed only shows up on the next export.
    const { png } = await exportPng({
      style: fixtureStyle,
      bbox: VIEW_BBOX,
      widthPx: 320,
      heightPx: 240,
      pixelRatio: 1,
      filename: "after-abort.png",
    });
    expect(png.width).toBe(320);
  });

  test("a style that 404s fails the download rather than truncating it", async () => {
    const [download, message] = await Promise.all([
      page.waitForEvent("download", { timeout: 60_000 }),
      page.evaluate(async () => {
        try {
          await window.mapPrinter.exportMap({
            style: "/fixtures/no-such-style.json",
            bbox: [-4, -3, 4, 3],
            widthPx: 320,
            heightPx: 240,
            pixelRatio: 1,
            filename: "missing-style.png",
          });
          return "resolved";
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      }),
    ]);

    expect(message).not.toBe("resolved");
    expect(await download.failure()).not.toBeNull();
  });
});
