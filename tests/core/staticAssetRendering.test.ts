import { describe, expect, it } from "vitest";
import { renderStaticAsset } from "../../src/core/staticAssetRendering";

function expectFiniteSvgCoordinates(html: string): void {
  for (const match of html.matchAll(/\bpoints="([^"]+)"/g)) {
    const values = match[1]!.match(/-?(?:\d+(?:\.\d+)?|\.\d+)/g) ?? [];
    expect(values.length % 2).toBe(0);
    for (let index = 0; index < values.length; index += 2) {
      const x = Number(values[index]);
      const y = Number(values[index + 1]);
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(640);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(360);
    }
  }
  for (const match of html.matchAll(/\b(cx|cy|x|y)="([^"]+)"/g)) {
    const value = Number(match[2]);
    const maximum = match[1] === "cy" || match[1] === "y" ? 360 : 640;
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(maximum);
  }
}

describe("static asset rendering", () => {
  it("renders GeoJSON points, lines, and polygons in a bounded SVG", () => {
    const source = JSON.stringify({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name: "Tokyo Station" },
          geometry: { type: "Point", coordinates: [139.7671, 35.6812] },
        },
        {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: [
              [139.767, 35.68],
              [139.768, 35.682],
            ],
          },
        },
        {
          type: "Feature",
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [139.766, 35.68],
                [139.769, 35.68],
                [139.769, 35.683],
              ],
            ],
          },
        },
      ],
    });

    const html = renderStaticAsset("geojson", source);
    expect(html).not.toBeNull();
    expect(html).toContain("Static GEOJSON preview");
    expect(html).toContain("<circle");
    expect(html).toContain("<polyline");
    expect(html).toContain("<polygon");
    expect(html).toContain("Tokyo Station (139.7671, 35.6812)");
    expectFiniteSvgCoordinates(html!);
  });

  it("decodes transformed TopoJSON points and arcs", () => {
    const source = JSON.stringify({
      type: "Topology",
      transform: { scale: [0.5, 0.5], translate: [10, 20] },
      objects: {
        places: {
          type: "GeometryCollection",
          geometries: [
            {
              type: "Point",
              properties: { name: "Station" },
              coordinates: [1, 2],
            },
            { type: "LineString", arcs: [0] },
            { type: "Polygon", arcs: [[0]] },
          ],
        },
      },
      arcs: [
        [
          [0, 0],
          [4, 0],
          [0, 4],
          [-4, 0],
          [0, -4],
        ],
      ],
    });

    const html = renderStaticAsset("topojson", source);
    expect(html).not.toBeNull();
    expect(html).toContain("Static TOPOJSON preview");
    expect(html).toContain("Station (10.5, 21)");
    expect(html).toContain("<circle");
    expect(html).toContain("<polyline");
    expect(html).toContain("<polygon");
    expectFiniteSvgCoordinates(html!);
  });

  it("keeps untransformed TopoJSON arcs in absolute coordinates", () => {
    const source = JSON.stringify({
      type: "Topology",
      objects: {
        shape: {
          type: "GeometryCollection",
          geometries: [
            { type: "LineString", arcs: [0] },
            {
              type: "Point",
              properties: { name: "Endpoint" },
              coordinates: [140, 36],
            },
          ],
        },
      },
      arcs: [
        [
          [139, 35],
          [140, 36],
        ],
      ],
    });

    const html = renderStaticAsset("topojson", source);
    expect(html).not.toBeNull();
    const point = html!.match(/<circle cx="([^"]+)" cy="([^"]+)"/);
    const line = html!.match(/<polyline points="([^"]+)"/);
    if (!point || !line)
      throw new Error("expected point and line SVG elements");
    expect(line[1]).toContain(point[1] + "," + point[2]);

    const pointOnly = renderStaticAsset(
      "geojson",
      JSON.stringify({ type: "Point", coordinates: [1, 1] }),
    );
    expect(pointOnly).not.toBeNull();
    expect(pointOnly!).toMatch(/<circle cx="320" cy="180"/);
  });

  it("renders ASCII STL faces as a local projected triangle preview", () => {
    const source = [
      "solid triangle",
      "  facet normal 0 0 1",
      "    outer loop",
      "      vertex 0 0 0",
      "      vertex 2 0 0",
      "      vertex 0 2 1",
      "    endloop",
      "  endfacet",
      "endsolid triangle",
    ].join("\n");

    const html = renderStaticAsset("stl", source);
    expect(html).not.toBeNull();
    expect(html).toContain(
      "Static STL preview (offline; projected ASCII triangles).",
    );
    expect(html).toContain("<polygon");
    expect(html).not.toMatch(/NaN|Infinity/);
    expectFiniteSvgCoordinates(html!);
  });

  it("escapes hostile labels and keeps them inert in SVG text", () => {
    const source = JSON.stringify({
      type: "Feature",
      properties: {
        name: '<img src=x onerror="alert(1)"><script>alert(2)</script>&',
      },
      geometry: { type: "Point", coordinates: [1, 2] },
    });

    const html = renderStaticAsset("geojson", source);
    expect(html).not.toBeNull();
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("&amp;");
  });

  it("returns null for malformed, empty, unsupported, or oversized assets", () => {
    expect(renderStaticAsset("geojson", "not json")).toBeNull();
    expect(renderStaticAsset("geojson", "")).toBeNull();
    expect(
      renderStaticAsset(
        "geojson",
        JSON.stringify({ type: "FeatureCollection", features: [] }),
      ),
    ).toBeNull();
    expect(
      renderStaticAsset(
        "geojson",
        JSON.stringify({ type: "Feature", geometry: { type: "Circle" } }),
      ),
    ).toBeNull();
    expect(renderStaticAsset("geojson", "x".repeat(200_001))).toBeNull();
    expect(
      renderStaticAsset(
        "topojson",
        JSON.stringify({ type: "Topology", objects: {}, arcs: [] }),
      ),
    ).toBeNull();
    expect(renderStaticAsset("stl", "solid empty\nendsolid empty")).toBeNull();
  });
});
