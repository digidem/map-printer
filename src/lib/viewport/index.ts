export type LngLat = [lng: number, lat: number];
export type Bbox = [west: number, south: number, east: number, north: number];

export interface Viewport {
  center: LngLat;
  zoom: number;
  width: number;
  height: number;
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

export function project(lngLat: LngLat, zoom: number): [number, number] {
  const size = worldSize(zoom);
  return [mercatorX(lngLat[0]) * size, mercatorY(lngLat[1]) * size];
}

export function unproject(point: [number, number], zoom: number): LngLat {
  const size = worldSize(zoom);
  return [lngFromMercatorX(point[0] / size), latFromMercatorY(point[1] / size)];
}

export function fitBounds(bbox: Bbox, width: number, height: number): Viewport {
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
  };
}

export function viewportBbox(v: Viewport): Bbox {
  const [cx, cy] = project(v.center, v.zoom);
  const [west, north] = unproject([cx - v.width / 2, cy - v.height / 2], v.zoom);
  const [east, south] = unproject([cx + v.width / 2, cy + v.height / 2], v.zoom);
  return [west, south, east, north];
}

export function tileGrid(
  v: Viewport,
  tile: { width: number; height: number },
): TileRect[] {
  assertPositiveInteger(v.width, "viewport width");
  assertPositiveInteger(v.height, "viewport height");
  assertPositiveInteger(tile.width, "tile width");
  assertPositiveInteger(tile.height, "tile height");

  const [cx, cy] = project(v.center, v.zoom);
  const originX = cx - v.width / 2;
  const originY = cy - v.height / 2;

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
          [originX + x + width / 2, originY + y + height / 2],
          v.zoom,
        ),
      });
    }
  }
  return tiles;
}

export function mmToPx(mm: number, dpi: number): number {
  if (!isFiniteNumber(mm) || mm <= 0) {
    throw new TypeError(`mm must be a positive number, got ${mm}`);
  }
  if (!isFiniteNumber(dpi) || dpi <= 0) {
    throw new TypeError(`dpi must be a positive number, got ${dpi}`);
  }
  return Math.round((mm / MM_PER_INCH) * dpi);
}
