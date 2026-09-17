import { beforeEach, describe, expect, test } from "vitest";
import { MAX_LATITUDE } from "./lib/viewport/index.ts";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  parseBbox,
  parseBearing,
  saveSettings,
} from "./settings.ts";

const STORAGE_KEY = "map-printer-settings";

class MemoryStorage {
  private items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
  clear() {
    this.items.clear();
  }
}

describe("parseBbox", () => {
  test("parses commas and whitespace alike", () => {
    expect(parseBbox("-7.1354, 57.9095, -6.1357, 58.516")).toEqual([
      -7.1354, 57.9095, -6.1357, 58.516,
    ]);
    expect(parseBbox(" -7.1354 57.9095  -6.1357\t58.516 ")).toEqual([
      -7.1354, 57.9095, -6.1357, 58.516,
    ]);
  });

  test("accepts the whole world by clamping its latitudes", () => {
    expect(parseBbox("-180,-90,180,90")).toEqual([
      -180,
      -MAX_LATITUDE,
      180,
      MAX_LATITUDE,
    ]);
  });

  test("rejects the wrong count, non-numbers and a reversed order", () => {
    expect(parseBbox("")).toBeNull();
    expect(parseBbox("1,2,3")).toBeNull();
    expect(parseBbox("1,2,3,4,5")).toBeNull();
    expect(parseBbox("a,b,c,d")).toBeNull();
    expect(parseBbox("10,20,5,30")).toBeNull();
    expect(parseBbox("-190,20,5,30")).toBeNull();
  });
});

describe("parseBearing", () => {
  test("accepts any finite number of degrees and wraps it", () => {
    expect(parseBearing("0")).toBe(0);
    expect(parseBearing(" -45.5 ")).toBe(-45.5);
    expect(parseBearing("270")).toBe(-90);
    expect(parseBearing("180")).toBe(180);
    expect(parseBearing("-180")).toBe(180);
  });

  test("rejects blanks and non-numbers", () => {
    expect(parseBearing("")).toBeNull();
    expect(parseBearing("  ")).toBeNull();
    expect(parseBearing("north")).toBeNull();
    expect(parseBearing("Infinity")).toBeNull();
  });
});

describe("loadSettings", () => {
  beforeEach(() => {
    globalThis.localStorage = new MemoryStorage() as unknown as Storage;
  });

  test("falls back to the defaults when nothing is stored", () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  test("survives unparseable storage", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  test("merges what is stored and replaces what is invalid", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        style: "https://example.com/style.json",
        width: 0,
        height: 500,
        bbox: [1, 2, "three", 4],
        dpi: 150,
        previewBbox: "yes",
        bearing: "45",
      }),
    );
    expect(loadSettings()).toEqual({
      ...DEFAULT_SETTINGS,
      style: "https://example.com/style.json",
      height: 500,
    });
  });

  test("wraps a stored bearing", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ bearing: 270 }));
    expect(loadSettings().bearing).toBe(-90);
  });

  test("round-trips through saveSettings", () => {
    const settings = { ...DEFAULT_SETTINGS, dpi: 288 as const, width: 420 };
    saveSettings(settings);
    expect(loadSettings()).toEqual(settings);
  });
});
