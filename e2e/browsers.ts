import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserType,
  type LaunchOptions,
  type Page,
} from "playwright";
import { afterAll, beforeAll, describe } from "vitest";

export const baseUrl = "http://localhost:4174";
export const harnessUrl = `${baseUrl}/e2e/harness/index.html`;

const chromiumArgs = [
  "--ignore-gpu-blocklist",
  "--enable-webgl",
  "--use-gl=angle",
  process.platform === "darwin"
    ? "--use-angle=metal"
    : "--use-angle=swiftshader",
];

export interface Engine {
  name: string;
  type: BrowserType;
  launchOptions?: LaunchOptions;
  /** Playwright's Firefox never raises a `download` event for a response whose
   *  body errors, so the tests that assert a failed download run without it. */
  reportsFailedDownloads: boolean;
}

export const engines: Engine[] = [
  {
    name: "chromium",
    type: chromium,
    launchOptions: { args: chromiumArgs },
    reportsFailedDownloads: true,
  },
  { name: "firefox", type: firefox, reportsFailedDownloads: false },
  { name: "webkit", type: webkit, reportsFailedDownloads: true },
];

/** Runs `body` once per engine. Firefox is left out of CI, which installs only
 *  chromium and webkit. */
export function describeEngines(body: (engine: Engine) => void): void {
  for (const engine of engines) {
    const suite =
      engine.name === "firefox" && process.env.CI ? describe.skip : describe;
    suite(engine.name, () => body(engine));
  }
}

export interface EnginePage {
  page: Page;
  /** Temp directory downloads are saved into, removed after the suite. */
  downloadDir: string;
}

/** One page per suite, opened in `beforeAll` and closed after. */
export function usePage(engine: Engine): EnginePage {
  const holder = {} as EnginePage;
  let browser: Browser | undefined;

  beforeAll(async () => {
    holder.downloadDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `map-printer-${engine.name}-`),
    );
    browser = await engine.type.launch({
      headless: true,
      ...engine.launchOptions,
    });
    holder.page = await browser.newPage({ acceptDownloads: true });
    holder.page.on("pageerror", (error) =>
      console.error(`[${engine.name}]`, error),
    );
  });

  afterAll(async () => {
    await browser?.close();
    if (holder.downloadDir) {
      fs.rmSync(holder.downloadDir, { recursive: true, force: true });
    }
  });

  return holder;
}
