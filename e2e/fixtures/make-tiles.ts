// Regenerates e2e/fixtures/tiles/{z}/{x}/{y}.png, a solid distinct colour per
// tile, for zoom 0-2. The result is committed; run this only to change it:
//   node --experimental-strip-types e2e/fixtures/make-tiles.ts
import fs from "node:fs";
import path from "node:path";
import { encode } from "fast-png";

const OUT_DIR = path.join(import.meta.dirname, "tiles");
const TILE_SIZE = 256;
const MAX_ZOOM = 2;
/** Golden-angle hue steps keep neighbouring tiles far apart in colour. */
const HUE_STEP = 137.508;

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = (
    [
      [c, x, 0],
      [x, c, 0],
      [0, c, x],
      [0, x, c],
      [x, 0, c],
      [c, 0, x],
    ] as const
  )[Math.floor(h / 60) % 6];
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

function solidTile(rgb: [number, number, number]): Uint8Array {
  const data = new Uint8Array(TILE_SIZE * TILE_SIZE * 3);
  for (let i = 0; i < data.length; i += 3) data.set(rgb, i);
  return data;
}

fs.rmSync(OUT_DIR, { recursive: true, force: true });
let index = 0;
for (let z = 0; z <= MAX_ZOOM; z++) {
  const side = 2 ** z;
  for (let x = 0; x < side; x++) {
    for (let y = 0; y < side; y++) {
      const rgb = hslToRgb((index++ * HUE_STEP) % 360, 0.75, 0.45);
      const dir = path.join(OUT_DIR, String(z), String(x));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, `${y}.png`),
        encode({
          width: TILE_SIZE,
          height: TILE_SIZE,
          data: solidTile(rgb),
          channels: 3,
          depth: 8,
        }),
      );
    }
  }
}
console.log(`wrote ${index} tiles to ${OUT_DIR}`);
