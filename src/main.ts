import "./style.css";
import "maplibre-gl/dist/maplibre-gl.css";
import { html, render, type TemplateResult } from "lit";
import type { StyleSpecification } from "maplibre-gl";
import { downloadReady, registerDownloadWorker } from "./lib/download/index.ts";
import { exportMap } from "./lib/export/index.ts";
import {
  buildStyle,
  fetchAttribution,
  resolveInput,
  transformRequestFor,
} from "./lib/styles/index.ts";
import { mmToPx } from "./lib/viewport/index.ts";
import { PreviewMap, type StyleErrorDetail } from "./preview-map.ts";
import { SettingsForm } from "./settings-form.ts";
import { loadSettings, saveSettings, type Settings } from "./settings.ts";

/** Long enough that typing a URL does not fetch on every keystroke. */
const RESOLVE_DELAY_MS = 400;
const SAVED_MESSAGE_MS = 4_000;

const app = document.querySelector<HTMLElement>("#app");
if (app) {
  if (isSupported()) start(app);
  else render(unsupported(), app);
}

function start(app: HTMLElement) {
  registerDownloadWorker();
  let settings = loadSettings();

  const form = new SettingsForm();
  form.settings = settings;
  const preview = new PreviewMap();
  preview.bbox = settings.bbox;
  preview.showBbox = settings.previewBbox;
  preview.aspect = settings.width / settings.height;

  render(
    html`<div class="flex min-h-dvh flex-col md:h-dvh md:flex-row">
      <div
        class="w-full shrink-0 border-b border-gray-200 p-4 md:h-full md:w-90 md:overflow-y-auto md:border-r md:border-b-0"
      >
        ${form}
      </div>
      <div class="h-96 md:h-full md:min-h-0 md:flex-1">${preview}</div>
    </div>`,
    app,
  );

  downloadReady().then(
    () => {
      form.downloadReady = true;
    },
    (err: unknown) => {
      form.message = { kind: "error", text: describe(err) };
    },
  );

  let resolveSeq = 0;
  let resolveTimer: ReturnType<typeof setTimeout> | undefined;
  let savedTimer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;

  form.addEventListener("settings-change", (event) => {
    const next = (event as CustomEvent<Settings>).detail;
    const styleChanged = next.style !== settings.style;
    const tokenChanged = next.mapboxToken !== settings.mapboxToken;
    settings = next;
    saveSettings(settings);
    preview.bbox = settings.bbox;
    preview.showBbox = settings.previewBbox;
    preview.aspect = settings.width / settings.height;
    if (styleChanged || tokenChanged) {
      // Dropping `styleInput` unmounts the token field, so a token edit keeps
      // the resolved input and only the style text clears it.
      if (styleChanged) form.styleInput = null;
      form.styleError = null;
      form.tokenError = null;
      form.attribution = [];
      clearTimeout(resolveTimer);
      resolveTimer = setTimeout(() => void resolveStyle(), RESOLVE_DELAY_MS);
    }
  });

  preview.addEventListener("style-load", (event) => {
    const loaded = (event as CustomEvent<StyleSpecification>).detail;
    const input = form.styleInput;
    if (!input) return;
    form.styleError = null;
    form.tokenError = null;
    void fetchAttribution(loaded, input, undefined, settings.mapboxToken).then(
      (attribution) => {
        if (form.styleInput === input) form.attribution = attribution;
      },
    );
  });

  preview.addEventListener("style-error", (event) => {
    const { field, message } = (event as CustomEvent<StyleErrorDetail>).detail;
    if (field === "token") form.tokenError = message;
    else form.styleError = message;
  });

  form.addEventListener("export-request", () => void runExport());
  form.addEventListener("export-cancel", () =>
    controller?.abort(new Error("Export cancelled")),
  );

  void resolveStyle();

  async function resolveStyle() {
    const seq = ++resolveSeq;
    const { mapboxToken } = settings;
    const input = await resolveInput(settings.style);
    if (seq !== resolveSeq) return;
    if (!input) {
      form.styleError =
        "This is not a map style, TileJSON or tile URL that can be loaded.";
      return;
    }
    if (input.kind === "mapbox" && !(mapboxToken || input.ref.accessToken)) {
      form.styleInput = input;
      form.tokenError = "This style needs a Mapbox access token.";
      return;
    }
    form.styleInput = input;
    preview.transformRequest = transformRequestFor(input, mapboxToken);
    preview.mapStyle = buildStyle(input, { mapboxToken });
  }

  async function runExport() {
    const input = form.styleInput;
    if (!input) return;
    const { bbox, dpi, height, mapboxToken, width } = settings;
    const pixelRatio = dpi / 96;
    controller = new AbortController();
    clearTimeout(savedTimer);
    form.message = null;
    form.progress = 0;
    form.exporting = true;
    try {
      await exportMap({
        style: buildStyle(input, { mapboxToken }),
        transformRequest: transformRequestFor(input, mapboxToken),
        bbox,
        widthPx: mmToPx(width, dpi, pixelRatio),
        heightPx: mmToPx(height, dpi, pixelRatio),
        pixelRatio,
        filename: `map-${width}x${height}mm-${dpi}dpi.png`,
        onProgress: (fraction) => {
          form.progress = fraction;
        },
        signal: controller.signal,
      });
      form.message = { kind: "success", text: "Saved" };
      savedTimer = setTimeout(() => {
        form.message = null;
      }, SAVED_MESSAGE_MS);
    } catch (err) {
      form.message = { kind: "error", text: describe(err) };
    } finally {
      form.exporting = false;
      form.progress = 0;
      controller = undefined;
    }
  }
}

function unsupported(): TemplateResult {
  return html`<div class="mx-auto max-w-md p-8 text-center">
    <h1 class="mb-2 text-xl font-semibold text-gray-900">Map Printer</h1>
    <p class="text-sm text-gray-700">
      This browser cannot export maps. Map Printer needs service workers,
      streaming compression and WebGL2 — Chrome 80+, Firefox 113+ or Safari
      16.4+ will work.
    </p>
  </div>`;
}

function isSupported(): boolean {
  return (
    typeof CompressionStream === "function" &&
    typeof ReadableStream === "function" &&
    "serviceWorker" in navigator &&
    hasWebGL2()
  );
}

function hasWebGL2(): boolean {
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    return gl !== null;
  } catch {
    return false;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
