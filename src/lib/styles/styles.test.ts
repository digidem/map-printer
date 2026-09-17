import type { StyleSpecification } from "maplibre-gl";
import { describe, expect, it } from "vitest";
import {
  buildStyle,
  ensureOpaqueBackground,
  fetchAttribution,
  resolveInput,
  transformRequestFor,
  type FetchLike,
  type StyleInput,
} from "./index.ts";

interface FakeFetch {
  fetch: FetchLike;
  calls: string[];
}

function fakeFetch(routes: Record<string, unknown>): FakeFetch {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (!(url in routes)) return new Response("nope", { status: 404 });
    const body = routes[url];
    if (typeof body === "string") return new Response(body, { status: 200 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as FetchLike;
  return { fetch: fetchImpl, calls };
}

const MINIMAL_STYLE = {
  version: 8,
  sources: {},
  layers: [{ id: "bg", type: "background" }],
};

describe("resolveInput", () => {
  it("recognises Mapbox style URLs without fetching", async () => {
    const f = fakeFetch({});
    const input = await resolveInput(
      "  https://api.mapbox.com/styles/v1/acme/ckabc123?access_token=pk.url  ",
      f.fetch,
    );
    expect(input).toEqual({
      kind: "mapbox",
      url: "mapbox://styles/acme/ckabc123",
      ref: {
        owner: "acme",
        styleId: "ckabc123",
        draft: false,
        accessToken: "pk.url",
      },
    });
    expect(f.calls).toEqual([]);
  });

  it("recognises tile templates without fetching", async () => {
    const f = fakeFetch({});
    const xyz = "https://tiles.example.com/{z}/{x}/{y}.png";
    const quadkey = "https://ecn.{subdomain}.example.com/a{quadkey}.jpeg";
    expect(await resolveInput(xyz, f.fetch)).toEqual({
      kind: "raster",
      url: xyz,
    });
    expect(await resolveInput(quadkey, f.fetch)).toEqual({
      kind: "raster",
      url: quadkey,
    });
    expect(f.calls).toEqual([]);
  });

  it("fetches a plain URL once and recognises a MapLibre style", async () => {
    const f = fakeFetch({ "https://example.com/style.json": MINIMAL_STYLE });
    const input = await resolveInput("https://example.com/style.json", f.fetch);
    expect(input?.kind).toBe("style");
    expect(input).toMatchObject({ style: { version: 8 } });
    expect(f.calls).toEqual(["https://example.com/style.json"]);
  });

  it("recognises TileJSON and its vector/raster kind", async () => {
    const raster = await resolveInput(
      "https://example.com/raster.json",
      fakeFetch({
        "https://example.com/raster.json": {
          tilejson: "2.2.0",
          tiles: ["https://example.com/{z}/{x}/{y}.png"],
          format: "png",
        },
      }).fetch,
    );
    expect(raster).toMatchObject({ kind: "tilejson", tileKind: "raster" });

    const pbf = await resolveInput(
      "https://example.com/v.json",
      fakeFetch({
        "https://example.com/v.json": { tilejson: "2.2.0", format: "pbf" },
      }).fetch,
    );
    expect(pbf).toMatchObject({ kind: "tilejson", tileKind: "vector" });

    const vectorLayers = await resolveInput(
      "https://example.com/vl.json",
      fakeFetch({
        "https://example.com/vl.json": {
          tiles: ["https://example.com/{z}/{x}/{y}.mvt"],
          vector_layers: [{ id: "water" }],
        },
      }).fetch,
    );
    expect(vectorLayers).toMatchObject({
      kind: "tilejson",
      tileKind: "vector",
    });
  });

  it("returns null for garbage", async () => {
    const f = fakeFetch({
      "https://example.com/other.json": { hello: "world" },
      "https://example.com/text": "not json at all",
    });
    expect(await resolveInput("", f.fetch)).toBeNull();
    expect(await resolveInput("not a url", f.fetch)).toBeNull();
    for (const bad of [
      "ftp://example.com/style.json",
      "https://example.com/404.json",
      "https://example.com/other.json",
      "https://example.com/text",
    ]) {
      expect(await resolveInput(bad, f.fetch)).toBeNull();
    }
    expect(f.calls).toEqual([
      "https://example.com/404.json",
      "https://example.com/other.json",
      "https://example.com/text",
    ]);
  });
});

describe("buildStyle", () => {
  it("normalises a Mapbox style URL when a token is available", async () => {
    const input = (await resolveInput(
      "mapbox://styles/acme/ckabc123/draft",
      fakeFetch({}).fetch,
    ))!;
    expect(buildStyle(input, { mapboxToken: "pk.form" })).toBe(
      "https://api.mapbox.com/styles/v1/acme/ckabc123/draft?access_token=pk.form",
    );
    expect(buildStyle(input)).toBe("mapbox://styles/acme/ckabc123/draft");
  });

  it("prefers the explicit token over the one in the pasted URL", async () => {
    const input = (await resolveInput(
      "https://api.mapbox.com/styles/v1/acme/s1?access_token=pk.url",
      fakeFetch({}).fetch,
    ))!;
    expect(buildStyle(input)).toContain("access_token=pk.url");
    expect(buildStyle(input, { mapboxToken: "pk.form" })).toContain(
      "access_token=pk.form",
    );
  });

  it("passes a style URL through", () => {
    const input: StyleInput = {
      kind: "style",
      url: "https://example.com/style.json",
      style: MINIMAL_STYLE as StyleSpecification,
    };
    expect(buildStyle(input, {})).toBe("https://example.com/style.json");
  });

  it("wraps a tile template in a raster style, expanding subdomains", () => {
    const style = buildStyle({
      kind: "raster",
      url: "https://{s}.tiles.example.com/{z}/{x}/{y}.png",
    }) as StyleSpecification;
    expect(style.sources.tiles).toMatchObject({
      type: "raster",
      tileSize: 256,
      scheme: "xyz",
      tiles: [
        "https://a.tiles.example.com/{z}/{x}/{y}.png",
        "https://b.tiles.example.com/{z}/{x}/{y}.png",
        "https://c.tiles.example.com/{z}/{x}/{y}.png",
      ],
    });
    expect(style.layers.map((l) => l.type)).toEqual(["background", "raster"]);
  });

  it("wraps a TileJSON in a style of the matching source type", () => {
    const vector = buildStyle({
      kind: "tilejson",
      url: "https://example.com/v.json",
      tileKind: "vector",
      tilejson: {},
    }) as StyleSpecification;
    expect(vector.sources.src).toMatchObject({
      type: "vector",
      url: "https://example.com/v.json",
    });

    const raster = buildStyle({
      kind: "tilejson",
      url: "https://example.com/r.json",
      tileKind: "raster",
      tilejson: {},
    }) as StyleSpecification;
    expect(raster.sources.src).toMatchObject({
      type: "raster",
      url: "https://example.com/r.json",
    });
  });
});

describe("transformRequestFor", () => {
  it("rewrites mapbox:// URLs and leaves others alone", async () => {
    const input = (await resolveInput(
      "mapbox://styles/acme/s1",
      fakeFetch({}).fetch,
    ))!;
    const transform = transformRequestFor(input, "pk.form")!;
    expect(transform).toBeTypeOf("function");
    expect(transform("mapbox://sprites/acme/s1@2x.png")).toEqual({
      url: "https://api.mapbox.com/styles/v1/acme/s1/sprite@2x.png?access_token=pk.form",
    });
    expect(transform("mapbox://fonts/acme/Arial/0-255.pbf")).toEqual({
      url: "https://api.mapbox.com/fonts/v1/acme/Arial/0-255.pbf?access_token=pk.form",
    });
    expect(transform("https://example.com/tiles/1/2/3.png")).toEqual({
      url: "https://example.com/tiles/1/2/3.png",
    });
  });

  it("is undefined for non-Mapbox input", () => {
    expect(
      transformRequestFor({ kind: "raster", url: "https://e/{z}/{x}/{y}.png" }),
    ).toBeUndefined();
    expect(
      transformRequestFor(
        {
          kind: "style",
          url: "https://example.com/style.json",
          style: MINIMAL_STYLE as StyleSpecification,
        },
        "pk.form",
      ),
    ).toBeUndefined();
  });
});

describe("ensureOpaqueBackground", () => {
  it("prepends a white background only when there is none", () => {
    const style = {
      version: 8,
      sources: {},
      layers: [{ id: "tiles", type: "raster", source: "tiles" }],
    } as unknown as StyleSpecification;
    const once = ensureOpaqueBackground(style);
    expect(once.layers[0]).toEqual({
      id: "map-printer-background",
      type: "background",
      paint: { "background-color": "#ffffff" },
    });
    expect(once.layers).toHaveLength(2);
    expect(style.layers).toHaveLength(1);

    const twice = ensureOpaqueBackground(once);
    expect(twice).toBe(once);
    expect(twice.layers).toHaveLength(2);
  });
});

describe("fetchAttribution", () => {
  it("strips HTML, dedupes, and follows source TileJSON urls", async () => {
    const osm =
      '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
    const style = {
      version: 8,
      sources: {
        a: {
          type: "raster",
          tiles: ["https://e/{z}/{x}/{y}.png"],
          attribution: osm,
        },
        b: {
          type: "raster",
          tiles: ["https://f/{z}/{x}/{y}.png"],
          attribution: osm,
        },
        c: { type: "vector", url: "https://example.com/v.json" },
        d: { type: "raster", url: "/relative.json" },
      },
      layers: [],
    } as unknown as StyleSpecification;
    const f = fakeFetch({
      "https://example.com/v.json": { attribution: osm },
      "https://example.com/relative.json": {
        attribution: "Tiles &copy; <b>Acme</b> &amp; friends",
      },
    });
    const input: StyleInput = {
      kind: "style",
      url: "https://example.com/dir/style.json",
      style,
    };

    expect(await fetchAttribution(style, input, f.fetch)).toEqual([
      "© OpenStreetMap contributors",
      "Tiles © Acme & friends",
    ]);
  });

  it("uses the already-parsed TileJSON instead of refetching it", async () => {
    const input: StyleInput = {
      kind: "tilejson",
      url: "https://example.com/r.json",
      tileKind: "raster",
      tilejson: { attribution: "<span>Acme&nbsp;Maps</span>" },
    };
    const f = fakeFetch({});
    const style = buildStyle(input) as StyleSpecification;
    expect(await fetchAttribution(style, input, f.fetch)).toEqual(["Acme Maps"]);
    expect(f.calls).toEqual([]);
  });

  it("leaves out-of-range numeric entities as written", async () => {
    const input: StyleInput = {
      kind: "tilejson",
      url: "https://example.com/r.json",
      tileKind: "raster",
      tilejson: { attribution: "Bad &#1114112; and &#xFFFFFFFF; entity" },
    };
    const f = fakeFetch({});
    const style = buildStyle(input) as StyleSpecification;
    expect(await fetchAttribution(style, input, f.fetch)).toEqual([
      "Bad &#1114112; and &#xFFFFFFFF; entity",
    ]);
  });

  it("normalises mapbox:// source urls with the token", async () => {
    const input = (await resolveInput(
      "mapbox://styles/acme/s1",
      fakeFetch({}).fetch,
    ))!;
    const style = {
      version: 8,
      sources: { mb: { type: "vector", url: "mapbox://mapbox.streets-v8" } },
      layers: [],
    } as unknown as StyleSpecification;
    const f = fakeFetch({
      "https://api.mapbox.com/v4/mapbox.streets-v8.json?secure=&access_token=pk.form":
        { attribution: "<a>© Mapbox</a>" },
    });
    expect(await fetchAttribution(style, input, f.fetch, "pk.form")).toEqual([
      "© Mapbox",
    ]);
  });

  it("skips sources whose attribution cannot be fetched", async () => {
    const style = {
      version: 8,
      sources: {
        gone: { type: "raster", url: "https://example.com/missing.json" },
        mb: { type: "vector", url: "mapbox://mapbox.streets-v8" },
      },
      layers: [],
    } as unknown as StyleSpecification;
    const input: StyleInput = {
      kind: "raster",
      url: "https://e/{z}/{x}/{y}.png",
    };
    const f = fakeFetch({});
    expect(await fetchAttribution(style, input, f.fetch)).toEqual([]);
  });
});
