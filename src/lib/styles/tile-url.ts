import type { StyleSpecification } from "maplibre-gl";

export type StyleKind = "vector" | "raster";
/** Tile y-axis convention for raster sources. `xyz` = y grows downward
 *  (Google/OSM); `tms` = y grows upward (OGC TMS). */
export type TileScheme = "xyz" | "tms";

const DEFAULT_SUBDOMAINS = ["a", "b", "c"];
const SUBDOMAIN_RE = /\{subdomain\}|\{s\}/;
const SUBDOMAIN_RE_G = /\{subdomain\}|\{s\}/g;

/** True if the URL is a tile template — it contains `{z}`, `{x}` and `{y}`
 *  placeholders (in any order; some providers such as Google put `{z}` last)
 *  or a Bing-style `{quadkey}` placeholder. */
export function isTileUrlTemplate(url: string): boolean {
  if (url.includes("{quadkey}")) return true;
  return url.includes("{z}") && url.includes("{x}") && url.includes("{y}");
}

export function hasSubdomainPlaceholder(url: string): boolean {
  return SUBDOMAIN_RE.test(url);
}

/** Expand `{subdomain}` / `{s}` into one URL per subdomain — MapLibre cycles
 *  through a `tiles[]` array, so this is the standard way to provide per-host
 *  load-balanced templates. */
export function expandSubdomainTiles(
  tileUrl: string,
  subdomains?: string[],
): string[] {
  if (!SUBDOMAIN_RE.test(tileUrl)) return [tileUrl];
  const subs = subdomains?.length ? subdomains : DEFAULT_SUBDOMAINS;
  return subs.map((s) => tileUrl.replace(SUBDOMAIN_RE_G, s));
}

/** Build a basic raster style for a tile URL template (z/x/y or quadkey —
 *  MapLibre substitutes `{quadkey}` itself). When the template contains
 *  `{subdomain}`/`{s}`, expand into one URL per subdomain so MapLibre can
 *  round-robin. `scheme` controls the y-axis convention (xyz vs OGC tms). */
export function rasterStyleForTileUrl(
  tileUrl: string,
  subdomains?: string[],
  scheme: TileScheme = "xyz",
  maxZoom?: number,
): StyleSpecification {
  return {
    version: 8,
    sources: {
      tiles: {
        type: "raster",
        tiles: expandSubdomainTiles(tileUrl, subdomains),
        tileSize: 256,
        scheme,
        ...(maxZoom != null ? { maxzoom: maxZoom } : {}),
      },
    },
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": "#e9e7e1" },
      },
      {
        id: "tiles",
        type: "raster",
        source: "tiles",
      },
    ],
  };
}

/** Build a style for a TileJSON URL. The source `url` field triggers MapLibre
 *  to fetch & inline the TileJSON automatically. */
export function styleForTileJson(
  tileJsonUrl: string,
  kind: StyleKind,
): StyleSpecification {
  if (kind === "vector") {
    return {
      version: 8,
      sources: {
        src: { type: "vector", url: tileJsonUrl },
      },
      // No layer styling — a vector TileJSON carries no cartography, but the
      // background at least gives the export a defined colour.
      layers: [
        {
          id: "background",
          type: "background",
          paint: { "background-color": "#f5f4ee" },
        },
      ],
    };
  }
  return {
    version: 8,
    sources: {
      src: { type: "raster", url: tileJsonUrl, tileSize: 256 },
    },
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": "#e9e7e1" },
      },
      { id: "src", type: "raster", source: "src" },
    ],
  };
}
