// Page side of the streaming download; the worker side is public/sw.js.
// Ported from map-downloader (src/main.ts and src/worker.ts).

const WRITE = 0;
const PULL = 0;
const ERROR = 1;
const ABORT = 1;
const CLOSE = 2;

// Kept in step with public/sw.js: an older worker ignores /_download/ requests.
const DOWNLOAD_PATH = "/_download/";
const DOWNLOAD_PROTOCOL = 1;
const DOWNLOAD_START_TIMEOUT_MS = 5_000;

export interface DownloadOptions {
  filename: string;
  contentType: string;
}

export interface Download {
  writable: WritableStream<Uint8Array>;
  /** Removes the iframe that started the download. */
  cleanup(): void;
}

export function registerDownloadWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  // `updateViaCache: 'none'` bypasses the browser's 24h HTTP-cache rule for sw.js.
  navigator.serviceWorker
    .register("/sw.js", { updateViaCache: "none" })
    .then((registration) => registration.update())
    .catch((err) => console.warn("SW registration failed", err));
  // Messages from the worker are queued until the page asks for them, and the
  // download handshake below listens with addEventListener.
  navigator.serviceWorker.startMessages();
  void ensureDownloadWorker();
}

/** Resolves once a service worker controls the page, which is when a download
 *  can be started. */
export function downloadReady(): Promise<void> {
  if (!("serviceWorker" in navigator)) {
    return Promise.reject(
      new Error("This browser cannot download without a service worker"),
    );
  }
  if (navigator.serviceWorker.controller) return Promise.resolve();
  return new Promise((resolve) => {
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      () => resolve(),
      { once: true },
    );
  });
}

export async function startDownload(opts: DownloadOptions): Promise<Download> {
  // Nothing may be awaited before this call: it navigates an iframe, which
  // Safari only turns into a download while the user activation is still live.
  const { workerPort, cleanup } = await prepareSwDownload(
    opts.filename,
    opts.contentType,
  );
  return {
    writable: new WritableStream(new MessagePortSink(workerPort)),
    cleanup,
  };
}

/** Ask the active service worker which download protocol it speaks (0 = none) */
function downloadProtocol(registration: ServiceWorkerRegistration) {
  return new Promise<number>((resolve) => {
    const sw = registration.active;
    if (!sw) return resolve(0);
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(0), 1000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      resolve(event.data?.downloadProtocol ?? 0);
    };
    sw.postMessage({ type: "ping" }, [channel.port2]);
  });
}

/** A worker installed before the download path existed silently ignores those
 *  requests, and the page only finds out when a download fails, so replace it
 *  up front. */
async function ensureDownloadWorker() {
  const registration = await navigator.serviceWorker?.ready;
  if (!registration) return;
  if ((await downloadProtocol(registration)) >= DOWNLOAD_PROTOCOL) return;
  await registration.update().catch(() => {});
}

/** Resolves once the service worker reports it received the download request */
function waitForDownloadStart(url: string, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (started: boolean) => {
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener("message", onMessage);
      resolve(started);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "downloadStarted" && event.data.url === url) {
        finish(true);
      }
    };
    const timer = setTimeout(() => finish(false), timeout);
    navigator.serviceWorker.addEventListener("message", onMessage);
  });
}

interface SwDownloadChannel {
  workerPort: MessagePort;
  cleanup: () => void;
}

/** Start the browser download and return the port the PNG stream writes to. */
async function prepareSwDownload(
  filename: string,
  contentType: string,
): Promise<SwDownloadChannel> {
  if (!navigator.serviceWorker?.controller) {
    throw new Error(
      "Downloads need the service worker — reload the page and try again",
    );
  }

  const encodedName = encodeURIComponent(filename)
    .replace(/['()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/\*/g, "%2A");
  const url = `${location.origin}${DOWNLOAD_PATH}${crypto.randomUUID()}/${encodedName}`;

  // Navigate first and synchronously, before any await: Safari only starts a
  // download while the click's user activation is live. The service worker
  // holds the request open until the stream below reaches it.
  const iframe = document.createElement("iframe");
  iframe.hidden = true;
  iframe.src = url;
  document.body.appendChild(iframe);
  const cleanup = () => iframe.remove();

  // Nothing is generated until the request is known to have arrived.
  if (!(await waitForDownloadStart(url, DOWNLOAD_START_TIMEOUT_MS))) {
    cleanup();
    throw new Error(
      "The service worker did not receive the download request — reload the page and try again",
    );
  }

  const registration = await navigator.serviceWorker.ready;
  const sw = registration.active ?? navigator.serviceWorker.controller;
  if (!sw) {
    cleanup();
    throw new Error("Service worker not available");
  }

  const asciiName = filename
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_");
  const headers = {
    // Safari ignores filename*, so send a plain ASCII filename as well.
    "content-disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
    "content-type": contentType,
  };
  const channel = new MessageChannel();
  sw.postMessage({ url, headers, readablePort: channel.port1 }, [channel.port1]);

  return { workerPort: channel.port2, cleanup };
}

class MessagePortSink implements UnderlyingSink<Uint8Array> {
  #port: MessagePort;
  #portClosed = false;
  #controller!: WritableStreamDefaultController;
  #readyResolve!: () => void;
  #readyReject!: (reason: unknown) => void;
  #readyPromise!: Promise<void>;

  constructor(port: MessagePort) {
    this.#port = port;
    port.onmessage = (event) => this.#onMessage(event.data);
    this.#resetReady();
  }

  start(controller: WritableStreamDefaultController) {
    this.#controller = controller;
    return this.#readyPromise;
  }

  write(chunk: Uint8Array) {
    // The worker closes the port when it errors, and posting to a dead port
    // silently drops the chunk; the rejected ready promise reports it instead.
    if (this.#portClosed) return this.#readyPromise;
    this.#port.postMessage({ type: WRITE, chunk }, [chunk.buffer]);
    this.#resetReady();
    return this.#readyPromise;
  }

  close() {
    if (this.#portClosed) return;
    this.#port.postMessage({ type: CLOSE });
    this.#closePort();
  }

  abort(reason: unknown) {
    if (this.#portClosed) return;
    this.#port.postMessage({ type: ABORT, reason: String(reason) });
    this.#closePort();
  }

  #onMessage(message: { type: number; reason?: unknown }) {
    if (message.type === PULL) this.#readyResolve();
    if (message.type === ERROR) {
      this.#controller.error(message.reason);
      this.#readyReject(message.reason);
      this.#closePort();
    }
  }

  #closePort() {
    this.#portClosed = true;
    this.#port.close();
  }

  #resetReady() {
    this.#readyPromise = new Promise((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
    });
  }
}
