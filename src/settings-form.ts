import { html, nothing, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { LightElement } from "./lit-base.ts";
import {
  MAPBOX_ATTRIBUTION,
  MAPBOX_TERMS_URL,
  type StyleInput,
} from "./lib/styles/index.ts";
import { fitBounds, fitsWorld, mmToPx } from "./lib/viewport/index.ts";
import {
  DEFAULT_SETTINGS,
  DPI_OPTIONS,
  formatBbox,
  parseBbox,
  parseBearing,
  type Dpi,
  type Settings,
} from "./settings.ts";

export interface ExportMessage {
  kind: "error" | "success";
  text: string;
}

const LABEL = "block text-sm font-medium text-gray-700";
const INPUT =
  "mt-1 block w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none";
const INVALID_INPUT = "border-red-500";
const HINT = "mt-1 text-xs text-gray-500";
const ERROR = "mt-1 text-xs text-red-600";
const FIELD = "mb-4";

/** Left-hand pane: every setting the export needs, plus the Export control. */
export class SettingsForm extends LightElement {
  static properties = {
    settings: { attribute: false },
    styleInput: { attribute: false },
    styleError: { attribute: false },
    tokenError: { attribute: false },
    attribution: { attribute: false },
    downloadReady: { type: Boolean },
    exporting: { type: Boolean },
    progress: { type: Number },
    message: { attribute: false },
    accepted: { state: true },
    draft: { state: true },
  };

  /** The last valid value of every field; what an export and `localStorage` use. */
  declare settings: Settings;
  declare styleInput: StyleInput | null;
  declare styleError: string | null;
  declare tokenError: string | null;
  declare attribution: string[];
  declare downloadReady: boolean;
  declare exporting: boolean;
  declare progress: number;
  declare message: ExportMessage | null;

  /** Raw text of the fields that can be mid-edit and unparseable. */
  private declare draft: {
    bbox: string;
    width: string;
    height: string;
    bearing: string;
  };
  private declare accepted: boolean;

  constructor() {
    super();
    this.settings = DEFAULT_SETTINGS;
    this.styleInput = null;
    this.styleError = null;
    this.tokenError = null;
    this.attribution = [];
    this.downloadReady = false;
    this.exporting = false;
    this.progress = 0;
    this.message = null;
    this.accepted = false;
    this.draft = { bbox: "", width: "", height: "", bearing: "" };
  }

  connectedCallback() {
    super.connectedCallback();
    this.draft = {
      bbox: formatBbox(this.settings.bbox),
      width: String(this.settings.width),
      height: String(this.settings.height),
      bearing: formatBearing(this.settings.bearing),
    };
  }

  /** For the preview map's compass: the field follows the map. */
  setBearing(bearing: number) {
    const value = parseBearing(formatBearing(bearing));
    if (value === null) return;
    this.draft = { ...this.draft, bearing: formatBearing(value) };
    if (value !== this.settings.bearing) this.commit({ bearing: value });
  }

  private get bbox() {
    return parseBbox(this.draft.bbox);
  }

  private get bearing() {
    return parseBearing(this.draft.bearing);
  }

  private get widthMm() {
    return positiveNumber(this.draft.width);
  }

  private get heightMm() {
    return positiveNumber(this.draft.height);
  }

  private get pixelRatio() {
    return this.settings.dpi / 96;
  }

  private get pixelSize() {
    const { dpi } = this.settings;
    const ratio = this.pixelRatio;
    return {
      width: mmToPx(this.settings.width, dpi, ratio),
      height: mmToPx(this.settings.height, dpi, ratio),
    };
  }

  private get tooTall() {
    const { width, height } = this.pixelSize;
    const ratio = this.pixelRatio;
    return !fitsWorld(
      fitBounds(
        this.settings.bbox,
        width / ratio,
        height / ratio,
        this.settings.bearing,
      ),
    );
  }

  private get canExport() {
    return (
      !this.exporting &&
      this.downloadReady &&
      this.accepted &&
      this.styleInput !== null &&
      this.styleError === null &&
      this.tokenError === null &&
      this.bbox !== null &&
      this.bearing !== null &&
      this.widthMm !== null &&
      this.heightMm !== null &&
      !this.tooTall
    );
  }

  private commit(patch: Partial<Settings>) {
    this.settings = { ...this.settings, ...patch };
    this.dispatchEvent(
      new CustomEvent<Settings>("settings-change", { detail: this.settings }),
    );
  }

  private onSize(field: "width" | "height", event: Event) {
    const value = (event.target as HTMLInputElement).value;
    this.draft = { ...this.draft, [field]: value };
    const mm = positiveNumber(value);
    if (mm === null) this.requestUpdate();
    else this.commit(field === "width" ? { width: mm } : { height: mm });
  }

  private onBbox(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    this.draft = { ...this.draft, bbox: value };
    const bbox = parseBbox(value);
    if (bbox) this.commit({ bbox });
    else this.requestUpdate();
  }

  private onBearing(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    this.draft = { ...this.draft, bearing: value };
    const bearing = parseBearing(value);
    if (bearing !== null) this.commit({ bearing });
    else this.requestUpdate();
  }

  render() {
    return html`
      <h1 class="mb-1 text-xl font-semibold text-gray-900">Map Printer</h1>
      <p class="mb-4 text-sm text-gray-600">
        Export a print-resolution PNG of a map area, straight from your browser.
      </p>
      ${this.styleField()} ${this.tokenField()} ${this.sizeFields()}
      ${this.bboxField()} ${this.bearingField()} ${this.dpiField()}
      ${this.zoomLine()} ${this.attributionBlock()} ${this.actions()}
    `;
  }

  private styleField(): TemplateResult {
    return html`<div class=${FIELD}>
      <label class=${LABEL} for="style">Map style or tile URL</label>
      <input
        id="style"
        type="text"
        class="${INPUT} ${this.styleError ? INVALID_INPUT : ""}"
        placeholder="https://example.com/style.json"
        .value=${this.settings.style}
        @input=${(e: Event) =>
          this.commit({ style: (e.target as HTMLInputElement).value })}
      />
      <p class=${HINT}>
        A MapLibre style URL, a Mapbox style link, a TileJSON URL or a
        <code>{z}/{x}/{y}</code> tile template.
      </p>
      ${this.styleError
        ? html`<p class=${ERROR} data-error="style">${this.styleError}</p>`
        : nothing}
    </div>`;
  }

  private tokenField(): TemplateResult | typeof nothing {
    if (this.styleInput?.kind !== "mapbox") return nothing;
    return html`<div class=${FIELD}>
      <label class=${LABEL} for="token">Mapbox access token</label>
      <input
        id="token"
        type="text"
        class="${INPUT} ${this.tokenError ? INVALID_INPUT : ""}"
        placeholder="pk...."
        .value=${this.settings.mapboxToken}
        @input=${(e: Event) =>
          this.commit({ mapboxToken: (e.target as HTMLInputElement).value })}
      />
      ${this.tokenError
        ? html`<p class=${ERROR} data-error="token">${this.tokenError}</p>`
        : nothing}
    </div>`;
  }

  private sizeFields(): TemplateResult {
    return html`<div class="${FIELD} flex gap-3">
      ${this.sizeField("width", "Page width (mm)")}
      ${this.sizeField("height", "Page height (mm)")}
    </div>`;
  }

  private sizeField(field: "width" | "height", label: string): TemplateResult {
    const invalid = (field === "width" ? this.widthMm : this.heightMm) === null;
    return html`<div class="flex-1">
      <label class=${LABEL} for=${field}>${label}</label>
      <input
        id=${field}
        type="number"
        min="1"
        step="any"
        class="${INPUT} ${invalid ? INVALID_INPUT : ""}"
        .value=${this.draft[field]}
        @input=${(e: Event) => this.onSize(field, e)}
      />
      ${invalid
        ? html`<p class=${ERROR} data-error=${field}>
            Enter a size in mm greater than zero.
          </p>`
        : nothing}
    </div>`;
  }

  private bboxField(): TemplateResult {
    const invalid = this.bbox === null;
    return html`<div class=${FIELD}>
      <label class=${LABEL} for="bbox">Bounding box</label>
      <input
        id="bbox"
        type="text"
        class="${INPUT} ${invalid ? INVALID_INPUT : ""}"
        placeholder="West, South, East, North"
        .value=${this.draft.bbox}
        @input=${(e: Event) => this.onBbox(e)}
      />
      <p class=${HINT}>
        Comma-separated coordinates to fit on the page:
        <code>West,South,East,North</code>.
      </p>
      ${invalid
        ? html`<p class=${ERROR} data-error="bbox">
            Invalid bounding box — check the coordinate order is
            West,South,East,North.
          </p>`
        : nothing}
      <label class="mt-2 flex items-center gap-2 text-sm text-gray-700">
        <input
          id="preview-bbox"
          type="checkbox"
          .checked=${this.settings.previewBbox}
          @change=${(e: Event) =>
            this.commit({
              previewBbox: (e.target as HTMLInputElement).checked,
            })}
        />
        Preview bounding box and page outline on the map
      </label>
    </div>`;
  }

  private bearingField(): TemplateResult {
    const invalid = this.bearing === null;
    return html`<div class=${FIELD}>
      <label class=${LABEL} for="bearing">Rotation (degrees)</label>
      <input
        id="bearing"
        type="number"
        step="any"
        class="${INPUT} ${invalid ? INVALID_INPUT : ""}"
        .value=${this.draft.bearing}
        @input=${(e: Event) => this.onBearing(e)}
      />
      <p class=${HINT}>
        0 is north up, positive turns clockwise about the centre of the
        bounding box. Or rotate the preview map: right-drag or the compass.
      </p>
      ${invalid
        ? html`<p class=${ERROR} data-error="bearing">
            Enter a rotation in degrees.
          </p>`
        : nothing}
    </div>`;
  }

  private dpiField(): TemplateResult {
    return html`<div class=${FIELD}>
      <label class=${LABEL} for="dpi">Target print DPI</label>
      <select
        id="dpi"
        class=${INPUT}
        @change=${(e: Event) =>
          this.commit({
            dpi: Number((e.target as HTMLSelectElement).value) as Dpi,
          })}
      >
        ${DPI_OPTIONS.map(
          (dpi) =>
            html`<option value=${dpi} .selected=${dpi === this.settings.dpi}>
              ${dpi} dpi
            </option>`,
        )}
      </select>
    </div>`;
  }

  private zoomLine(): TemplateResult | typeof nothing {
    if (this.bbox === null || this.widthMm === null || this.heightMm === null) {
      return nothing;
    }
    if (this.tooTall) {
      return html`<p class="${FIELD} ${ERROR}" data-error="size">
        This page reaches past the edge of the map at the zoom it would export
        at — widen the area, reduce the page height or turn it less.
      </p>`;
    }
    const { width, height } = this.pixelSize;
    const ratio = this.pixelRatio;
    const { zoom, bearing = 0 } = fitBounds(
      this.settings.bbox,
      width / ratio,
      height / ratio,
      this.settings.bearing,
    );
    return html`<p class="${FIELD} text-sm text-gray-700" data-zoom-line>
      Map will export at zoom ${Math.round(zoom * 1000) / 1000} sized
      ${width}px x ${height}px${bearing
        ? html`, rotated ${formatBearing(bearing)}°`
        : nothing}
    </p>`;
  }

  private attributionBlock(): TemplateResult {
    const isMapbox = this.styleInput?.kind === "mapbox";
    return html`<div class="${FIELD} rounded border border-gray-200 p-3">
      <p class="text-sm font-medium text-gray-700">Attribution</p>
      ${this.attribution.length
        ? html`<ul class="mt-1 list-disc pl-5 text-xs text-gray-600">
            ${this.attribution.map((text) => html`<li>${text}</li>`)}
          </ul>`
        : html`<p class="mt-1 text-xs text-gray-600">
            No attribution was found for this style.
          </p>`}
      ${isMapbox
        ? html`<p class="mt-2 text-xs text-gray-600">
            ${unsafeHTML(MAPBOX_ATTRIBUTION)} — printing this map is subject to
            the
            <a
              class="underline"
              href=${MAPBOX_TERMS_URL}
              target="_blank"
              rel="noopener noreferrer"
              >Mapbox Terms of Service</a
            >.
          </p>`
        : nothing}
      <label class="mt-2 flex items-start gap-2 text-xs text-gray-700">
        <input
          id="attribution-ok"
          type="checkbox"
          class="mt-0.5"
          .checked=${this.accepted}
          @change=${(e: Event) => {
            this.accepted = (e.target as HTMLInputElement).checked;
          }}
        />
        I will include this attribution on the printed map
      </label>
    </div>`;
  }

  private actions(): TemplateResult {
    return html`<div class=${FIELD}>
      ${this.exporting
        ? html`<div
              class="h-5 w-full overflow-hidden rounded bg-gray-200"
              role="progressbar"
              aria-valuemin="0"
              aria-valuemax="100"
              aria-valuenow=${Math.round(this.progress * 100)}
            >
              <div
                class="h-full bg-blue-600"
                style="width: ${Math.round(this.progress * 100)}%"
              ></div>
            </div>
            ${this.progress >= 1
              ? html`<p class="mt-1 text-sm text-gray-600" data-status="writing">
                  Writing file…
                </p>`
              : nothing}
            <button
              id="cancel"
              type="button"
              class="mt-2 w-full rounded border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              @click=${() => this.dispatchEvent(new CustomEvent("export-cancel"))}
            >
              Cancel
            </button>`
        : html`<button
            id="export"
            type="button"
            class="w-full rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300"
            ?disabled=${!this.canExport}
            @click=${() => this.dispatchEvent(new CustomEvent("export-request"))}
          >
            Export Image
          </button>`}
      ${this.message
        ? html`<p
            class="mt-2 text-sm ${this.message.kind === "error"
              ? "text-red-600"
              : "text-green-700"}"
            data-message=${this.message.kind}
          >
            ${this.message.text}
          </p>`
        : nothing}
    </div>`;
  }
}

function positiveNumber(text: string): number | null {
  const value = Number(text.trim());
  return text.trim() && Number.isFinite(value) && value > 0 ? value : null;
}

/** Two decimals is finer than a compass drag resolves and keeps the field short. */
function formatBearing(bearing: number): string {
  return String(Math.round(bearing * 100) / 100);
}

if (!customElements.get("settings-form")) {
  customElements.define("settings-form", SettingsForm);
}
