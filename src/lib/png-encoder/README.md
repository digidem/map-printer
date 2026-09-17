# png-encoder

Streaming PNG encoder built on `CompressionStream`.

```ts
createPngEncoder(opts: {
  width: number; height: number;
  channels: 3 | 4;            // RGB or RGBA in, same colour type out
  filter?: "none" | "sub";    // default "sub"
}): TransformStream<Uint8Array, Uint8Array>
```

Writable side: raw pixel bytes, top-down, at any chunking — a chunk may end
mid-row or carry many rows. Readable side: a complete PNG file (signature,
IHDR, IDAT chunks, IEND). Nothing larger than one scanline of input and one
IDAT's worth (~64 KiB) of compressed output is held, so an image far bigger
than memory can be encoded.

One `CompressionStream("deflate")` compresses the whole image; its zlib output
is what IDAT carries, cut into chunks as it arrives. Bit depth is always 8 and
the image is never interlaced. CRC32 uses a small table.

Backpressure is end to end: IDAT chunks are only cut when the reader pulls, so
a slow consumer stalls the compressor and in turn whoever writes pixels.

The stream errors if `width` or `height` is not a positive integer, if
`channels` is not 3 or 4, or if more or fewer than `width * height * channels`
bytes arrive. Cancelling the readable aborts the compressor, so pending writes
reject.
