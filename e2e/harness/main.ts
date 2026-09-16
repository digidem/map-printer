import * as download from "../../src/lib/download/index.ts";
import * as exporter from "../../src/lib/export/index.ts";
import * as mapRenderer from "../../src/lib/map-renderer/index.ts";
import * as styles from "../../src/lib/styles/index.ts";
import * as viewport from "../../src/lib/viewport/index.ts";

const mapPrinter = {
  ...mapRenderer,
  ...viewport,
  ...styles,
  ...download,
  ...exporter,
};

declare global {
  interface Window {
    mapPrinter: typeof mapPrinter;
  }
}

window.mapPrinter = mapPrinter;
download.registerDownloadWorker();
