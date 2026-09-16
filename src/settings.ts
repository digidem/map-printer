import { clampBbox, isValidBbox, type Bbox } from "./lib/viewport/index.ts";

export const DPI_OPTIONS = [96, 192, 288, 384] as const;
export type Dpi = (typeof DPI_OPTIONS)[number];

export interface Settings {
  style: string;
  mapboxToken: string;
  /** Page width in mm. */
  width: number;
  /** Page height in mm. */
  height: number;
  bbox: Bbox;
  previewBbox: boolean;
  dpi: Dpi;
}

/** The attribution checkbox is deliberately absent: it resets on every load. */
export const DEFAULT_SETTINGS: Settings = {
  style: "https://tiles.openfreemap.org/styles/liberty",
  mapboxToken: "",
  width: 297,
  height: 210,
  bbox: [-7.1354, 57.9095, -6.1357, 58.516],
  previewBbox: true,
  dpi: 96,
};

const STORAGE_KEY = "map-printer-settings";

/** `W,S,E,N` in any mix of commas and whitespace. Latitudes are clamped first,
 *  so the usual whole-world `-180,-90,180,90` is accepted. */
export function parseBbox(text: string): Bbox | null {
  const parts = text.trim().split(/[\s,]+/).filter(Boolean).map(Number);
  if (parts.length !== 4 || !parts.every(Number.isFinite)) return null;
  const bbox = clampBbox(parts as Bbox);
  return isValidBbox(bbox) ? bbox : null;
}

export function formatBbox(bbox: Bbox): string {
  return bbox.join(", ");
}

export function loadSettings(): Settings {
  let raw: unknown = null;
  try {
    raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
  } catch {
    raw = null;
  }
  const stored = (
    raw && typeof raw === "object" ? raw : {}
  ) as Partial<Record<keyof Settings, unknown>>;
  const bbox =
    Array.isArray(stored.bbox) && stored.bbox.length === 4
      ? clampBbox(stored.bbox as Bbox)
      : null;
  return {
    style: nonEmptyString(stored.style) ?? DEFAULT_SETTINGS.style,
    mapboxToken:
      typeof stored.mapboxToken === "string" ? stored.mapboxToken : "",
    width: positiveNumber(stored.width) ?? DEFAULT_SETTINGS.width,
    height: positiveNumber(stored.height) ?? DEFAULT_SETTINGS.height,
    bbox: bbox && isValidBbox(bbox) ? bbox : DEFAULT_SETTINGS.bbox,
    previewBbox:
      typeof stored.previewBbox === "boolean"
        ? stored.previewBbox
        : DEFAULT_SETTINGS.previewBbox,
    dpi: isDpi(stored.dpi) ? stored.dpi : DEFAULT_SETTINGS.dpi,
  };
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private-mode quota failures are not worth failing an export over.
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function isDpi(value: unknown): value is Dpi {
  return DPI_OPTIONS.includes(value as Dpi);
}
