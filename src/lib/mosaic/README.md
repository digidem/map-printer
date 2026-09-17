# mosaic

Composes a grid of rendered tiles into full-width scanlines, a band of tiles at
a time, as a pull-based `ReadableStream`.

```ts
createMosaic(opts: {
  width: number; height: number; channels: 3 | 4;
  tiles: readonly T[];                     // row-major, T extends MosaicTile
  render: (tile: T) => Promise<Uint8Array>; // tile.width*tile.height*channels bytes, top-down
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}): ReadableStream<Uint8Array>

type MosaicTile = { col: number; row: number; x: number; y: number; width: number; height: number };
```

The tile type is a generic parameter constrained to `MosaicTile`, so
`viewport.tileGrid()` rects (which carry an extra `center`) reach `render`
with that field intact, without this module importing `viewport`. The rect fields are in
output pixels, and the module is otherwise unit-agnostic.

## Behaviour

A band is all tiles sharing a `row`. Work happens in `pull`: when the current
band is exhausted, the next band's tiles are rendered sequentially via
`render`, composed into one band buffer, and then emitted as whole scanlines.
Only one band is held at a time, and because rendering happens in `pull`, a
slow consumer stalls it — the consumer's backpressure is the rate limit.

Chunks are always a whole number of scanlines of `width * channels` bytes, up
to about 256 KiB per chunk, so a band of tall tiles is emitted over several
pulls. `onProgress` is called with `bandsDone / bandCount` after each band, so
it reaches exactly `1` when the last band is composed.

## Errors

The stream errors, before any `render` call, if `width`/`height` are not
positive integers, `channels` is not 3 or 4, or the tiles do not tile
`width × height` exactly: row-major `col`/`row` indices, tiles abutting at
`x`/`y`, one height per band, each band spanning the full width and the bands
spanning the full height.

Later, the stream errors if `render` rejects or returns a result whose length
is not `tile.width * tile.height * channels`.

## Cancellation

Aborting `signal` errors the stream with `signal.reason`; cancelling the
readable from the consumer ends it quietly. Either way no further `render`
calls are made — an in-flight one is awaited but its result is dropped.
