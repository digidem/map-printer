import { Map as MapLibreMap } from "maplibre-gl";
import * as download from "../../src/lib/download/index.ts";
import * as exporter from "../../src/lib/export/index.ts";
import * as mapRenderer from "../../src/lib/map-renderer/index.ts";
import * as styles from "../../src/lib/styles/index.ts";
import * as viewport from "../../src/lib/viewport/index.ts";

/** Where MapLibre itself puts `points` on a map with this camera, so a test
 *  can pin the viewport module's rotation convention to the renderer's. */
function mapLibreProject(
  camera: viewport.Viewport,
  points: viewport.LngLat[],
): [number, number][] {
  const container = document.createElement("div");
  container.style.cssText =
    "position:fixed;top:0;left:-100000px;" +
    `width:${camera.width}px;height:${camera.height}px`;
  document.body.append(container);
  const map = new MapLibreMap({
    container,
    style: { version: 8, sources: {}, layers: [] },
    center: camera.center,
    zoom: camera.zoom,
    bearing: camera.bearing ?? 0,
    transformConstrain: (center, zoom) => ({ center, zoom }),
    interactive: false,
    attributionControl: false,
    trackResize: false,
  });
  try {
    return points.map((point) => {
      const { x, y } = map.project(point);
      return [x, y];
    });
  } finally {
    map.remove();
    container.remove();
  }
}

const mapPrinter = {
  ...mapRenderer,
  ...viewport,
  ...styles,
  ...download,
  ...exporter,
  mapLibreProject,
};

declare global {
  interface Window {
    mapPrinter: typeof mapPrinter;
  }
}

window.mapPrinter = mapPrinter;
download.registerDownloadWorker();
