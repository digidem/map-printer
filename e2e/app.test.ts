import fs from "node:fs";
import path from "node:path";
import { decode, type DecodedPng } from "fast-png";
import type { Page } from "playwright";
import { beforeAll, expect, test } from "vitest";
import { baseUrl, describeEngines, usePage } from "./browsers.ts";
import { mmToPx } from "../src/lib/viewport/index.ts";

const fixtureStyle = `${baseUrl}/fixtures/style-geojson.json`;
/** Seeded so the app never resolves the default style over the network. */
const seededStyle = `${baseUrl}/fixtures/style-geojson-nobg.json`;
const rasterTemplate = `${baseUrl}/fixtures/tiles/{z}/{x}/{y}.png`;

const BBOX = "-4, -3, 4, 3";
const WIDTH_MM = 80;
const HEIGHT_MM = 53;
const DPI = 96;

/** Big enough an area, small enough a page, that the export needs the zoom-2
 *  tiles — the deepest the fixture set goes. */
const RASTER_BBOX = "-90, -45, 90, 45";
const RASTER_WIDTH_MM = 150;
const RASTER_HEIGHT_MM = 84;

function pixelAt(png: DecodedPng, x: number, y: number): number[] {
  const i = (y * png.width + x) * png.channels;
  return [png.data[i], png.data[i + 1], png.data[i + 2]];
}

function isRed([r, g, b]: number[]): boolean {
  return r > 200 && g < 60 && b < 60;
}

/** Waits out a change to the style field: the form drops the resolved style on
 *  the first keystroke and re-resolves it after a debounce, and Export is only
 *  meaningful once it has come back. */
async function waitForStyle(page: Page): Promise<void> {
  await page.waitForSelector("#export[disabled]");
  await page.waitForSelector("#export:not([disabled])");
}

function near(a: number[], b: number[], tolerance = 4): boolean {
  return a.every((value, i) => Math.abs(value - b[i]) <= tolerance);
}

/** The colour of every fixture tile, read back from the generated PNGs. */
function tilePalette(): number[][] {
  const dir = path.resolve("e2e/fixtures/tiles");
  return fs
    .readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".png"))
    .map((file) =>
      pixelAt(decode(fs.readFileSync(path.join(dir, file))), 0, 0),
    );
}

/** Positions whose whole neighbourhood is one flat colour, i.e. tile interiors
 *  rather than the seams where MapLibre blends adjacent tiles. */
function* flatPatches(
  png: DecodedPng,
  step = 16,
  radius = 2,
): Generator<[number, number, number[]]> {
  for (let y = radius; y < png.height - radius; y += step) {
    for (let x = radius; x < png.width - radius; x += step) {
      const centre = pixelAt(png, x, y);
      let flat = true;
      for (let dy = -radius; flat && dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (!near(pixelAt(png, x + dx, y + dy), centre, 1)) {
            flat = false;
            break;
          }
        }
      }
      if (flat) yield [x, y, centre];
    }
  }
}

describeEngines((engine) => {
  const browser = usePage(engine);
  let page: Page;

  beforeAll(async () => {
    page = browser.page;
    await page.addInitScript(
      (json: string) => {
        localStorage.setItem("map-printer-settings", json);
      },
      JSON.stringify({ style: seededStyle, dpi: DPI }),
    );
    await page.goto(baseUrl);
    await page.waitForSelector("#export");

    await page.fill("#style", fixtureStyle);
    await page.fill("#bbox", BBOX);
    await page.fill("#width", String(WIDTH_MM));
    await page.fill("#height", String(HEIGHT_MM));
    await page.selectOption("#dpi", String(DPI));
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
    const file = path.join(browser.downloadDir, download.suggestedFilename());
    await download.saveAs(file);
    const png = decode(fs.readFileSync(file));

    expect(png.width).toBe(mmToPx(WIDTH_MM, DPI, 1));
    expect(png.height).toBe(mmToPx(HEIGHT_MM, DPI, 1));
    // The fixture's red square is centred on the bbox, with white around it.
    expect(isRed(pixelAt(png, png.width >> 1, png.height >> 1))).toBe(true);
    expect(isRed(pixelAt(png, 1, 1))).toBe(false);

    await page.waitForSelector('[data-message="success"]');
  });

  test("exports a raster tile template in the fixture palette", async () => {
    await page.fill("#style", rasterTemplate);
    await page.fill("#bbox", RASTER_BBOX);
    await page.fill("#width", String(RASTER_WIDTH_MM));
    await page.fill("#height", String(RASTER_HEIGHT_MM));
    await waitForStyle(page);

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 60_000 }),
      page.click("#export"),
    ]);
    const file = path.join(browser.downloadDir, download.suggestedFilename());
    await download.saveAs(file);
    const png = decode(fs.readFileSync(file));

    const palette = tilePalette();
    const seen = new Set<string>();
    let sampled = 0;
    for (const [x, y, rgb] of flatPatches(png)) {
      const match = palette.find((color) => near(rgb, color));
      expect(match, `${rgb} at ${x},${y} is not a tile colour`).toBeDefined();
      seen.add(String(match));
      sampled++;
    }
    expect(sampled).toBeGreaterThan(100);
    expect(seen.size).toBeGreaterThan(1);
  });

  // Last: Playwright's Firefox stops reporting downloads once one has been
  // errored, which is what cancelling does.
  test("cancelling an export restores the form", async () => {
    // The fixture server holds the style back so the export is certain to still
    // be running when Cancel is hit. Playwright's WebKit does not route
    // requests that pass through a controlling service worker, so the delay
    // cannot come from `page.route`.
    await page.fill("#style", `${fixtureStyle}?delay=2000`);
    await waitForStyle(page);

    await page.click("#export");
    await page.waitForSelector('[role="progressbar"]');
    await page.click("#cancel");

    await page.waitForSelector('[data-message="error"]');
    expect(await page.textContent('[data-message="error"]')).toContain(
      "cancelled",
    );
    await page.waitForSelector('[role="progressbar"]', { state: "detached" });
    await page.waitForSelector("#export:not([disabled])");
  });
});
