const API_URL = "https://api.mapbox.com";

export interface MapboxStyleRef {
  owner: string;
  styleId: string;
  draft: boolean;
  /** Token found in the pasted URL's `access_token` query param, if any. */
  accessToken?: string;
}

interface UrlParts {
  scheme: string;
  host: string;
  path: string;
  params: URLSearchParams;
}

// A regex rather than `new URL()`: older engines don't parse the host of
// non-special schemes like `mapbox://`.
const URL_RE = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(\/[^?#]*)?(?:\?([^#]*))?/i;

function splitUrl(url: string): UrlParts | null {
  const m = URL_RE.exec(url.trim());
  if (!m) return null;
  return {
    scheme: m[1].toLowerCase(),
    host: m[2],
    path: m[3] ?? "/",
    params: new URLSearchParams(m[4] ?? ""),
  };
}

const SEGMENT = "([A-Za-z0-9_-]+)";
/** Path shapes that identify a style, keyed by scheme://host:
 *  - mapbox://styles/{owner}/{id}[/draft]
 *  - api.mapbox.com/styles/v1/{owner}/{id}[/draft][.html | /wmts | /]
 *  - studio.mapbox.com/styles/{owner}/{id}[/edit/…] */
const STYLE_PATTERNS: Record<string, RegExp> = {
  "mapbox://styles": new RegExp(`^/${SEGMENT}/${SEGMENT}(/draft)?(?:/|$)`),
  "https://api.mapbox.com": new RegExp(
    `^/styles/v1/${SEGMENT}/${SEGMENT}(/draft)?(?:\\.html|/|$)`,
  ),
  "https://studio.mapbox.com": new RegExp(
    `^/styles/${SEGMENT}/${SEGMENT}()(?:/|$)`,
  ),
};

/** Extract owner + style id from any of the URL forms Mapbox shows a user for
 *  a style (share → web, share → third party/WMTS, the preview page, Studio).
 *  Raster tile templates under a style are left alone — they're tile URLs. */
export function parseMapboxStyleUrl(input: string): MapboxStyleRef | null {
  if (/\{z\}|\{quadkey\}/.test(input)) return null;
  const parts = splitUrl(input);
  if (!parts) return null;
  const scheme = parts.scheme === "http" ? "https" : parts.scheme;
  const re = STYLE_PATTERNS[`${scheme}://${parts.host.toLowerCase()}`];
  const m = re?.exec(parts.path);
  if (!m) return null;
  return {
    owner: m[1],
    styleId: m[2],
    draft: !!m[3],
    accessToken: parts.params.get("access_token") || undefined,
  };
}

export function mapboxStyleUri({ owner, styleId, draft }: MapboxStyleRef) {
  return `mapbox://styles/${owner}/${styleId}${draft ? "/draft" : ""}`;
}

export function isMapboxUrl(url: string): boolean {
  return /^mapbox:\/\//i.test(url);
}

/** Resolve a `mapbox://` style, source, sprite, glyph or tile URL to its
 *  HTTPS API endpoint, mirroring mapbox-gl-js. Other URLs pass through. */
export function normalizeMapboxUrl(url: string, accessToken?: string): string {
  const parts = isMapboxUrl(url) ? splitUrl(url) : null;
  if (!parts) return url;
  if (!accessToken) throw new Error("Mapbox URLs require an access token");
  const { host, path } = parts;
  const kind = host.toLowerCase();
  let out: URL;
  if (kind === "styles") {
    out = new URL(`${API_URL}/styles/v1${path}`);
  } else if (kind === "fonts") {
    out = new URL(`${API_URL}/fonts/v1${path}`);
  } else if (kind === "sprites") {
    // MapLibre appends `@2x.json` etc. to the sprite path; Mapbox serves it
    // as `…/sprite@2x.json` under the style.
    const m = /^(.*?)((?:@\dx)?\.(?:json|png))?$/.exec(path)!;
    out = new URL(`${API_URL}/styles/v1${m[1]}/sprite${m[2] ?? ""}`);
  } else if (kind === "tiles") {
    out = new URL(`${API_URL}/v4${path}`);
  } else {
    // Tileset source, e.g. mapbox://mapbox.mapbox-streets-v8 → TileJSON.
    out = new URL(`${API_URL}/v4/${host}.json`);
    out.searchParams.set("secure", "");
  }
  parts.params.forEach((v, k) => out.searchParams.set(k, v));
  out.searchParams.set("access_token", accessToken);
  return out.toString();
}

export const MAPBOX_TERMS_URL = "https://www.mapbox.com/legal/tos";
export const MAPBOX_ATTRIBUTION =
  '<a href="https://www.mapbox.com/about/maps/" target="_blank" rel="noopener noreferrer">© Mapbox</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap</a>';
