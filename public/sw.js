// Streams exported PNGs to disk, using the pattern from
// native-file-system-adapter. The page navigates to a unique /_download/ URL
// and then sends a MessagePort for it; the SW rebuilds a ReadableStream from
// the port and answers that fetch with it, triggering a download via
// Content-Disposition. Copied from map-downloader.

const WRITE = 0;
const PULL = 0;
const ERROR = 1;
const CLOSE = 2;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);

class MessagePortSource {
  constructor(port) {
    this.port = port;
    this.port.onmessage = (evt) => this.onMessage(evt.data);
  }

  start(controller) {
    this.controller = controller;
  }

  pull() {
    this.port.postMessage({ type: PULL });
  }

  cancel(reason) {
    this.port.postMessage({ type: ERROR, reason: String(reason) });
    this.port.close();
  }

  onMessage(message) {
    if (message.type === WRITE) {
      this.controller.enqueue(message.chunk);
    } else if (message.type === ERROR) {
      this.controller.error(message.reason);
      this.port.close();
    } else if (message.type === CLOSE) {
      this.controller.close();
      this.port.close();
    }
  }
}

// Download URLs are unique per download, and a worker installed before this
// path existed ignores them — the page checks DOWNLOAD_PROTOCOL to notice.
const DOWNLOAD_PATH = "/_download/";
const DOWNLOAD_TIMEOUT = 30_000;
const DOWNLOAD_PROTOCOL = 1;

/** Streams whose fetch has not arrived yet, keyed by URL */
const pending = new Map();
/** Fetches waiting for their stream, keyed by URL */
const waiting = new Map();

self.addEventListener("message", (evt) => {
  const data = evt.data;
  if (data?.type === "ping") {
    evt.ports[0]?.postMessage({ downloadProtocol: DOWNLOAD_PROTOCOL });
    return;
  }
  if (!data?.url || !data.readablePort) return;
  const rs = new ReadableStream(
    new MessagePortSource(data.readablePort),
    new CountQueuingStrategy({ highWaterMark: 4 }),
  );
  const download = { rs, headers: data.headers };
  const waiter = waiting.get(data.url);
  if (waiter) {
    waiting.delete(data.url);
    waiter(download);
  } else {
    pending.set(data.url, download);
  }
});

// A navigation does not always reach the service worker, and the page can only
// tell by being told the request arrived.
async function announceDownload(url) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  for (const client of clients) {
    client.postMessage({ type: "downloadStarted", url });
  }
}

self.addEventListener("fetch", (event) => {
  const url = event.request.url;
  const ready = pending.get(url);
  if (ready) {
    pending.delete(url);
    event.waitUntil(announceDownload(url));
    event.respondWith(new Response(ready.rs, { headers: ready.headers }));
    return;
  }
  if (!new URL(url).pathname.startsWith(DOWNLOAD_PATH)) return;
  event.waitUntil(announceDownload(url));
  // The page navigates here synchronously to keep Safari's user activation and
  // sends the stream just after, so hold the request open until it arrives.
  event.respondWith(
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiting.delete(url);
        resolve(new Response("Download expired", { status: 504 }));
      }, DOWNLOAD_TIMEOUT);
      waiting.set(url, (download) => {
        clearTimeout(timer);
        resolve(new Response(download.rs, { headers: download.headers }));
      });
    }),
  );
});
