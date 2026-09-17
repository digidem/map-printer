import { html, type PropertyValues } from "lit";
import {
  Map as MapLibreMap,
  NavigationControl,
  type ErrorEvent,
  type GeoJSONSource,
  type LayerSpecification,
  type RequestTransformFunction,
  type StyleSpecification,
} from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import { LightElement } from "./lit-base.ts";
import type { Bbox } from "./lib/viewport/index.ts";

export interface StyleErrorDetail {
  field: "style" | "token";
  message: string;
}

const EMPTY_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [],
};

const BBOX_SOURCE = "map-printer-bbox";

const BBOX_LAYER: LayerSpecification = {
  id: BBOX_SOURCE,
  type: "line",
  source: BBOX_SOURCE,
  layout: { "line-join": "miter" },
  paint: {
    "line-color": "rgb(255, 0, 0)",
    "line-opacity": 0.8,
    "line-width": 1,
    "line-dasharray": [3, 3],
  },
};

/** Right-hand pane: an interactive map at the paper's aspect ratio, with the
 *  export bbox drawn on it. */
export class PreviewMap extends LightElement {
  static properties = {
    mapStyle: { attribute: false },
    transformRequest: { attribute: false },
    bbox: { attribute: false },
    showBbox: { type: Boolean },
    aspect: { type: Number },
    usesToken: { type: Boolean },
  };

  declare mapStyle: string | StyleSpecification | null;
  declare transformRequest: RequestTransformFunction | undefined;
  declare bbox: Bbox;
  declare showBbox: boolean;
  declare aspect: number;
  /** Whether the current style is a Mapbox one, so a rejected request is the
   *  token's fault rather than the style's. */
  declare usesToken: boolean;

  /** Owned by MapLibre, so it is created once and interpolated into the
   *  template rather than rendered by Lit. */
  private container = document.createElement("div");
  private map?: MapLibreMap;
  private appliedStyle: string | StyleSpecification | null = null;
  private styleLoaded = false;
  private resizeObserver?: ResizeObserver;

  constructor() {
    super();
    this.mapStyle = null;
    this.transformRequest = undefined;
    this.bbox = [-180, -85, 180, 85];
    this.showBbox = true;
    this.aspect = 297 / 210;
    this.usesToken = false;
    this.container.className = "shadow-lg";
  }

  connectedCallback() {
    super.connectedCallback();
    this.className = "relative flex h-full w-full items-center justify-center";
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.resizeObserver?.disconnect();
    this.map?.remove();
    this.map = undefined;
  }

  render() {
    return html`${this.container}
      <button
        id="zoom-to-bbox"
        type="button"
        class="absolute top-2 right-2 rounded bg-white/90 px-2 py-1 text-xs text-blue-700 underline shadow"
        @click=${() => this.zoomToBbox()}
      >
        Zoom to bbox
      </button>`;
  }

  firstUpdated() {
    this.fitContainer();
    this.map = new MapLibreMap({
      container: this.container,
      style: EMPTY_STYLE,
      transformRequest: this.transformRequest,
      dragRotate: false,
      pitchWithRotate: false,
    });
    this.map.addControl(
      new NavigationControl({ showCompass: false }),
      "top-left",
    );
    this.map.on("style.load", () => this.onStyleLoad());
    this.map.on("error", (event) => this.onMapError(event));
    this.zoomToBbox(0);
    this.applyStyle();
    this.resizeObserver = new ResizeObserver(() => this.fitContainer());
    this.resizeObserver.observe(this);
  }

  updated(changed: PropertyValues<this>) {
    if (changed.has("aspect")) this.fitContainer();
    if (changed.has("transformRequest")) {
      this.map?.setTransformRequest(this.transformRequest ?? null);
    }
    if (changed.has("mapStyle")) this.applyStyle();
    if (changed.has("bbox") || changed.has("showBbox")) this.drawBbox();
  }

  zoomToBbox(duration?: number) {
    this.map?.fitBounds(
      [
        [this.bbox[0], this.bbox[1]],
        [this.bbox[2], this.bbox[3]],
      ],
      duration === undefined ? {} : { duration },
    );
  }

  /** Letterboxes the map inside the pane at the paper's aspect ratio. */
  private fitContainer() {
    const { width, height } = this.getBoundingClientRect();
    if (!width || !height) return;
    const boxWidth = Math.min(width, height * this.aspect);
    this.container.style.width = `${Math.round(boxWidth)}px`;
    this.container.style.height = `${Math.round(boxWidth / this.aspect)}px`;
    this.map?.resize();
  }

  private applyStyle() {
    if (!this.map || !this.mapStyle || this.mapStyle === this.appliedStyle) {
      return;
    }
    this.appliedStyle = this.mapStyle;
    this.styleLoaded = false;
    this.map.setStyle(this.mapStyle, { diff: false });
  }

  private onStyleLoad() {
    if (!this.map) return;
    this.styleLoaded = true;
    if (!this.map.getSource(BBOX_SOURCE)) {
      this.map.addSource(BBOX_SOURCE, {
        type: "geojson",
        data: emptyFeatures(),
      });
      this.map.addLayer(BBOX_LAYER);
    }
    this.drawBbox();
    this.dispatchEvent(
      new CustomEvent<StyleSpecification>("style-load", {
        detail: this.map.getStyle(),
      }),
    );
  }

  private drawBbox() {
    const source = this.map?.getSource(BBOX_SOURCE) as
      | GeoJSONSource
      | undefined;
    source?.setData(this.showBbox ? bboxFeatures(this.bbox) : emptyFeatures());
  }

  /** Marks the field that is wrong instead of tearing the map down, with
   *  `map-renderer`'s classification: a source error is a tile, and non-source
   *  errors after `style.load` leave a map that still renders. */
  private onMapError(event: ErrorEvent & { sourceId?: string }) {
    if (event.sourceId !== undefined || this.styleLoaded) {
      console.warn("Preview map error", event.error);
      return;
    }
    const status = (event.error as { status?: number }).status;
    if (this.usesToken && (status === 401 || status === 403)) {
      this.emitStyleError("token", "This access token was rejected.");
    } else {
      this.emitStyleError(
        "style",
        `This style could not be loaded: ${event.error.message}`,
      );
    }
  }

  private emitStyleError(field: StyleErrorDetail["field"], message: string) {
    this.dispatchEvent(
      new CustomEvent<StyleErrorDetail>("style-error", {
        detail: { field, message },
      }),
    );
  }
}

function emptyFeatures(): FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

function bboxFeatures([west, south, east, north]: Bbox): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [west, south],
              [east, south],
              [east, north],
              [west, north],
              [west, south],
            ],
          ],
        },
      },
    ],
  };
}

if (!customElements.get("preview-map")) {
  customElements.define("preview-map", PreviewMap);
}
