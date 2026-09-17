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

  test("an invalid rotation is reported inline", async () => {
    await page.fill("#bearing", "");
    await page.waitForSelector('[data-error="bearing"]');
    expect(await page.isDisabled("#export")).toBe(true);

    await page.fill("#bearing", "0");
    await page.waitForSelector('[data-error="bearing"]', { state: "detached" });
    await page.waitForSelector("#export:not([disabled])");
  });

  test("the compass resets the rotation field", async () => {
    await page.fill("#bearing", "90");
    await page.waitForSelector('[data-zoom-line]:has-text("rotated 90°")');

    await page.click(".maplibregl-ctrl-compass");
    await page.waitForFunction(
      () => (document.querySelector("#bearing") as HTMLInputElement).value === "0",
    );
    await page.waitForSelector('[data-zoom-line]:not(:has-text("rotated"))');
  });

  test("exports the bbox turned by the rotation field", async () => {
    await page.fill("#bearing", "30");
    await page.waitForSelector('[data-zoom-line]:has-text("rotated 30°")');
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 60_000 }),
      page.click("#export"),
    ]);
    const file = path.join(browser.downloadDir, download.suggestedFilename());
    await download.saveAs(file);
    const png = decode(fs.readFileSync(file));

    expect(png.width).toBe(mmToPx(WIDTH_MM, DPI, 1));
    expect(png.height).toBe(mmToPx(HEIGHT_MM, DPI, 1));
    // The 6° bbox height fills the page, so the 2° square's half-side is a
    // sixth of it. The square turns 30° about the page centre.
    const cx = png.width / 2;
    const cy = png.height / 2;
    const half = png.height / 6;
    const cos = Math.cos(Math.PI / 6);
    const sin = Math.sin(Math.PI / 6);
    expect(isRed(pixelAt(png, Math.round(cx), Math.round(cy)))).toBe(true);
    // Just inside the north-up square's corner: outside the turned one.
    expect(
      isRed(pixelAt(png, Math.round(cx + 0.9 * half), Math.round(cy - 0.9 * half))),
    ).toBe(false);
    // Most of the way to the turned square's south-east corner: inside it,
    // but beyond the north-up square's east edge.
    const cornerX = half * cos + half * sin;
    const cornerY = -half * sin + half * cos;
    expect(cornerX * 0.85).toBeGreaterThan(half + 3);
    expect(
      isRed(
        pixelAt(png, Math.round(cx + 0.85 * cornerX), Math.round(cy + 0.85 * cornerY)),
      ),
    ).toBe(true);
    await page.waitForSelector('[data-message="success"]');
    await page.fill("#bearing", "0");
  });

  /** Exports the raster fixture and checks every flat patch is a tile colour. */
  async function exportRaster(bearing: string): Promise<void> {
    await page.fill("#bbox", RASTER_BBOX);
    await page.fill("#width", String(RASTER_WIDTH_MM));
    await page.fill("#height", String(RASTER_HEIGHT_MM));
    await page.fill("#bearing", bearing);
    // Last: the debounced re-resolve would otherwise re-enable Export before
    // waitForStyle sees it go disabled.
    await page.fill("#style", rasterTemplate);
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
  }

  test("exports a raster tile template in the fixture palette", async () => {
    await exportRaster("0");
  });

  test("exports a turned raster tile template in the fixture palette", async () => {
    // The style is already the raster one, so waitForStyle would hang on a
    // field that does not change; re-select the vector fixture first.
    await page.fill("#style", fixtureStyle);
    await waitForStyle(page);
    await exportRaster("30");
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
    const message = await page.textContent('[data-message="error"]');
    expect(message).toContain("cancelled");
    expect(message).toContain("incomplete");
    await page.waitForSelector('[role="progressbar"]', { state: "detached" });
    await page.waitForSelector("#export:not([disabled])");
  });
});
