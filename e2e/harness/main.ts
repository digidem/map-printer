import * as mapRenderer from "../../src/lib/map-renderer/index.ts";
import * as styles from "../../src/lib/styles/index.ts";
import * as viewport from "../../src/lib/viewport/index.ts";

const mapPrinter = { ...mapRenderer, ...viewport, ...styles };

declare global {
  interface Window {
    mapPrinter: typeof mapPrinter;
  }
}

window.mapPrinter = mapPrinter;
