import { describe, expect, it } from "vitest";
import {
  type Bbox,
  type Viewport,
  MAX_LATITUDE,
  clampBbox,
  fitBounds,
  fitsWorld,
  isValidBbox,
  mmToPx,
  normalizeBearing,
  project,
  rotateOffset,
  tileGrid,
  unproject,
  viewportBbox,
  viewportCorners,
} from "./index.ts";

describe("project / unproject", () => {
  it("puts null island at the centre of the world", () => {
    expect(project([0, 0], 0)).toEqual([256, 256]);
    expect(project([0, 0], 5)).toEqual([8192, 8192]);
  });

  it("maps the antimeridian to the world edges", () => {
    expect(project([-180, 0], 0)[0]).toBe(0);
    expect(project([180, 0], 0)[0]).toBe(512);
    expect(project([180, 0], 3)[0]).toBe(4096);
  });

  it("maps the latitude limits to the top and bottom of the world", () => {
    expect(project([0, MAX_LATITUDE], 0)[1]).toBeCloseTo(0, 5);
    expect(project([0, -MAX_LATITUDE], 0)[1]).toBeCloseTo(512, 5);
  });

  it("clamps latitude beyond the Mercator limit", () => {
    expect(project([0, 90], 0)).toEqual(project([0, MAX_LATITUDE], 0));
    expect(project([0, -90], 4)).toEqual(project([0, -MAX_LATITUDE], 4));
  });

  it("matches hand-checked values", () => {
    const [x, y] = project([-0.1278, 51.5], 0);
    expect(x).toBeCloseTo(255.81824, 5);
    expect(y).toBeCloseTo(170.26998, 5);

    const [x2, y2] = project([-74.006, 40.7128], 2);
    expect(x2).toBeCloseTo(602.9881, 4);
    expect(y2).toBeCloseTo(770.0087, 4);
  });

  it("round-trips", () => {
    const points: [number, number][] = [
      [0, 0],
      [-0.1278, 51.5074],
      [151.2093, -33.8688],
      [179.999, 84.9],
      [-179.999, -84.9],
      [13.405, 52.52],
    ];
    for (const zoom of [0, 1, 7.5, 14, 22]) {
      for (const p of points) {
        const back = unproject(project(p, zoom), zoom);
        expect(back[0]).toBeCloseTo(p[0], 9);
        expect(back[1]).toBeCloseTo(p[1], 9);
      }
    }
  });

  it("round-trips world pixels", () => {
    for (const zoom of [0, 3, 11.25]) {
      const size = 512 * 2 ** zoom;
      for (const point of [
        [size / 2, size / 2],
        [1, 1],
        [size - 1, size - 3],
        [size * 0.13, size * 0.87],
      ] as [number, number][]) {
        const back = project(unproject(point, zoom), zoom);
        expect(back[0]).toBeCloseTo(point[0], 6);
        expect(back[1]).toBeCloseTo(point[1], 6);
      }
    }
  });
});

describe("isValidBbox", () => {
  it("accepts well-formed bboxes", () => {
    expect(isValidBbox([-1, -1, 1, 1])).toBe(true);
    expect(isValidBbox([-180, -MAX_LATITUDE, 180, MAX_LATITUDE])).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isValidBbox(undefined)).toBe(false);
    expect(isValidBbox("−1,−1,1,1")).toBe(false);
    expect(isValidBbox([-1, -1, 1])).toBe(false);
    expect(isValidBbox([-1, -1, 1, 1, 1])).toBe(false);
    expect(isValidBbox([-1, -1, 1, "1"])).toBe(false);
    expect(isValidBbox([-1, -1, NaN, 1])).toBe(false);
    expect(isValidBbox([1, -1, 1, 1])).toBe(false);
    expect(isValidBbox([1, -1, -1, 1])).toBe(false);
    expect(isValidBbox([-1, 1, 1, 1])).toBe(false);
    expect(isValidBbox([-181, -1, 1, 1])).toBe(false);
    expect(isValidBbox([-1, -1, 181, 1])).toBe(false);
    expect(isValidBbox([-1, -90, 1, 1])).toBe(false);
    expect(isValidBbox([-1, -1, 1, 90])).toBe(false);
    expect(isValidBbox([-180, -90, 180, 90])).toBe(false);
  });
});

describe("clampBbox", () => {
  it("makes a whole-world bbox valid", () => {
    const clamped = clampBbox([-180, -90, 180, 90]);
    expect(clamped).toEqual([-180, -MAX_LATITUDE, 180, MAX_LATITUDE]);
    expect(isValidBbox(clamped)).toBe(true);
  });

  it("leaves latitudes within the Mercator limit alone", () => {
    expect(clampBbox([-1, -1, 1, 1])).toEqual([-1, -1, 1, 1]);
  });
});

describe("fitBounds", () => {
  it("fits the whole world into a 512x512 viewport at zoom 0", () => {
    const v = fitBounds([-180, -MAX_LATITUDE, 180, MAX_LATITUDE], 512, 512);
    expect(v.zoom).toBeCloseTo(0, 6);
    expect(v.center[0]).toBeCloseTo(0, 9);
    expect(v.center[1]).toBeCloseTo(0, 6);
  });

  it("is height-limited for a tall bbox in a square viewport", () => {
    const bbox: Bbox = [-10, -40, 10, 40];
    const v = fitBounds(bbox, 600, 600);
    const covered = viewportBbox(v);
    expect(covered[1]).toBeCloseTo(bbox[1], 9);
    expect(covered[3]).toBeCloseTo(bbox[3], 9);
    expect(covered[0]).toBeLessThan(bbox[0]);
    expect(covered[2]).toBeGreaterThan(bbox[2]);
  });

  it("is width-limited for a wide bbox in a square viewport", () => {
    const bbox: Bbox = [-40, -10, 40, 10];
    const v = fitBounds(bbox, 600, 600);
    const covered = viewportBbox(v);
    expect(covered[0]).toBeCloseTo(bbox[0], 9);
    expect(covered[2]).toBeCloseTo(bbox[2], 9);
    expect(covered[1]).toBeLessThan(bbox[1]);
    expect(covered[3]).toBeGreaterThan(bbox[3]);
  });

  it("centres the bbox in Mercator space", () => {
    const v = fitBounds([-10, -10, 10, 10], 400, 800);
    expect(v.center[0]).toBeCloseTo(0, 9);
    expect(v.center[1]).toBeCloseTo(0, 9);

    const v2 = fitBounds([0, 40, 20, 60], 400, 400);
    expect(v2.center[0]).toBeCloseTo(10, 9);
    const mid = unproject(
      [
        0,
        (project([0, 40], 0)[1] + project([0, 60], 0)[1]) / 2,
      ],
      0,
    )[1];
    expect(v2.center[1]).toBeCloseTo(mid, 9);
  });

  it("halving the viewport halves the zoom scale", () => {
    const bbox: Bbox = [-10, -10, 10, 10];
    expect(fitBounds(bbox, 1024, 1024).zoom - fitBounds(bbox, 512, 512).zoom)
      .toBeCloseTo(1, 9);
  });

  it("round-trips: viewportBbox(fitBounds(b)) contains b and matches on the limiting axis", () => {
    const bboxes: Bbox[] = [
      [-10, -10, 10, 10],
      [-0.5, 51.3, 0.3, 51.7],
      [151.1, -33.95, 151.35, -33.75],
      [-74.3, 40.5, -73.7, 40.9],
      [-179, -80, -170, 80],
      [-180, -MAX_LATITUDE, 180, MAX_LATITUDE],
    ];
    const sizes: [number, number][] = [
      [512, 512],
      [1000, 400],
      [400, 1000],
      [3307, 2339],
    ];
    for (const bbox of bboxes) {
      for (const [width, height] of sizes) {
        const covered = viewportBbox(fitBounds(bbox, width, height));
        expect(covered[0]).toBeLessThanOrEqual(bbox[0] + 1e-9);
        expect(covered[1]).toBeLessThanOrEqual(bbox[1] + 1e-9);
        expect(covered[2]).toBeGreaterThanOrEqual(bbox[2] - 1e-9);
        expect(covered[3]).toBeGreaterThanOrEqual(bbox[3] - 1e-9);

        const matchesX =
          Math.abs(covered[0] - bbox[0]) < 1e-9 &&
          Math.abs(covered[2] - bbox[2]) < 1e-9;
        const matchesY =
          Math.abs(covered[1] - bbox[1]) < 1e-9 &&
          Math.abs(covered[3] - bbox[3]) < 1e-9;
        expect(matchesX || matchesY).toBe(true);
      }
    }
  });

  it("rejects invalid input", () => {
    expect(() => fitBounds([1, 1, 1, 1], 100, 100)).toThrow(TypeError);
    expect(() => fitBounds([-1, -1, 1, 1], 0, 100)).toThrow(TypeError);
    expect(() => fitBounds([-1, -1, 1, 1], 100, -5)).toThrow(TypeError);
  });
});

describe("fitsWorld", () => {
  it("is true for a viewport that fits inside the Mercator world", () => {
    expect(fitsWorld(fitBounds([-180, -MAX_LATITUDE, 180, MAX_LATITUDE], 512, 512))).toBe(true);
    expect(fitsWorld(fitBounds([-10, -10, 10, 10], 793, 1122))).toBe(true);
  });

  it("is false for a width-limited whole-world fit on a portrait page", () => {
    const v = fitBounds([-180, -MAX_LATITUDE, 180, MAX_LATITUDE], 793, 1122);
    expect(v.height).toBeGreaterThan(512 * 2 ** v.zoom);
    expect(fitsWorld(v)).toBe(false);
  });

  it("is false when the viewport hangs off only one pole", () => {
    const v = fitBounds([-20, 60, 20, MAX_LATITUDE], 400, 400);
    expect(fitsWorld({ ...v, height: v.height * 4 })).toBe(false);
  });
});

describe("tileGrid", () => {
  const viewport = (width: number, height: number): Viewport => ({
    center: [13.405, 52.52],
    zoom: 9.3,
    width,
    height,
  });

  const cases: [number, number, number, number][] = [
    [100, 100, 100, 100],
    [512, 512, 256, 256],
    [700, 500, 256, 256],
    [1, 1, 256, 256],
    [1000, 256, 256, 256],
    [256, 1000, 256, 256],
    [1025, 769, 512, 384],
  ];

  it.each(cases)(
    "covers a %ix%i viewport exactly with %ix%i tiles",
    (width, height, tw, th) => {
      const tiles = tileGrid(viewport(width, height), {
        width: tw,
        height: th,
      });
      const coverage = new Uint8Array(width * height);
      for (const t of tiles) {
        expect(Number.isInteger(t.x)).toBe(true);
        expect(Number.isInteger(t.y)).toBe(true);
        expect(t.width).toBeGreaterThan(0);
        expect(t.height).toBeGreaterThan(0);
        expect(t.width).toBeLessThanOrEqual(tw);
        expect(t.height).toBeLessThanOrEqual(th);
        for (let y = t.y; y < t.y + t.height; y++) {
          for (let x = t.x; x < t.x + t.width; x++) {
            coverage[y * width + x]! += 1;
          }
        }
      }
      expect(coverage.every((n) => n === 1)).toBe(true);
    },
  );

  it("is row-major and sizes the edge tiles by the remainder", () => {
    const tiles = tileGrid(viewport(700, 500), { width: 256, height: 256 });
    expect(tiles.length).toBe(3 * 2);
    expect(tiles.map((t) => [t.col, t.row])).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
      [0, 1],
      [1, 1],
      [2, 1],
    ]);
    expect(tiles.map((t) => [t.x, t.y, t.width, t.height])).toEqual([
      [0, 0, 256, 256],
      [256, 0, 256, 256],
      [512, 0, 188, 256],
      [0, 256, 256, 244],
      [256, 256, 256, 244],
      [512, 256, 188, 244],
    ]);
  });

  it("gives a single full-size tile when the viewport fits in one tile", () => {
    const tiles = tileGrid(viewport(200, 150), { width: 256, height: 256 });
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toMatchObject({
      col: 0,
      row: 0,
      x: 0,
      y: 0,
      width: 200,
      height: 150,
    });
    expect(tiles[0]!.center[0]).toBeCloseTo(13.405, 9);
    expect(tiles[0]!.center[1]).toBeCloseTo(52.52, 9);
  });

  it("puts each tile centre at the tile's pixel centre", () => {
    const v = viewport(1025, 769);
    const [cx, cy] = project(v.center, v.zoom);
    const originX = cx - v.width / 2;
    const originY = cy - v.height / 2;
    for (const t of tileGrid(v, { width: 512, height: 384 })) {
      const [x, y] = project(t.center, v.zoom);
      expect(x - originX).toBeCloseTo(t.x + t.width / 2, 6);
      expect(y - originY).toBeCloseTo(t.y + t.height / 2, 6);
    }
  });

  it("makes neighbouring tiles abut exactly", () => {
    const v = viewport(768, 768);
    const tiles = tileGrid(v, { width: 256, height: 256 });
    const edge = (t: (typeof tiles)[number], dx: number, dy: number) =>
      project(t.center, v.zoom).map(
        (c, i) => c + (i === 0 ? (dx * t.width) / 2 : (dy * t.height) / 2),
      );
    for (const t of tiles) {
      const right = tiles.find((o) => o.row === t.row && o.col === t.col + 1);
      if (right) expect(edge(t, 1, 0)[0]).toBeCloseTo(edge(right, -1, 0)[0], 6);
      const below = tiles.find((o) => o.col === t.col && o.row === t.row + 1);
      if (below) expect(edge(t, 0, 1)[1]).toBeCloseTo(edge(below, 0, -1)[1], 6);
    }
  });

  it("requires integer pixel sizes", () => {
    expect(() =>
      tileGrid(viewport(100.5, 100), { width: 256, height: 256 }),
    ).toThrow(TypeError);
    expect(() =>
      tileGrid(viewport(100, 0), { width: 256, height: 256 }),
    ).toThrow(TypeError);
    expect(() =>
      tileGrid(viewport(100, 100), { width: 256.5, height: 256 }),
    ).toThrow(TypeError);
    expect(() =>
      tileGrid(viewport(100, 100), { width: 256, height: 0 }),
    ).toThrow(TypeError);
  });
});

describe("mmToPx", () => {
  it("converts millimetres at a dpi", () => {
    expect(mmToPx(25.4, 96)).toBe(96);
    expect(mmToPx(25.4, 300)).toBe(300);
    expect(mmToPx(210, 300)).toBe(2480);
    expect(mmToPx(297, 96)).toBe(1123);
  });

  it("rounds to a whole multiple of the pixel ratio", () => {
    for (const dpi of [96, 192, 288, 384]) {
      const pixelRatio = dpi / 96;
      for (const mm of [210, 297, 100, 1189]) {
        const px = mmToPx(mm, dpi, pixelRatio);
        expect(Number.isInteger(px / pixelRatio)).toBe(true);
        expect(Math.abs(px - (mm / 25.4) * dpi)).toBeLessThanOrEqual(
          pixelRatio / 2,
        );
      }
    }
  });

  it("never rounds down to zero pixels", () => {
    expect(mmToPx(0.01, 96)).toBe(1);
    expect(mmToPx(0.01, 192, 2)).toBe(2);
  });

  it("rejects non-positive input", () => {
    expect(() => mmToPx(0, 96)).toThrow(TypeError);
    expect(() => mmToPx(210, 0)).toThrow(TypeError);
    expect(() => mmToPx(Number.NaN, 96)).toThrow(TypeError);
    expect(() => mmToPx(210, 192, 0)).toThrow(TypeError);
    expect(() => mmToPx(210, 192, 1.5)).toThrow(TypeError);
  });
});

describe("normalizeBearing", () => {
  it("wraps to (-180, 180]", () => {
    expect(normalizeBearing(0)).toBe(0);
    expect(normalizeBearing(90)).toBe(90);
    expect(normalizeBearing(-90)).toBe(-90);
    expect(normalizeBearing(180)).toBe(180);
    expect(normalizeBearing(-180)).toBe(180);
    expect(normalizeBearing(540)).toBe(180);
    expect(normalizeBearing(270)).toBe(-90);
    expect(normalizeBearing(360)).toBe(0);
    expect(normalizeBearing(-450)).toBe(-90);
  });

  it("rejects non-finite input", () => {
    expect(() => normalizeBearing(Number.NaN)).toThrow(TypeError);
    expect(() => normalizeBearing(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
});

describe("rotateOffset", () => {
  it("is the identity at bearing 0", () => {
    expect(rotateOffset([3, -4], 0)).toEqual([3, -4]);
  });

  it("turns screen-up into world-east at bearing 90 (east up)", () => {
    // With east up, a point east of the centre is above it on screen, so a
    // screen offset pointing up (0, -d) must land east: world (+d, 0).
    const [x, y] = rotateOffset([0, -10], 90);
    expect(x).toBeCloseTo(10, 9);
    expect(y).toBeCloseTo(0, 9);
    const [x2, y2] = rotateOffset([10, 0], 90);
    expect(x2).toBeCloseTo(0, 9);
    expect(y2).toBeCloseTo(10, 9);
  });

  it("preserves length", () => {
    for (const bearing of [-170, -45, 12.5, 33, 90, 179]) {
      const [x, y] = rotateOffset([3, 4], bearing);
      expect(Math.hypot(x, y)).toBeCloseTo(5, 9);
    }
  });
});

describe("bearing", () => {
  const bbox: Bbox = [-10, -5, 10, 5];

  it("fitBounds keeps the unrotated zoom and centre and records the bearing", () => {
    const flat = fitBounds(bbox, 800, 400);
    const turned = fitBounds(bbox, 800, 400, 30);
    expect(flat.bearing).toBe(0);
    expect(turned.bearing).toBe(30);
    expect(turned.zoom).toBe(flat.zoom);
    expect(turned.center).toEqual(flat.center);
    expect(fitBounds(bbox, 800, 400, 450).bearing).toBe(90);
  });

  it("viewportCorners at bearing 0 are the unrotated bbox corners", () => {
    const v = fitBounds(bbox, 800, 400);
    const [nw, ne, se, sw] = viewportCorners(v);
    const [west, south, east, north] = viewportBbox(v);
    expect(nw[0]).toBeCloseTo(west, 9);
    expect(nw[1]).toBeCloseTo(north, 9);
    expect(ne[0]).toBeCloseTo(east, 9);
    expect(ne[1]).toBeCloseTo(north, 9);
    expect(se[0]).toBeCloseTo(east, 9);
    expect(se[1]).toBeCloseTo(south, 9);
    expect(sw[0]).toBeCloseTo(west, 9);
    expect(sw[1]).toBeCloseTo(south, 9);
  });

  it("viewportCorners at bearing 90 put the top edge on the east", () => {
    const v = fitBounds(bbox, 800, 400, 90);
    const [tl, tr, br, bl] = viewportCorners(v);
    // Screen top is east; screen right is south.
    expect(tl[0]).toBeCloseTo(tr[0], 9);
    expect(tl[0]).toBeGreaterThan(v.center[0]);
    expect(bl[0]).toBeLessThan(v.center[0]);
    expect(tr[1]).toBeLessThan(tl[1]);
    expect(br[1]).toBeCloseTo(tr[1], 9);
    // The page's world-space extent swapped axes: 400 px wide, 800 px tall.
    const [x0, y0] = project(tl, v.zoom);
    const [x1, y1] = project(br, v.zoom);
    expect(Math.abs(x1 - x0)).toBeCloseTo(400, 6);
    expect(Math.abs(y1 - y0)).toBeCloseTo(800, 6);
  });

  it("viewportBbox is the envelope of the rotated page", () => {
    const flat = viewportBbox(fitBounds(bbox, 800, 400));
    const turned = viewportBbox(fitBounds(bbox, 800, 400, 45));
    expect(turned[0]).toBeLessThan(flat[0]);
    expect(turned[2]).toBeGreaterThan(flat[2]);
    expect(turned[1]).toBeLessThan(flat[1]);
    expect(turned[3]).toBeGreaterThan(flat[3]);
    expect(viewportBbox(fitBounds(bbox, 800, 400, 360))).toEqual(flat);
  });

  it("tileGrid keeps the screen rects and rotates the centres", () => {
    const flat = fitBounds(bbox, 1000, 600);
    const turned = { ...flat, bearing: 30 };
    const tile = { width: 256, height: 256 };
    const flatTiles = tileGrid(flat, tile);
    const turnedTiles = tileGrid(turned, tile);
    expect(turnedTiles.map(({ center: _, ...rect }) => rect)).toEqual(
      flatTiles.map(({ center: _, ...rect }) => rect),
    );
    const [cx, cy] = project(turned.center, turned.zoom);
    for (const t of turnedTiles) {
      const [x, y] = project(t.center, turned.zoom);
      const [ex, ey] = rotateOffset(
        [t.x + t.width / 2 - 500, t.y + t.height / 2 - 300],
        30,
      );
      expect(x - cx).toBeCloseTo(ex, 6);
      expect(y - cy).toBeCloseTo(ey, 6);
    }
  });

  it("tileGrid at bearing 90 is the unrotated grid turned a quarter turn", () => {
    const flat = fitBounds(bbox, 1000, 600);
    const tile = { width: 200, height: 200 };
    const turnedTiles = tileGrid({ ...flat, bearing: 90 }, tile);
    const [cx, cy] = project(flat.center, flat.zoom);
    for (const t of turnedTiles) {
      const [x, y] = project(t.center, flat.zoom);
      // A screen offset (sx, sy) from the centre lands at world (-sy, sx).
      expect(x - cx).toBeCloseTo(-(t.y + t.height / 2 - 300), 6);
      expect(y - cy).toBeCloseTo(t.x + t.width / 2 - 500, 6);
    }
  });

  it("fitsWorld sees a rotated corner leave the world", () => {
    // A wide strip near the pole fits north-up, but its corners cross the
    // latitude limit once turned.
    const v = fitBounds([-60, 70, 60, 84], 1200, 300);
    expect(fitsWorld(v)).toBe(true);
    expect(fitsWorld({ ...v, bearing: 30 })).toBe(false);
    expect(fitsWorld({ ...v, bearing: 180 })).toBe(true);
  });
});
