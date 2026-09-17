export type LngLat = [lng: number, lat: number];
export type Bbox = [west: number, south: number, east: number, north: number];

export interface Viewport {
  center: LngLat;
  zoom: number;
  width: number;
  height: number;
  /** Degrees clockwise from north up, as MapLibre's `bearing`; 0 when absent. */
  bearing?: number;
}

export interface TileRect {
  col: number;
  row: number;
  x: number;
  y: number;
  width: number;
  height: number;
  center: LngLat;
}

/** MapLibre's `Transform._tileSize`: the world is `TILE_SIZE * 2 ** zoom` CSS px. */
const TILE_SIZE = 512;

export const MAX_LATITUDE = 85.051129;

const MM_PER_INCH = 25.4;

function clampLatitude(lat: number): number {
  return Math.min(Math.max(lat, -MAX_LATITUDE), MAX_LATITUDE);
}

function mercatorX(lng: number): number {
  return (180 + lng) / 360;
}

function mercatorY(lat: number): number {
  const clamped = clampLatitude(lat);
  return (
    (180 -
      (180 / Math.PI) *
        Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360))) /
    360
  );
}

function lngFromMercatorX(x: number): number {
  return x * 360 - 180;
}

function latFromMercatorY(y: number): number {
  const y2 = 180 - y * 360;
  return (360 / Math.PI) * Math.atan(Math.exp((y2 * Math.PI) / 180)) - 90;
}

function worldSize(zoom: number): number {
  return TILE_SIZE * Math.pow(2, zoom);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer, got ${value}`);
  }
}

export function isValidBbox(b: unknown): b is Bbox {
  if (!Array.isArray(b) || b.length !== 4) return false;
  const [west, south, east, north] = b;
  if (!b.every(isFiniteNumber)) return false;
  if (west < -180 || east > 180 || west >= east) return false;
  if (south < -MAX_LATITUDE || north > MAX_LATITUDE || south >= north) {
    return false;
  }
  return true;
}

export function clampBbox(b: Bbox): Bbox {
  return [b[0], clampLatitude(b[1]), b[2], clampLatitude(b[3])];
}

export function project(lngLat: LngLat, zoom: number): [number, number] {
  const size = worldSize(zoom);
  return [mercatorX(lngLat[0]) * size, mercatorY(lngLat[1]) * size];
}

export function unproject(point: [number, number], zoom: number): LngLat {
  const size = worldSize(zoom);
  return [lngFromMercatorX(point[0] / size), latFromMercatorY(point[1] / size)];
}

/** Wraps to `(-180, 180]`, the range MapLibre's `getBearing` reports. */
export function normalizeBearing(bearing: number): number {
  if (!isFiniteNumber(bearing)) {
    throw new TypeError(`bearing must be a finite number, got ${bearing}`);
  }
  const wrapped = ((((bearing + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 ? 180 : wrapped;
}

/** A screen-space offset (x right, y down) as a world-pixel offset at
 *  `bearing`: MapLibre draws the world turned by `-bearing`, so screen axes
 *  are the world axes turned by `+bearing`. */
export function rotateOffset(
  [x, y]: [number, number],
  bearing: number,
): [number, number] {
  const radians = (bearing * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [x * cos - y * sin, x * sin + y * cos];
}

/** World px at `v.zoom` under the viewport's screen point `[sx, sy]`. */
function screenToWorld(
  v: Viewport,
  [sx, sy]: [number, number],
): [number, number] {
  const [cx, cy] = project(v.center, v.zoom);
  const [dx, dy] = rotateOffset(
    [sx - v.width / 2, sy - v.height / 2],
    v.bearing ?? 0,
  );
  return [cx + dx, cy + dy];
}

function screenCorners(v: Viewport): [number, number][] {
  return [
    [0, 0],
    [v.width, 0],
    [v.width, v.height],
    [0, v.height],
  ];
}

export function fitBounds(
  bbox: Bbox,
  width: number,
  height: number,
  bearing = 0,
): Viewport {
  if (!isValidBbox(bbox)) {
    throw new TypeError(`Invalid bbox: ${JSON.stringify(bbox)}`);
  }
  if (!isFiniteNumber(width) || width <= 0) {
    throw new TypeError(`width must be a positive number, got ${width}`);
  }
  if (!isFiniteNumber(height) || height <= 0) {
    throw new TypeError(`height must be a positive number, got ${height}`);
  }

  const [west, south, east, north] = bbox;
  const left = mercatorX(west);
  const right = mercatorX(east);
  const top = mercatorY(north);
  const bottom = mercatorY(south);

  const zoom = Math.log2(
    Math.min(width / (right - left), height / (bottom - top)) / TILE_SIZE,
  );

  return {
    center: [
      lngFromMercatorX((left + right) / 2),
      latFromMercatorY((top + bottom) / 2),
    ],
    zoom,
    width,
    height,
    bearing: normalizeBearing(bearing),
  };
}

/** The viewport's corners as lng/lat in screen order: top-left, top-right,
 *  bottom-right, bottom-left. */
export function viewportCorners(
  v: Viewport,
): [LngLat, LngLat, LngLat, LngLat] {
  return screenCorners(v).map((corner) =>
    unproject(screenToWorld(v, corner), v.zoom),
  ) as [LngLat, LngLat, LngLat, LngLat];
}

export function viewportBbox(v: Viewport): Bbox {
  const corners = viewportCorners(v);
  const lngs = corners.map((c) => c[0]);
  const lats = corners.map((c) => c[1]);
  return [
    Math.min(...lngs),
    Math.min(...lats),
    Math.max(...lngs),
    Math.max(...lats),
  ];
}

export function fitsWorld(v: Viewport): boolean {
  const size = worldSize(v.zoom);
  const epsilon = size * 1e-9;
  const top = mercatorY(MAX_LATITUDE) * size - epsilon;
  const bottom = mercatorY(-MAX_LATITUDE) * size + epsilon;
  return screenCorners(v).every((corner) => {
    const [, y] = screenToWorld(v, corner);
    return y >= top && y <= bottom;
  });
}

export function tileGrid(
  v: Viewport,
  tile: { width: number; height: number },
): TileRect[] {
  assertPositiveInteger(v.width, "viewport width");
  assertPositiveInteger(v.height, "viewport height");
  assertPositiveInteger(tile.width, "tile width");
  assertPositiveInteger(tile.height, "tile height");

  const cols = Math.ceil(v.width / tile.width);
  const rows = Math.ceil(v.height / tile.height);

  const tiles: TileRect[] = [];
  for (let row = 0; row < rows; row++) {
    const y = row * tile.height;
    const height = Math.min(tile.height, v.height - y);
    for (let col = 0; col < cols; col++) {
      const x = col * tile.width;
      const width = Math.min(tile.width, v.width - x);
      tiles.push({
        col,
        row,
        x,
        y,
        width,
        height,
        center: unproject(
          screenToWorld(v, [x + width / 2, y + height / 2]),
          v.zoom,
        ),
      });
    }
  }
  return tiles;
}

export function mmToPx(mm: number, dpi: number, pixelRatio = 1): number {
  if (!isFiniteNumber(mm) || mm <= 0) {
    throw new TypeError(`mm must be a positive number, got ${mm}`);
  }
  if (!isFiniteNumber(dpi) || dpi <= 0) {
    throw new TypeError(`dpi must be a positive number, got ${dpi}`);
  }
  assertPositiveInteger(pixelRatio, "pixel ratio");
  const cssPx = Math.max(1, Math.round((mm / MM_PER_INCH) * dpi / pixelRatio));
  return cssPx * pixelRatio;
}
