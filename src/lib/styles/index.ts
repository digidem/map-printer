import type {
  LayerSpecification,
  RequestTransformFunction,
  StyleSpecification,
} from "maplibre-gl";
import {
  isMapboxUrl,
  mapboxStyleUri,
  normalizeMapboxUrl,
  parseMapboxStyleUrl,
  type MapboxStyleRef,
} from "./mapbox.ts";
import {
  isTileUrlTemplate,
  rasterStyleForTileUrl,
  styleForTileJson,
  type StyleKind,
} from "./tile-url.ts";

export { MAPBOX_ATTRIBUTION, MAPBOX_TERMS_URL } from "./mapbox.ts";
export type { MapboxStyleRef } from "./mapbox.ts";
export {
  expandSubdomainTiles,
  hasSubdomainPlaceholder,
  isTileUrlTemplate,
  rasterStyleForTileUrl,
  styleForTileJson,
} from "./tile-url.ts";
export type { StyleKind, TileScheme } from "./tile-url.ts";

export type FetchLike = typeof fetch;

export interface TileJson {
  tilejson?: string;
  tiles?: string[];
  format?: string;
  vector_layers?: unknown[];
  attribution?: string;
  [key: string]: unknown;
}

export type StyleInput =
  | { kind: "style"; url: string; style: StyleSpecification }
  | { kind: "mapbox"; url: string; ref: MapboxStyleRef }
  | { kind: "raster"; url: string }
  | { kind: "tilejson"; url: string; tileKind: StyleKind; tilejson: TileJson };

/** Classify the one text input the app takes. Mapbox style URLs and tile
 *  templates are recognised from their shape; anything else must be an
 *  https URL to JSON, which is fetched once (a plain URL is equally likely to
 *  be a MapLibre style or a TileJSON) and kept on the result so callers do not
 *  refetch it. Returns null for anything unusable. */
export async function resolveInput(
  text: string,
  fetchImpl: FetchLike = fetch,
): Promise<StyleInput | null> {
  const url = text.trim();
  if (!url) return null;

  const ref = parseMapboxStyleUrl(url);
  if (ref) return { kind: "mapbox", url: mapboxStyleUri(ref), ref };
  if (isTileUrlTemplate(url)) return { kind: "raster", url };
  if (!/^https?:\/\//i.test(url)) return null;

  const json = await fetchJson(url, fetchImpl);
  if (!json) return null;
  if (json.version === 8 && Array.isArray(json.layers)) {
    return { kind: "style", url, style: json as unknown as StyleSpecification };
  }
  if (Array.isArray(json.tiles) || typeof json.tilejson === "string") {
    const tilejson = json as TileJson;
    return {
      kind: "tilejson",
      url,
      tileKind: tileJsonKind(tilejson),
      tilejson,
    };
  }
  return null;
}

/** What to hand MapLibre's `setStyle` / the `style` map option. */
export function buildStyle(
  input: StyleInput,
  opts: { mapboxToken?: string } = {},
): string | StyleSpecification {
  switch (input.kind) {
    case "mapbox": {
      const token = tokenFor(input, opts.mapboxToken);
      return token ? normalizeMapboxUrl(input.url, token) : input.url;
    }
    // The URL, not the parsed JSON: MapLibre resolves relative sprite, glyph
    // and source references against the style URL it loaded.
    case "style":
      return input.url;
    case "raster":
      return rasterStyleForTileUrl(input.url);
    case "tilejson":
      return styleForTileJson(input.url, input.tileKind);
  }
}

/** Rewrites `mapbox://` sprite, glyph, source and tile URLs. Undefined for
 *  non-Mapbox input, so another provider's key is never sent to Mapbox. */
export function transformRequestFor(
  input: StyleInput,
  mapboxToken?: string,
): RequestTransformFunction | undefined {
  if (input.kind !== "mapbox") return undefined;
  const token = tokenFor(input, mapboxToken);
  return (url: string) =>
    isMapboxUrl(url) ? { url: normalizeMapboxUrl(url, token) } : { url };
}

/** The layer `ensureOpaqueBackground` prepends; the renderer inserts the
 *  same one into styles it loads by URL. */
export const OPAQUE_BACKGROUND_LAYER: LayerSpecification = {
  id: "map-printer-background",
  type: "background",
  paint: { "background-color": "#ffffff" },
};

/** Every pixel of a print export must be opaque, so a style without a
 *  background layer gets a white one. */
export function ensureOpaqueBackground(
  style: StyleSpecification,
): StyleSpecification {
  if (style.layers.some((layer) => layer.type === "background")) return style;
  return { ...style, layers: [OPAQUE_BACKGROUND_LAYER, ...style.layers] };
}

/** Attribution the user has to reproduce on the print: the inline `attribution`
 *  of every source, plus the `attribution` of the TileJSON behind every source
 *  that has a `url`. Returned as deduplicated plain text, HTML stripped. */
export async function fetchAttribution(
  style: StyleSpecification,
  input: StyleInput,
  fetchImpl: FetchLike = fetch,
  mapboxToken?: string,
): Promise<string[]> {
  const token = tokenFor(input, mapboxToken);
  const inline: string[] = [];
  const sourceUrls: string[] = [];
  for (const source of Object.values(style.sources ?? {})) {
    const { attribution, url } = source as {
      attribution?: unknown;
      url?: unknown;
    };
    if (typeof attribution === "string") inline.push(attribution);
    if (typeof url === "string") sourceUrls.push(url);
  }

  const fetched = await Promise.all(
    sourceUrls.map((url) => sourceAttribution(url, input, token, fetchImpl)),
  );

  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...inline, ...fetched]) {
    const text = toPlainText(raw ?? "");
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function tokenFor(input: StyleInput, mapboxToken?: string): string | undefined {
  if (mapboxToken) return mapboxToken;
  return input.kind === "mapbox" ? input.ref.accessToken : undefined;
}

async function sourceAttribution(
  url: string,
  input: StyleInput,
  token: string | undefined,
  fetchImpl: FetchLike,
): Promise<string | null> {
  if (input.kind === "tilejson" && url === input.url) {
    return input.tilejson.attribution ?? null;
  }
  let resolved: string;
  try {
    resolved = isMapboxUrl(url)
      ? normalizeMapboxUrl(url, token)
      : absoluteUrl(url, input.kind === "style" ? input.url : undefined);
  } catch {
    return null;
  }
  const json = await fetchJson(resolved, fetchImpl);
  return typeof json?.attribution === "string" ? json.attribution : null;
}

function absoluteUrl(url: string, base?: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
  if (!base) throw new Error(`Cannot resolve relative source URL: ${url}`);
  return new URL(url, base).toString();
}

async function fetchJson(
  url: string,
  fetchImpl: FetchLike,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const json: unknown = await res.json();
    return json && typeof json === "object" && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function tileJsonKind(tilejson: TileJson): StyleKind {
  const format = tilejson.format?.toLowerCase();
  const vector =
    format === "pbf" || format === "mvt" || "vector_layers" in tilejson;
  return vector ? "vector" : "raster";
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  middot: "·",
  ndash: "–",
  mdash: "—",
};

function toPlainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
      if (entity[0] === "#") {
        const code = Number(
          entity[1] === "x" || entity[1] === "X"
            ? `0x${entity.slice(2)}`
            : entity.slice(1),
        );
        return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match;
      }
      return ENTITIES[entity.toLowerCase()] ?? match;
    })
    .replace(/\s+/g, " ")
    .trim();
}
