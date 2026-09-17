# styles

Turns the one text input the app takes — a style URL, a Mapbox style link, a
tile URL template or a TileJSON URL — into something MapLibre can load, and
knows what has to be said about attribution.

Only types are imported from `maplibre-gl`, so the module runs in node and is
unit-tested there. Every network call goes through an injectable `fetch`.

## Contract

```ts
type StyleInput =
  | { kind: "style"; url: string; style: StyleSpecification }
  | { kind: "mapbox"; url: string; ref: MapboxStyleRef }
  | { kind: "raster"; url: string }
  | { kind: "tilejson"; url: string; tileKind: "vector" | "raster"; tilejson: TileJson };

resolveInput(text: string, fetchImpl?: FetchLike): Promise<StyleInput | null>
buildStyle(input: StyleInput, opts?: { mapboxToken?: string }): string | StyleSpecification
transformRequestFor(input: StyleInput, mapboxToken?: string): RequestTransformFunction | undefined
ensureOpaqueBackground(style: StyleSpecification): StyleSpecification
fetchAttribution(style, input, fetchImpl?, mapboxToken?): Promise<string[]>
```

### `resolveInput`

Mapbox style links (`mapbox://styles/…`, `api.mapbox.com/styles/v1/…`,
`studio.mapbox.com/styles/…`, with or without `/draft` and `?access_token=`)
and tile templates (`{z}/{x}/{y}` in any order, or `{quadkey}`) are recognised
from their shape alone — no request. `input.url` for a Mapbox style is always
the `mapbox://styles/{owner}/{id}[/draft]` form, and a token found in the
pasted URL is kept on `ref.accessToken`.

Anything else must be an `http(s)` URL to JSON: it is a MapLibre style and a
TileJSON with equal likelihood, so the JSON is fetched once and classified —
`version: 8` plus a `layers` array is a style, a `tiles` array or a `tilejson`
field is a TileJSON. A TileJSON is `vector` when its `format` is `pbf`/`mvt`
or it carries `vector_layers`, `raster` otherwise. The parsed JSON stays on
the result (`input.style` / `input.tilejson`) so no caller fetches it twice.

Returns `null` for empty input, a non-`http(s)` string, a failed or non-JSON
response, and JSON that is neither a style nor a TileJSON.

### `buildStyle`

What to pass MapLibre's `style` option or `setStyle`.

- `mapbox` — the style URL normalized to `api.mapbox.com` with the token
  (`opts.mapboxToken`, falling back to the token in the pasted URL); the bare
  `mapbox://` URI when there is no token, for `transformRequestFor` to rewrite.
- `style` — the URL, deliberately not the parsed JSON: MapLibre resolves
  relative sprite, glyph and source references against the style URL it
  loaded, which it cannot do for a style object.
- `raster` — a generated style with one raster source; `{s}`/`{subdomain}`
  expands to one URL per subdomain (`a`/`b`/`c` by default) so MapLibre
  round-robins. `{quadkey}` is left in place — MapLibre substitutes it itself.
- `tilejson` — a generated style whose single source carries the TileJSON
  `url`, vector or raster per `tileKind`. A vector TileJSON has no cartography
  of its own, so that style is just a background.

### `transformRequestFor`

A `RequestTransformFunction` that rewrites `mapbox://` sprite, glyph, source
and tile URLs to their `api.mapbox.com` endpoints with the token appended, and
passes everything else through. `undefined` for non-Mapbox input, so no other
provider's key is ever sent to Mapbox. Throws inside the transform if a
`mapbox://` URL comes up with no token.

### `ensureOpaqueBackground`

Prepends `OPAQUE_BACKGROUND_LAYER` (`{ id: "map-printer-background", type:
"background", paint: { "background-color": "#ffffff" } }`, also exported) when
the style has no background layer, and returns the style unchanged (same
object) when it has one — the renderer reads a premultiplied framebuffer, so
every exported pixel must be opaque. The renderer inserts the same layer into
styles it loads by URL, which `buildStyle` cannot rewrite.

### `fetchAttribution`

Deduplicated plain-text attribution, HTML tags and entities stripped, in
source order: every source's inline `attribution` first, then the
`attribution` of the TileJSON behind every source that has a `url`. Source
`url`s are resolved relative to the style URL, `mapbox://` ones are normalized
when a token is available, and any source whose TileJSON cannot be fetched or
carries no attribution is skipped.

`style` is passed separately from `input` because the loaded map style (with
its sources inlined) is a better source of attribution than the input was. The
already-parsed TileJSON on a `tilejson` input is reused instead of refetched.

The Mapbox terms text (`MAPBOX_TERMS_URL`, `MAPBOX_ATTRIBUTION`) is shown by
the UI only when `input.kind === "mapbox"`.

## Files

- `index.ts` — the public surface above.
- `mapbox.ts` — Mapbox URL parsing and `mapbox://` normalization, copied from
  map-downloader.
- `tile-url.ts` — tile-template detection, subdomain expansion and the two
  generated styles, copied from map-downloader's `preset-styles.ts`.
