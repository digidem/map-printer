# Map Printer

Map Printer exports print-resolution PNGs of a map area entirely in the
browser. The page is rendered as a grid of tiles in a hidden MapLibre map and
streamed row by row through a PNG encoder straight to a download, so the output
can be far larger than fits in memory. It takes a MapLibre style URL, a raster
XYZ tile template, a TileJSON URL, or a Mapbox style with an access token.

Live at [map-printer.comapeo.app](https://map-printer.comapeo.app).

## Usage

Open the site, paste a map style or tile URL, set the bounding box to print,
the page size in mm and the target print DPI, tick the box confirming you will
include the attribution shown, and export. The PNG downloads as it is rendered.

Whatever you print must respect the licence of the map data you use, and
Mapbox styles are additionally subject to the Mapbox Terms of Service.

## Development

```bash
npm install             # Install dependencies
npm run dev             # Start dev server (Vite)
npm run build           # Production build
npm run preview         # Preview production build locally
npm run typecheck       # tsc --noEmit
npm test                # Unit tests (Vitest)
npm run test:e2e        # Playwright e2e tests
npm run test:e2e:install # Install the e2e browsers (once)
```

See [docs/architecture.md](docs/architecture.md) for the module layout and the
contract each module exposes.

## Deployment

The site is served as Cloudflare Worker static assets. Pushes to `main` deploy
automatically and pull requests get a preview URL; `npm run deploy` builds and
deploys manually.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
