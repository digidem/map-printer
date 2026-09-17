# viewport

Web Mercator maths for turning a bbox and a pixel size into the camera a
MapLibre map needs, and into the grid of tiles that camera is rendered in.
Pure TypeScript — no maplibre import, no DOM, no dependencies.

All pixel values are CSS px (device pixels ÷ pixel ratio), which is the unit
MapLibre's `Map` sizes itself in.

## Zoom definition

The world is `512 · 2^zoom` CSS px square, with Mercator latitude clamped to
±85.051129. This matches maplibre-gl exactly — `Transform._tileSize = 512` and
`worldSize = tileSize · zoomScale(zoom)` in `src/geo/transform_helper.ts`,
`zoomScale(z) = 2^z` and `MAX_VALID_LATITUDE = 85.051129` in `src/util/util.ts`,
and the projection formulae in `src/geo/mercator_coordinate.ts` — so a MapLibre
map of `width × height` CSS px given `fitBounds(bbox, width, height)`'s center
and zoom shows exactly `bbox` on the limiting axis, **provided the viewport
fits inside the Mercator world**. MapLibre constrains the camera to the
±85.051129 latitude range and silently moves the center of a viewport taller
than the world, which would render a region the tile grid does not describe.
Check `fitsWorld(v)` before rendering.

## API

```ts
type LngLat = [lng: number, lat: number];
type Bbox = [west: number, south: number, east: number, north: number];
type Viewport = {
  center: LngLat; zoom: number; width: number; height: number;
  bearing?: number;   // degrees clockwise from north up, as MapLibre's; 0 when absent
};
type TileRect = {
  col: number; row: number;
  x: number; y: number; width: number; height: number;
  center: LngLat;
};
```

### `isValidBbox(b: unknown): b is Bbox`

True for an array of four finite numbers with `-180 ≤ west < east ≤ 180` and
`-85.051129 ≤ south < north ≤ 85.051129`. Latitudes outside the Mercator limit
are rejected rather than clamped: they cannot be printed, and clamping would
silently break `viewportBbox(fitBounds(b))` containing `b`. Bboxes crossing the
antimeridian are not supported. Callers parsing user input should run the bbox
through `clampBbox` first, since `-180,-90,180,90` is the usual way to write a
whole-world bbox.

### `clampBbox(b: Bbox): Bbox`

The same bbox with its latitudes clamped to ±85.051129.

### `project(lngLat, zoom) → [x, y]` / `unproject([x, y], zoom) → LngLat`

World pixels at `zoom`, origin at the north-west corner of the world. Latitude
is clamped to ±85.051129; longitude is not wrapped, so a longitude outside
±180 projects outside the world square.

### `fitBounds(bbox, width, height, bearing = 0) → Viewport`

The largest zoom at which `bbox` fits in `width × height` CSS px north-up,
with no padding and no maximum zoom, centred on the bbox's Mercator midpoint.
The zoom is fractional. `bearing` does not change the zoom or centre: the page
turns about the bbox centre, so at most angles part of the bbox falls off it.
Throws `TypeError` on an invalid bbox, a non-positive size or a non-finite
bearing.

### `normalizeBearing(deg) → number`

Wrapped to `(-180, 180]`, the range MapLibre's `getBearing` reports.

### `rotateOffset([x, y], bearing) → [x, y]`

A screen-space offset (x right, y down, CSS px) as the world-pixel offset it
covers on a map at `bearing`. MapLibre draws the world turned by `-bearing`,
so the screen axes are the world axes turned by `+bearing`; passing
`-bearing` goes the other way. The identity at bearing 0.

### `viewportCorners(v) → [LngLat, LngLat, LngLat, LngLat]`

The lng/lat under the viewport's corners in screen order: top-left,
top-right, bottom-right, bottom-left. At bearing 0 these are the north-west,
north-east, south-east and south-west corners of `viewportBbox(v)`.

### `viewportBbox(v) → Bbox`

The envelope of `viewportCorners(v)`: at bearing 0 the bbox `fitBounds` was
given, grown on the non-limiting axis; for a turned page, the axis-aligned
box around it. West/east may fall outside ±180, and north/south outside
±85.051129, when the viewport is larger than the world at that zoom.

### `fitsWorld(v: Viewport): boolean`

Whether every corner of the viewport lies within the ±85.051129 latitude
band. When false, the page leaves the world at that zoom — taller than it
north-up, or turned so that a corner crosses the limit — and must be rejected
or letterboxed by the caller.

### `tileGrid(v, tile) → TileRect[]`

Row-major list of render rects covering the viewport exactly: no gaps, no
overlap. `x`, `y`, `width` and `height` are integer CSS px within the viewport;
right and bottom edge tiles are smaller than `tile` by the remainder. `center`
is the lng/lat under the rect's own pixel centre at `v.zoom` and `v.bearing`,
so rendering each rect as a map of `width × height` CSS px centred there, at
the same zoom and bearing, makes the tiles abut exactly: MapLibre turns the
map rigidly about the screen centre, so a smaller map centred on the point
under a sub-rectangle's centre shows exactly that sub-rectangle.

The viewport and tile sizes must be positive integers — `TypeError` otherwise.
Rounding a fractional CSS size is the caller's decision, because the pixel
count of the exported PNG depends on it.

### `mmToPx(mm, dpi, pixelRatio = 1) → number`

`mm / 25.4 · dpi` in device pixels, rounded to a whole multiple of
`pixelRatio` (which must be a positive integer) so that the CSS size callers
derive as `px / pixelRatio` is a whole number too — otherwise `tileGrid`
would reject it. Never returns zero.
