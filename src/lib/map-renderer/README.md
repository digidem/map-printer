# map-renderer

One hidden `maplibregl.Map`, created once and reused to render every tile of
an export as raw top-down pixel rows. Browser only, covered by the e2e tests
in `e2e/map-renderer.test.ts`.

Importing the module calls `setWorkerUrl` with Vite's `?worker&url` import of
`maplibre-gl-worker.mjs`, so every consumer gets a working MapLibre worker
under the ES-module worker format the Vite config sets.

## Contract

```ts
createMapRenderer(opts: {
  style: string | StyleSpecification;
  pixelRatio: number;                            // dpi / 96, need not be an integer
  tileSize: { width: number; height: number };   // CSS px; the hidden map's fixed size
  channels: 3 | 4;
  transformRequest?: RequestTransformFunction;
  renderTimeoutMs?: number;                      // default 60_000
}): Promise<MapRenderer>

interface MapRenderer {
  render(tile: TileRect, zoom: number): Promise<Uint8Array>;
  destroy(): void;
}

maxTileSize(pixelRatio: number): { width: number; height: number }   // CSS px
```

### `createMapRenderer`

Resolves once the style has loaded, or rejects (and tears the map down) if
MapLibre reports an error first, the style does not load within
`renderTimeoutMs`, or the canvas MapLibre created is not
`floor(tileSize × pixelRatio)` device px — MapLibre silently lowers the pixel
ratio when a canvas exceeds `maxCanvasSize` or the GPU's limits, so a smaller
canvas means the tile is too large for this machine (see `maxTileSize`).

The map options are `pixelRatio`, `maxCanvasSize` set to the expected canvas
size (MapLibre's default is 4096×4096, which would clamp larger tiles),
`canvasContextAttributes: { preserveDrawingBuffer: true }`, `fadeDuration: 0`,
`trackResize: false`, `interactive: false`, `attributionControl: false`. The
container is `position: fixed; left: -100000px` with an explicit size — never
`display: none`, which makes MapLibre fall back to 400×300.

MapLibre's WebGL2 context is premultiplied, so every exported pixel has to be
opaque. A `StyleSpecification` is passed through `styles.ensureOpaqueBackground`
before construction; a style URL (which `styles.buildStyle` returns for plain
styles so relative sprite, glyph and source references resolve) gets the same
`OPAQUE_BACKGROUND_LAYER` inserted below its first layer on `style.load` when
it has no background layer.

### `render(tile, zoom)`

`tile` is a `viewport.tileGrid` rect at most `tileSize` in each dimension. The
map jumps to the center that puts the rect in the canvas's top-left corner
(`tile.center` shifted by half the difference between `tileSize` and the rect,
so an edge tile is cropped at the origin rather than at a fractional offset),
waits for MapLibre's `idle` event and reads the pixels inside that handler,
before any later frame can repaint the preserved drawing buffer. The result is
a fresh `Uint8Array` of `floor(tile.width × pixelRatio) ×
floor(tile.height × pixelRatio) × channels` bytes, rows top-down (WebGL reads
bottom-up), alpha dropped when `channels === 3`.

`idle` is registered before `jumpTo` because it fires synchronously inside a
render frame as soon as nothing is dirty. Renders are sequential: calling
`render` while one is in flight rejects.

### Errors

MapLibre still fires `idle` when tiles or sources have failed, so the renderer
listens to the map's `error` event for the renderer's whole life. The first
error fails the in-flight render and every later one, with the source id in
the message for tile and source errors. Missing sprite images are console
warnings in MapLibre, not error events, so they do not fail a render; a style
that fails to load, a TileJSON or tile request that fails (other than a 404,
which MapLibre treats as an empty tile) or an invalid style does.

A render that does not reach `idle` within `renderTimeoutMs` rejects with a
timeout error that names the tile. `document.visibilityState === "hidden"`
stalls MapLibre's render loop, so the message says so when the tab is hidden.

### `maxTileSize(pixelRatio)`

Creates a probe WebGL2 context, reads `MAX_TEXTURE_SIZE`, caps it at 8192
device px, releases the context via `WEBGL_lose_context` and returns
`floor(min / pixelRatio)` CSS px for both axes: the largest `tileSize` this
machine can render at that pixel ratio.
