# export

Composes `viewport`, `map-renderer`, `mosaic`, `png-encoder` and `download`
into the one call the UI makes. Browser only, covered by `e2e/export.test.ts`.

```ts
exportMap(opts: {
  style: string | StyleSpecification;
  transformRequest?: RequestTransformFunction;
  bbox: Bbox;
  widthPx: number; heightPx: number;   // device px
  pixelRatio: number;                  // positive integer
  bearing?: number;                    // degrees clockwise from north up, default 0
  filename: string;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  tileSize?: { width: number; height: number };  // test-only
}): Promise<{ bbox: Bbox; corners: [LngLat, LngLat, LngLat, LngLat]; zoom: number; bearing: number }>
```

Resolves once the browser has read the last byte of the download out of the
service worker (or after 60 s if a pre-protocol-2 worker never says so), with
the corners of the page in screen order from the top-left, their envelope as
`bbox` (north-up, that is `bbox` grown on the non-limiting axis), and the zoom
and bearing it was rendered at. On iOS the file may still be flushing to disk
for a moment after that.

`bearing` turns the page about the centre of `bbox` without changing the zoom
`bbox` fits at north-up, so at most angles the corners of `bbox` fall off the
page; the UI draws the page outline on the preview for that reason.

## Sizes

`widthPx`/`heightPx` are the pixel dimensions of the PNG. The map is laid out
in CSS px, so both must be whole multiples of `pixelRatio` — which the UI
guarantees by taking its sizes from `viewport.mmToPx` — and the CSS viewport is
`px / pixelRatio`. A page that leaves the Mercator world at its zoom — taller
than it, or turned so a corner crosses the latitude limit — is rejected rather
than rendered, because there is nothing to draw there (see
`viewport.fitsWorld`).

Tiles are as wide as the GPU allows (`map-renderer.maxTileSize`) but never
wider than the viewport, so most exports are a single column. Their height is
the largest that keeps every pixel buffer alive while a band is composed under
64 MiB together: the band `mosaic` holds
(`cols × tileW × tileH × pixelRatio² × 3` bytes), plus the tile `map-renderer`
has just returned and the RGBA `readPixels` scratch it came out of
(`tileW × tileH × pixelRatio² × (3 + 4)`). `tileSize` overrides both; it
exists so the e2e tests can force a multi-tile grid at a size a test machine
renders quickly, and the UI never passes it.

`mosaic` works in output pixels while `map-renderer.render` takes CSS px, so
each tile is handed to `mosaic` scaled by `pixelRatio` with its unscaled
`tileGrid` rect carried along as `css`.

## Progress, cancellation and cleanup

`onProgress` is `mosaic`'s: bands composed over bands total, reaching 1 as the
last band is rendered rather than as the last byte is written.

Aborting `signal` stops the mosaic and aborts the download, so the browser
reports a failed download instead of leaving a truncated PNG. Any other
failure does the same, and removes the download's iframe. After success the
iframe is left in place: iOS Safari finalises a download when its initiating
frame is removed, even while accepted bytes are still being flushed to disk.
The renderer is destroyed in `finally`, whatever happened.
