# Map Printer architecture

Map Printer exports print-resolution PNGs of a map area entirely in the
browser. The output can be far larger than fits in memory (tens of thousands
of pixels on a side), so the page is rendered as a grid of tiles in a hidden
MapLibre map and the pixels are streamed row by row through a PNG encoder to
a download, never holding more than one band of tiles at a time.

It is a static site: Vite + TypeScript, Lit (light DOM) + Tailwind for the UI,
maplibre-gl for rendering, deployed as Cloudflare Worker static assets. There
is no server other than the tile servers the map style points at.

## Data flow

```
settings (URL, bbox, mm, dpi)
  │
  ▼
styles/        resolve URL → MapLibre style + attribution + transformRequest
  │
  ▼
viewport/      bbox + px size → {center, zoom}; tile grid → per-tile centers
  │
  ▼
map-renderer/  hidden MapLibre map, one tile at a time → Uint8Array RGB rows
  │
  ▼
mosaic/        band of tiles → full-width scanlines   (ReadableStream)
  │
  ▼
png-encoder/   scanlines → PNG bytes                   (TransformStream)
  │
  ▼
download/      PNG bytes → service-worker download     (WritableStream)
```

`export/` composes the five modules into one `exportMap()` call the UI uses.
Everything after the renderer is Web Streams with backpressure, so rendering
pauses while the browser writes to disk, and the memory high-water mark is
one band of tiles, the tile just rendered and a few compressed chunks.

## Modules

Each module lives in `src/lib/<name>/` with `index.ts` (the only public
surface), a short `README.md` stating the contract, and `*.test.ts` unit
tests where the module is pure. Modules import only from modules listed
below them in the data flow, never sideways into the UI.

### `png-encoder` (pure, unit-tested)

```ts
createPngEncoder(opts: {
  width: number; height: number;
  channels: 3 | 4;            // RGB or RGBA input, same colour type out
  filter?: "none" | "sub";    // default "sub"
}): TransformStream<Uint8Array, Uint8Array>
```

Input: raw pixel bytes, top-down, any chunking (a chunk may end mid-row).
Output: a complete PNG file: signature, IHDR, IDAT chunks, IEND.
Compression is one `CompressionStream("deflate")` for the whole image (its
output is the zlib stream IDAT requires). IDAT chunks are cut from the
compressor output as it arrives. CRC32 is a small table implementation.

Errors: the stream errors if more or fewer bytes than
`width * height * channels` arrive, or if `width`/`height` are not positive
integers. Aborting the readable side cancels the compressor.

Tests: round-trip through a decoder (`fast-png`, dev dependency) for both
filters and channel counts, chunk boundaries that split rows, 1×1 and
wide-short images, and the byte-count errors.

### `viewport` (pure, unit-tested)

Web Mercator maths matching MapLibre (world size `512 · 2^zoom` CSS px,
latitude clamped to ±85.051129). No maplibre import.

```ts
type Bbox = [west: number, south: number, east: number, north: number];
type Viewport = { center: [lng, lat]; zoom: number; width: number; height: number }; // CSS px

isValidBbox(b: unknown): b is Bbox
fitBounds(bbox: Bbox, width: number, height: number): Viewport   // no padding
viewportBbox(v: Viewport): Bbox                                   // what the viewport actually covers
project(lngLat, zoom): [x, y]  /  unproject([x, y], zoom): [lng, lat]  // world px at zoom
tileGrid(v: Viewport, tile: { width: number; height: number }): TileRect[]
  // row-major list of { col, row, x, y, width, height, center: [lng, lat] }
  // x/y/width/height in CSS px of the full viewport; edge tiles are smaller
mmToPx(mm: number, dpi: number): number
```

Tile centers are computed at the viewport zoom in world pixel space so tiles
abut exactly at integer pixel boundaries.

### `mosaic` (pure, unit-tested)

```ts
createMosaic(opts: {
  width: number; height: number; channels: 3 | 4;
  tiles: TileRect[];                   // from viewport.tileGrid, row-major
  render: (tile: TileRect) => Promise<Uint8Array>;  // tile.width*tile.height*channels bytes, top-down
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}): ReadableStream<Uint8Array>         // chunks are whole scanlines, width*channels bytes each (may be several rows)
```

Pull-based. For each band (all tiles sharing a `row`), renders the tiles
sequentially, then emits the band's scanlines by concatenating each tile's
row. Only one band is held in memory. Rows are emitted in pull, so a slow
consumer stalls rendering. Abort cancels the stream and stops calling
`render`.

Tests: fake `render` that fills each tile with a value derived from
`(col, row)`, assert the composed output pixel-for-pixel for 1×1, 1×n,
n×1 and n×m grids with ragged edges; abort mid-way stops further renders;
a `render` rejection errors the stream.

### `styles` (mostly pure, unit-tested)

Turns the one text input into something MapLibre can load, and knows what
to say about attribution.

```ts
type StyleInput =
  | { kind: "style"; url: string }            // MapLibre style.json URL
  | { kind: "mapbox"; url: string; ref: MapboxStyleRef }   // needs a token
  | { kind: "raster"; url: string }           // {z}/{x}/{y} or {quadkey} template
  | { kind: "tilejson"; url: string };

classifyInput(text: string): StyleInput | null
buildStyle(input: StyleInput, opts: { mapboxToken?: string }): string | StyleSpecification
transformRequestFor(input, mapboxToken?): RequestTransformFunction | undefined
ensureOpaqueBackground(style: StyleSpecification): StyleSpecification  // prepends a white background layer if none
fetchAttribution(style, input): Promise<string[]>   // inline source attribution + TileJSON attribution, HTML stripped
```

`mapbox.ts`, `isTileUrlTemplate`, `rasterStyleForTileUrl` and
`styleForTileJson` are copied from map-downloader. The Mapbox terms text is
shown only when `kind === "mapbox"`.

### `map-renderer` (browser only, covered by e2e)

```ts
createMapRenderer(opts: {
  style: string | StyleSpecification;
  pixelRatio: number;                  // dpi / 96, need not be an integer
  tileSize: { width: number; height: number };  // CSS px; all tiles rendered at this size
  channels: 3 | 4;
  transformRequest?: RequestTransformFunction;
  renderTimeoutMs?: number;            // default 60_000
}): Promise<MapRenderer>

interface MapRenderer {
  render(tile: TileRect, zoom: number): Promise<Uint8Array>; // cropped to tile.width/height, top-down
  destroy(): void;
}
maxTileSize(pixelRatio: number): { width: number; height: number }  // from a probe WebGL2 context
```

One hidden `maplibregl.Map`, created once and reused for every tile:

- container `position: fixed; left: -100000px`, sized `tileSize` (never
  `display: none`, which makes MapLibre fall back to 400×300).
- options: `pixelRatio`, `canvasContextAttributes: { preserveDrawingBuffer: true }`,
  `maxCanvasSize` from the probe's `MAX_TEXTURE_SIZE`, `fadeDuration: 0`,
  `trackResize: false`, `interactive: false`, `attributionControl: false`.
- after construction, assert `canvas.width === floor(tileSize.width * pixelRatio)`
  or throw: MapLibre silently lowers the pixel ratio when a canvas is too big.
- `render`: register `once("idle")` before `jumpTo({ center, zoom })`, race it
  against `renderTimeoutMs` and against any `error` event whose source is a
  tile or the style; then `gl.readPixels` into a reusable scratch buffer,
  flip rows (WebGL is bottom-up), drop alpha when `channels === 3`, crop to
  the tile rect, and return a fresh `Uint8Array`.
- `render` takes the CSS-px rect from `tileGrid` and returns
  `floor(tile.width · pixelRatio) × floor(tile.height · pixelRatio)` pixels, so
  `export` hands `mosaic` (whose rects are output pixels) the rects scaled by
  `pixelRatio` and `render` the unscaled ones.
- an `error` event carrying a `sourceId` fails the render waiting on it and is
  not latched; any other error is fatal before `style.load` (the style itself
  failed) and ignored after it (sprite, image and layer-validation errors leave
  a map that renders).
- the framebuffer is premultiplied; the style is passed through
  `ensureOpaqueBackground` so every pixel is opaque and no un-premultiply is
  needed. RGB output is the default for print.
- `document.visibilityState === "hidden"` stalls MapLibre's render loop; the
  renderer just lets the timeout surface it with a clear message.

### `download` (browser only, covered by e2e)

Port of map-downloader's service-worker streaming download
(`public/sw.js` + the page-side handshake). Kept verbatim where possible.

```ts
registerDownloadWorker(): void               // at startup; also startMessages()
downloadReady(): Promise<void>               // resolves once a worker controls the page
startDownload(opts: { filename: string; contentType: string }): Promise<{ writable: WritableStream<Uint8Array>; complete: Promise<void>; cleanup(): void }>
  // complete: the worker has seen the browser read the last chunk (protocol 2)
```

`downloadReady()` rejects if registering the worker failed, so the UI is not
left waiting for a `controllerchange` that is never coming.

`startDownload` inserts the hidden iframe synchronously before any `await`
(Safari user activation), waits for the worker's `downloadStarted` ack, then
returns a `WritableStream` backed by the MessagePort sink (one `PULL` credit
per `WRITE`, so the service worker's 4-chunk queue is the backpressure
boundary). Aborting the writable errors the response so the browser shows a
failed download instead of a truncated file. The iframe is only removed on
failure, or when the next download starts: iOS Safari finalises a download
when its initiating frame goes away, even while accepted bytes are still
being flushed to disk.

### `export` (browser only, covered by e2e)

```ts
exportMap(opts: {
  style: string | StyleSpecification; transformRequest?;
  bbox: Bbox; widthPx: number; heightPx: number; pixelRatio: number;
  filename: string;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}): Promise<{ bbox: Bbox; zoom: number }>   // resolves when the download is fully written
```

Computes the viewport (CSS size = px / pixelRatio), chooses the tile size
(width = min(maxTileSize.width, viewport width); height so the band plus the
renderer's returned tile and its RGBA scratch,
`tileW × tileH × pixelRatio² × (3·cols + 3 + 4)` bytes, stay under 64 MiB),
builds the renderer,
and pipes `mosaic → png-encoder → download`. Always destroys the renderer
and cleans up the download in `finally`.

## UI (`src/`)

`main.ts` registers the service worker and mounts two Lit components in
light DOM (so Tailwind applies): `<settings-form>` and `<preview-map>`. The
layout and fields match the previous app: style/tile URL, Mapbox token
(shown only for Mapbox URLs), width and height in mm, bbox `W,S,E,N`,
preview-bbox toggle, DPI select (96/192/288/384), the "exports at zoom Z,
W×H px" line, the attribution text with one "I will include this
attribution" checkbox, Export / Cancel and a progress bar.

Settings persist to `localStorage` under `map-printer-settings`, parsed
defensively (defaults merged, invalid values replaced). Validation is
inline: invalid fields are marked and Export is disabled until they pass.

The preview map is a normal interactive MapLibre map sized to the paper
aspect ratio with a dashed bbox overlay, plus MapLibre's attribution
control. Style errors (bad URL, bad token) mark the field instead of
tearing down the map.

Unsupported browsers (no `CompressionStream`, `ReadableStream`, service
worker or WebGL2) get a message instead of a form. Safari 16.4+, Chrome
80+ and Firefox 113+ are supported.

## Testing

- `vitest` (node) for the pure modules: `src/lib/**/*.test.ts`.
- `vitest` + Playwright library for e2e in `e2e/`, mirroring map-downloader:
  a `vite preview` server on port 4174 started in `globalSetup`, one shared
  test body run under chromium (ANGLE metal on macOS, SwiftShader on
  Linux), firefox (local only) and webkit. The preview server also serves
  `e2e/fixtures/` at `/fixtures/`, which holds a self-contained MapLibre
  style (background + an inline GeoJSON polygon) and a tiny raster tile
  set, so tests need no network. Tests export a small map and a
  multi-tile map, capture the download, decode it with `fast-png`, and
  assert dimensions and expected pixel colours at projected positions.
- GitHub Actions runs typecheck, unit tests, build and the chromium +
  webkit e2e on push and PR.

## Deployment

The site is served at https://map-printer.comapeo.app as Cloudflare Worker
static assets: `wrangler.jsonc` serves `dist/` on that custom domain, with no
worker script. Pushes to `main` deploy automatically through Cloudflare's
Workers Builds, and pull requests get a preview URL; that connection is
configured in the Cloudflare dashboard rather than in this repo.
`public/_headers` sets `Cache-Control: no-cache` on `sw.js`, `index.html` and
`/` so a new service worker propagates immediately. `npm run deploy` still
builds and deploys manually with wrangler.
