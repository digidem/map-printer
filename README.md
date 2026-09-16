# map-printer

Export maps in the browser.

Download massive hi-res PNGs from map styles without memory limits.

This is a rewrite in progress: the app is being rebuilt on Vite + TypeScript
and MapLibre. See [docs/architecture.md](docs/architecture.md) for the design.
The old build at [map-printer.ddem.us](https://map-printer.ddem.us/) is the
previous version; a new deploy target is coming.

## Usage

```
git clone https://github.com/digidem/map-printer.git
npm install
npm run dev     # dev server
npm run build   # production build to dist/
npm test        # unit tests
```

## License
MIT
