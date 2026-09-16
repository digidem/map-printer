import { describe, expect, it } from "vitest";
import {
  type Bbox,
  type Viewport,
  MAX_LATITUDE,
  fitBounds,
  isValidBbox,
  mmToPx,
  project,
  tileGrid,
  unproject,
  viewportBbox,
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

  it("rejects non-positive input", () => {
    expect(() => mmToPx(0, 96)).toThrow(TypeError);
    expect(() => mmToPx(210, 0)).toThrow(TypeError);
    expect(() => mmToPx(Number.NaN, 96)).toThrow(TypeError);
  });
});
