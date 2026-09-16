# download

Streams bytes straight to a file on disk through a service worker, so an
export far larger than memory never has to become a `Blob`. Port of
map-downloader's download path: `public/sw.js` is its service worker copied
verbatim, and this module is the page side of the same handshake.

```ts
registerDownloadWorker(): void
downloadReady(): Promise<void>
startDownload(opts: { filename: string; contentType: string }):
  Promise<{ writable: WritableStream<Uint8Array>; cleanup(): void }>
```

## How it works

The worker answers a request for a unique `/_download/<uuid>/<name>` URL with a
`ReadableStream` it rebuilds from a `MessagePort`, plus a
`Content-Disposition: attachment` header — so the browser treats it as a file
download and writes it to disk as the bytes arrive.

`startDownload` navigates a hidden iframe to that URL as its first statement,
before anything is awaited: Safari only starts a download while the user
activation from the click is still live. The worker cannot see a navigation
that never reached it, so the page waits for its `downloadStarted` message
before handing over the `MessagePort` and returning the writable.

## Backpressure and errors

The sink posts one `WRITE` per chunk and waits for the worker's `PULL` before
accepting the next, so the worker's four-chunk queue is the backpressure
boundary and the export stalls while the browser writes to disk.

Aborting the writable posts `ABORT`, which errors the response: the browser
shows a failed download rather than a silently truncated file. The port is
closed at most once, so an error in the worker followed by an abort on the
page does not post to a dead port.

## Registration

`registerDownloadWorker()` registers `/sw.js` with `updateViaCache: "none"` (the
browser otherwise serves a day-old `sw.js` from its HTTP cache), calls
`navigator.serviceWorker.startMessages()` so queued worker messages reach the
handshake's `addEventListener`, and replaces a worker too old to speak the
download protocol.

A fresh page load is not controlled by the worker until it claims the client,
and a download started before then cannot work — `downloadReady()` resolves at
that point, and the UI keeps Export disabled until it does. If registration
itself failed (no `sw.js`, or plain http off localhost) no controller is ever
coming, so `downloadReady()` rejects instead of waiting for one.
