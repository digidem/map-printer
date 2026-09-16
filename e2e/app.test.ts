import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decode, type DecodedPng } from "fast-png";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mmToPx } from "../src/lib/viewport/index.ts";

const baseUrl = "http://localhost:4174";
const fixtureStyle = `${baseUrl}/fixtures/style-geojson.json`;
/** Seeded so the app never resolves the default style over the network. */
const seededStyle = `${baseUrl}/fixtures/style-geojson-nobg.json`;

const chromiumArgs =
  process.platform === "darwin"
    ? ["--use-gl=angle", "--use-angle=metal"]
    : ["--use-gl=angle", "--use-angle=swiftshader"];

const BBOX = "-4, -3, 4, 3";
const WIDTH_MM = 80;
const HEIGHT_MM = 53;
const DPI = 96;

function pixelAt(png: DecodedPng, x: number, y: number): number[] {
  const i = (y * png.width + x) * png.channels;
  return [png.data[i], png.data[i + 1], png.data[i + 2]];
}

function isRed([r, g, b]: number[]): boolean {
  return r > 200 && g < 60 && b < 60;
}

describe("chromium app", () => {
  let browser: Browser;
  let page: Page;
  let downloadDir: string;

  beforeAll(async () => {
    downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "map-printer-app-"));
    browser = await chromium.launch({
      headless: true,
      args: ["--ignore-gpu-blocklist", "--enable-webgl", ...chromiumArgs],
    });
    page = await browser.newPage({ acceptDownloads: true });
    page.on("pageerror", (error) => console.error("[page]", error));
    await page.addInitScript((json: string) => {
      localStorage.setItem("map-printer-settings", json);
    }, JSON.stringify({ style: seededStyle, dpi: DPI }));
    await page.goto(baseUrl);
    await page.waitForSelector("#export");

    await page.fill("#style", fixtureStyle);
    await page.fill("#bbox", BBOX);
    await page.fill("#width", String(WIDTH_MM));
    await page.fill("#height", String(HEIGHT_MM));
    await page.selectOption("#dpi", String(DPI));
  });

  afterAll(async () => {
    await browser?.close();
    if (downloadDir) fs.rmSync(downloadDir, { recursive: true, force: true });
  });

  test("Export stays disabled until the attribution box is ticked", async () => {
    await page.check("#attribution-ok");
    await page.waitForSelector("#export:not([disabled])");

    await page.uncheck("#attribution-ok");
    expect(await page.isDisabled("#export")).toBe(true);

    await page.check("#attribution-ok");
    await page.waitForSelector("#export:not([disabled])");
  });

  test("an invalid bounding box is reported inline", async () => {
    await page.fill("#bbox", "10, 20, 5, 30");
    await page.waitForSelector('[data-error="bbox"]');
    expect(await page.isDisabled("#export")).toBe(true);

    await page.fill("#bbox", BBOX);
    await page.waitForSelector('[data-error="bbox"]', { state: "detached" });
    await page.waitForSelector("#export:not([disabled])");
  });

  test("exports the bbox at the requested pixel size", async () => {
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 60_000 }),
      page.click("#export"),
    ]);

    expect(download.suggestedFilename()).toBe(
      `map-${WIDTH_MM}x${HEIGHT_MM}mm-${DPI}dpi.png`,
    );
    const file = path.join(downloadDir, download.suggestedFilename());
    await download.saveAs(file);
    const png = decode(fs.readFileSync(file));

    expect(png.width).toBe(mmToPx(WIDTH_MM, DPI, 1));
    expect(png.height).toBe(mmToPx(HEIGHT_MM, DPI, 1));
    // The fixture's red square is centred on the bbox, with white around it.
    expect(isRed(pixelAt(png, png.width >> 1, png.height >> 1))).toBe(true);
    expect(isRed(pixelAt(png, 1, 1))).toBe(false);

    await page.waitForSelector('[data-message="success"]');
  });
});
