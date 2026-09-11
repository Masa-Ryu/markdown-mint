export type StaticAssetKind = "geojson" | "topojson" | "stl";

const MAX_SOURCE_LENGTH = 200_000;
const MAX_COORDINATE_ABS = 1_000_000_000;
const MAX_GEOMETRIES = 1_000;
const MAX_COORDINATES = 12_000;
const MAX_LABEL_LENGTH = 120;
const MAX_STL_FACES = 500;
const SVG_WIDTH = 640;
const SVG_HEIGHT = 360;
const SVG_PADDING = 28;

type Coordinate = [number, number];

interface ScenePoint {
  readonly coordinate: Coordinate;
  readonly label: string;
}

interface ScenePath {
  readonly coordinates: Coordinate[];
  readonly closed: boolean;
}

interface Scene {
  readonly points: ScenePoint[];
  readonly paths: ScenePath[];
  coordinateCount: number;
}

interface TopoTransform {
  readonly scale: Coordinate;
  readonly translate: Coordinate;
  readonly deltaEncoded: boolean;
}

interface TopoContext {
  readonly arcs: unknown[];
  readonly transform: TopoTransform;
  readonly decodedArcs: Array<Coordinate[] | undefined>;
}

class InvalidAsset extends Error {}

function invalid(): never {
  throw new InvalidAsset();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSource(source: unknown): asserts source is string {
  if (
    typeof source !== "string" ||
    source.trim().length === 0 ||
    source.length > MAX_SOURCE_LENGTH
  )
    invalid();
}

function assertFiniteCoordinate(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE_ABS)
    invalid();
  return value;
}

function readCoordinate(value: unknown): Coordinate {
  if (!Array.isArray(value) || value.length < 2) invalid();
  const x = value[0];
  const y = value[1];
  if (typeof x !== "number" || typeof y !== "number") invalid();
  return [assertFiniteCoordinate(x), assertFiniteCoordinate(y)];
}

function readCoordinates(value: unknown, minimum: number): Coordinate[] {
  if (!Array.isArray(value) || value.length < minimum) invalid();
  return value.map((entry) => readCoordinate(entry));
}

function coordinateEqual(left: Coordinate, right: Coordinate): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

function numberText(value: number, digits = 2): string {
  if (!Number.isFinite(value)) invalid();
  const rounded = Number(value.toFixed(digits));
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function labelText(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (typeof value === "number" && !Number.isFinite(value)) return undefined;
  const normalized =
    typeof value === "number"
      ? numberText(value, 4)
      : value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > MAX_LABEL_LENGTH
    ? normalized.slice(0, MAX_LABEL_LENGTH - 1).trimEnd() + "..."
    : normalized;
}

function labelFor(value: Record<string, unknown>): string | undefined {
  const properties = isRecord(value.properties) ? value.properties : undefined;
  const candidates: unknown[] = [
    properties?.name,
    properties?.title,
    properties?.label,
    value.id,
  ];
  for (const candidate of candidates) {
    const label = labelText(candidate);
    if (label) return label;
  }
  return undefined;
}

function pointLabel(label: string | undefined, coordinate: Coordinate): string {
  const coordinates =
    "(" +
    numberText(coordinate[0], 4) +
    ", " +
    numberText(coordinate[1], 4) +
    ")";
  return label ? label + " " + coordinates : coordinates;
}

function createScene(): Scene {
  return { points: [], paths: [], coordinateCount: 0 };
}

function reserveGeometry(scene: Scene): void {
  if (scene.points.length + scene.paths.length >= MAX_GEOMETRIES) invalid();
}

function reserveCoordinates(scene: Scene, count: number): void {
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    scene.coordinateCount + count > MAX_COORDINATES
  )
    invalid();
  scene.coordinateCount += count;
}

function addPoint(
  scene: Scene,
  coordinate: Coordinate,
  label: string | undefined,
): void {
  reserveGeometry(scene);
  reserveCoordinates(scene, 1);
  scene.points.push({
    coordinate,
    label: pointLabel(label, coordinate),
  });
}

function addPath(
  scene: Scene,
  coordinates: Coordinate[],
  closed: boolean,
): void {
  if (coordinates.length < 2) invalid();
  let normalized = coordinates;
  if (closed && !coordinateEqual(coordinates[0]!, coordinates.at(-1)!))
    normalized = [...coordinates, coordinates[0]!];
  reserveGeometry(scene);
  reserveCoordinates(scene, normalized.length);
  scene.paths.push({ coordinates: normalized, closed });
}

function collectGeoJSON(
  value: unknown,
  scene: Scene,
  inheritedLabel?: string,
): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  const type = value.type;
  if (type === "Feature") {
    if (value.geometry === null) return false;
    return collectGeoGeometry(
      value.geometry,
      scene,
      labelFor(value) ?? inheritedLabel,
    );
  }
  if (type === "FeatureCollection") {
    if (!Array.isArray(value.features)) invalid();
    let collected = false;
    for (const feature of value.features)
      collected = collectGeoJSON(feature, scene, inheritedLabel) || collected;
    return collected;
  }
  if (type === "GeometryCollection") {
    if (!Array.isArray(value.geometries)) invalid();
    let collected = false;
    for (const geometry of value.geometries)
      collected = collectGeoJSON(geometry, scene, inheritedLabel) || collected;
    return collected;
  }
  return collectGeoGeometry(value, scene, inheritedLabel ?? labelFor(value));
}

function collectGeoGeometry(
  value: unknown,
  scene: Scene,
  inheritedLabel?: string,
): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  const coordinates = value.coordinates;
  switch (value.type) {
    case "Point":
      addPoint(scene, readCoordinate(coordinates), inheritedLabel);
      return true;
    case "MultiPoint": {
      const points = readCoordinates(coordinates, 1);
      for (const point of points) addPoint(scene, point, inheritedLabel);
      return true;
    }
    case "LineString":
      addPath(scene, readCoordinates(coordinates, 2), false);
      return true;
    case "MultiLineString": {
      if (!Array.isArray(coordinates) || coordinates.length < 1) invalid();
      let collected = false;
      for (const line of coordinates) {
        addPath(scene, readCoordinates(line, 2), false);
        collected = true;
      }
      return collected;
    }
    case "Polygon": {
      if (!Array.isArray(coordinates) || coordinates.length < 1) invalid();
      let collected = false;
      for (const ring of coordinates) {
        addPath(scene, readCoordinates(ring, 3), true);
        collected = true;
      }
      return collected;
    }
    case "MultiPolygon": {
      if (!Array.isArray(coordinates) || coordinates.length < 1) invalid();
      let collected = false;
      for (const polygon of coordinates) {
        if (!Array.isArray(polygon) || polygon.length < 1) invalid();
        for (const ring of polygon) {
          addPath(scene, readCoordinates(ring, 3), true);
          collected = true;
        }
      }
      return collected;
    }
    case "GeometryCollection":
      if (!Array.isArray(value.geometries)) invalid();
      {
        let collected = false;
        for (const geometry of value.geometries)
          collected =
            collectGeoJSON(geometry, scene, inheritedLabel) || collected;
        return collected;
      }
    default:
      return false;
  }
}

function readTopoPair(value: unknown): Coordinate {
  if (!Array.isArray(value) || value.length < 2) invalid();
  const x = value[0];
  const y = value[1];
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    Math.abs(x) > MAX_COORDINATE_ABS ||
    Math.abs(y) > MAX_COORDINATE_ABS
  )
    invalid();
  return [x, y];
}

function readTopoTransform(value: unknown): TopoTransform {
  if (value === undefined)
    return { scale: [1, 1], translate: [0, 0], deltaEncoded: false };
  if (!isRecord(value)) invalid();
  const scale = readTopoPair(value.scale);
  const translate = readTopoPair(value.translate);
  return { scale, translate, deltaEncoded: true };
}

function transformTopoCoordinate(
  value: unknown,
  transform: TopoTransform,
  delta: Coordinate = [0, 0],
): Coordinate {
  const encoded = readTopoPair(value);
  const x = encoded[0] + delta[0];
  const y = encoded[1] + delta[1];
  return [
    assertFiniteCoordinate(x * transform.scale[0] + transform.translate[0]),
    assertFiniteCoordinate(y * transform.scale[1] + transform.translate[1]),
  ];
}

function createTopoContext(value: Record<string, unknown>): TopoContext {
  if (value.arcs !== undefined && !Array.isArray(value.arcs)) invalid();
  const arcs = Array.isArray(value.arcs) ? value.arcs : [];
  if (arcs.length > MAX_COORDINATES) invalid();
  return {
    arcs,
    transform: readTopoTransform(value.transform),
    decodedArcs: Array.from({ length: arcs.length }),
  };
}

function decodeTopoArc(index: number, context: TopoContext): Coordinate[] {
  if (!Number.isInteger(index) || index < 0 || index >= context.arcs.length)
    invalid();
  const cached = context.decodedArcs[index];
  if (cached) return cached;
  const rawArc = context.arcs[index];
  if (!Array.isArray(rawArc) || rawArc.length < 1) invalid();
  const decoded: Coordinate[] = [];
  if (!context.transform.deltaEncoded) {
    for (const pair of rawArc) {
      const coordinate = readTopoPair(pair);
      decoded.push([
        assertFiniteCoordinate(coordinate[0]),
        assertFiniteCoordinate(coordinate[1]),
      ]);
    }
  } else {
    let delta: Coordinate = [0, 0];
    for (const pair of rawArc) {
      const encoded = readTopoPair(pair);
      delta = [delta[0] + encoded[0], delta[1] + encoded[1]];
      decoded.push(
        transformTopoCoordinate(encoded, context.transform, [
          delta[0] - encoded[0],
          delta[1] - encoded[1],
        ]),
      );
    }
  }
  context.decodedArcs[index] = decoded;
  return decoded;
}

function coordinatesFromTopoArcs(
  value: unknown,
  context: TopoContext,
): Coordinate[] {
  if (!Array.isArray(value) || value.length < 1) invalid();
  const coordinates: Coordinate[] = [];
  for (const rawReference of value) {
    if (typeof rawReference !== "number" || !Number.isInteger(rawReference))
      invalid();
    const reversed = rawReference < 0;
    const index = reversed ? ~rawReference : rawReference;
    const arc = decodeTopoArc(index, context);
    const ordered = reversed ? [...arc].reverse() : arc;
    for (const coordinate of ordered) {
      if (
        coordinates.length === 0 ||
        !coordinateEqual(coordinates.at(-1)!, coordinate)
      )
        coordinates.push(coordinate);
    }
  }
  return coordinates;
}

function collectTopoGeometry(
  value: unknown,
  scene: Scene,
  context: TopoContext,
  inheritedLabel?: string,
): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "Point":
      addPoint(
        scene,
        transformTopoCoordinate(value.coordinates, context.transform),
        inheritedLabel,
      );
      return true;
    case "MultiPoint": {
      if (!Array.isArray(value.coordinates) || value.coordinates.length < 1)
        invalid();
      for (const coordinate of value.coordinates)
        addPoint(
          scene,
          transformTopoCoordinate(coordinate, context.transform),
          inheritedLabel,
        );
      return true;
    }
    case "LineString":
      addPath(scene, coordinatesFromTopoArcs(value.arcs, context), false);
      return true;
    case "MultiLineString": {
      if (!Array.isArray(value.arcs) || value.arcs.length < 1) invalid();
      for (const line of value.arcs)
        addPath(scene, coordinatesFromTopoArcs(line, context), false);
      return true;
    }
    case "Polygon": {
      if (!Array.isArray(value.arcs) || value.arcs.length < 1) invalid();
      for (const ring of value.arcs)
        addPath(scene, coordinatesFromTopoArcs(ring, context), true);
      return true;
    }
    case "MultiPolygon": {
      if (!Array.isArray(value.arcs) || value.arcs.length < 1) invalid();
      for (const polygon of value.arcs) {
        if (!Array.isArray(polygon) || polygon.length < 1) invalid();
        for (const ring of polygon)
          addPath(scene, coordinatesFromTopoArcs(ring, context), true);
      }
      return true;
    }
    case "GeometryCollection":
      if (!Array.isArray(value.geometries)) invalid();
      {
        let collected = false;
        for (const geometry of value.geometries) {
          const geometryLabel =
            labelFor(isRecord(geometry) ? geometry : {}) ?? inheritedLabel;
          collected =
            collectTopoGeometry(geometry, scene, context, geometryLabel) ||
            collected;
        }
        return collected;
      }
    default:
      return false;
  }
}

function collectTopoJSON(value: unknown, scene: Scene): boolean {
  if (!isRecord(value) || value.type !== "Topology" || !isRecord(value.objects))
    return false;
  const context = createTopoContext(value);
  let collected = false;
  for (const object of Object.values(value.objects)) {
    collected =
      collectTopoGeometry(
        object,
        scene,
        context,
        labelFor(isRecord(object) ? object : {}),
      ) || collected;
  }
  return collected;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function boundedSvgNumber(value: number): string {
  if (!Number.isFinite(value)) invalid();
  return numberText(Math.min(SVG_WIDTH, Math.max(0, value)), 2);
}

function projectScene(scene: Scene): {
  readonly paths: Array<{
    readonly coordinates: Coordinate[];
    readonly closed: boolean;
  }>;
  readonly points: Array<{
    readonly coordinate: Coordinate;
    readonly label: string;
  }>;
} {
  const coordinates: Coordinate[] = [];
  for (const path of scene.paths) coordinates.push(...path.coordinates);
  for (const point of scene.points) coordinates.push(point.coordinate);
  if (coordinates.length === 0) invalid();

  const xs = coordinates.map((coordinate) => coordinate[0]);
  const ys = coordinates.map((coordinate) => coordinate[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const rangeX = maxX - minX;
  const rangeY = maxY - minY;
  const usableWidth = SVG_WIDTH - SVG_PADDING * 2;
  const usableHeight = SVG_HEIGHT - SVG_PADDING * 2;
  const scale =
    rangeX === 0 && rangeY === 0
      ? 1
      : rangeX === 0
        ? usableHeight / rangeY
        : rangeY === 0
          ? usableWidth / rangeX
          : Math.min(usableWidth / rangeX, usableHeight / rangeY);
  const offsetX = SVG_PADDING + (usableWidth - rangeX * scale) / 2;
  const offsetY = SVG_PADDING + (usableHeight - rangeY * scale) / 2;
  const project = (coordinate: Coordinate): Coordinate => [
    rangeX === 0 ? SVG_WIDTH / 2 : offsetX + (coordinate[0] - minX) * scale,
    rangeY === 0
      ? SVG_HEIGHT / 2
      : SVG_HEIGHT - (offsetY + (coordinate[1] - minY) * scale),
  ];
  return {
    paths: scene.paths.map((path) => ({
      coordinates: path.coordinates.map(project),
      closed: path.closed,
    })),
    points: scene.points.map((point) => ({
      coordinate: project(point.coordinate),
      label: point.label,
    })),
  };
}

function renderScene(kind: StaticAssetKind, scene: Scene): string {
  const projected = projectScene(scene);
  const label =
    kind === "stl" ? "STL" : kind === "geojson" ? "GEOJSON" : "TOPOJSON";
  const caption =
    kind === "stl"
      ? "Static STL preview (offline; projected ASCII triangles)."
      : "Static " + label + " preview (offline).";
  let content = "";
  for (const path of projected.paths) {
    const points = path.coordinates
      .map(
        (coordinate) =>
          boundedSvgNumber(coordinate[0]) +
          "," +
          boundedSvgNumber(coordinate[1]),
      )
      .join(" ");
    if (path.closed)
      content +=
        '<polygon points="' +
        points +
        '" fill="currentColor" fill-opacity="0.14" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"></polygon>';
    else
      content +=
        '<polyline points="' +
        points +
        '" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></polyline>';
  }
  for (const point of projected.points) {
    const x = point.coordinate[0];
    const y = point.coordinate[1];
    const labelX = Math.min(SVG_WIDTH - 8, Math.max(8, x + 7));
    const labelY = Math.min(SVG_HEIGHT - 6, Math.max(14, y - 8));
    content +=
      '<circle cx="' +
      boundedSvgNumber(x) +
      '" cy="' +
      boundedSvgNumber(y) +
      '" r="4" fill="currentColor"></circle>' +
      '<text x="' +
      boundedSvgNumber(labelX) +
      '" y="' +
      boundedSvgNumber(labelY) +
      '" fill="currentColor" font-size="12" font-family="sans-serif">' +
      escapeHtml(point.label) +
      "</text>";
  }
  return (
    '<div class="mm-static-asset mm-static-' +
    kind +
    '" data-mm-asset-kind="' +
    kind +
    '">' +
    '<p class="mm-asset-status">' +
    escapeHtml(caption) +
    "</p>" +
    '<svg class="mm-static-asset-svg" viewBox="0 0 640 360" role="img" aria-label="' +
    escapeHtml("Static " + label + " preview") +
    '">' +
    "<title>" +
    escapeHtml("Static " + label + " preview") +
    "</title>" +
    content +
    "</svg></div>"
  );
}

const stlNumber = "[+-]?(?:(?:\\d+(?:\\.\\d*)?)|(?:\\.\\d+))(?:[eE][+-]?\\d+)?";
const stlVertexPattern = new RegExp(
  "^\\s*vertex\\s+(" +
    stlNumber +
    ")\\s+(" +
    stlNumber +
    ")\\s+(" +
    stlNumber +
    ")\\s*$",
  "i",
);
const stlFacetPattern = new RegExp(
  "^\\s*facet\\s+normal\\s+(" +
    stlNumber +
    ")\\s+(" +
    stlNumber +
    ")\\s+(" +
    stlNumber +
    ")\\s*$",
  "i",
);

function renderStl(source: string): string | null {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const firstLine = lines[0]?.replace(/^\uFEFF/, "") ?? "";
  if (!/^\s*solid(?:\s|$)/i.test(firstLine)) return null;
  const faces: Array<Array<[number, number, number]>> = [];
  let current: Array<[number, number, number]> | undefined;
  let inLoop = false;
  let sawEndSolid = false;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line) continue;
    if (/^endsolid(?:\s|$)/i.test(line)) {
      if (current || inLoop || sawEndSolid) return null;
      sawEndSolid = true;
      continue;
    }
    if (sawEndSolid) return null;

    const facet = stlFacetPattern.exec(line);
    if (facet) {
      if (current || inLoop) return null;
      const normal = [Number(facet[1]), Number(facet[2]), Number(facet[3])];
      if (
        normal.some(
          (value) =>
            !Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE_ABS,
        )
      )
        return null;
      current = [];
      continue;
    }
    if (/^outer\s+loop$/i.test(line)) {
      if (!current || inLoop) return null;
      inLoop = true;
      continue;
    }

    const vertex = stlVertexPattern.exec(line);
    if (vertex) {
      if (!current || !inLoop || current.length >= 3) return null;
      const values = [Number(vertex[1]), Number(vertex[2]), Number(vertex[3])];
      if (
        values.some(
          (value) =>
            !Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE_ABS,
        )
      )
        return null;
      current.push([values[0]!, values[1]!, values[2]!]);
      continue;
    }
    if (/^endloop$/i.test(line)) {
      if (!current || !inLoop || current.length !== 3) return null;
      inLoop = false;
      continue;
    }
    if (/^endfacet$/i.test(line)) {
      if (!current || inLoop || current.length !== 3) return null;
      faces.push(current);
      current = undefined;
      if (faces.length > MAX_STL_FACES) return null;
      continue;
    }
    return null;
  }

  if (!sawEndSolid || current || inLoop || faces.length === 0) return null;
  const scene = createScene();
  for (const face of faces) {
    const projected: Coordinate[] = [];
    for (const [x, y, z] of face) {
      projected.push([
        assertFiniteCoordinate(x - y * 0.5),
        assertFiniteCoordinate(z + (x + y) * 0.25),
      ]);
    }
    addPath(scene, projected, true);
  }
  return renderScene("stl", scene);
}

function renderGeoJSON(source: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    return null;
  }
  const scene = createScene();
  try {
    if (!collectGeoJSON(parsed, scene) || scene.coordinateCount === 0)
      return null;
    return renderScene("geojson", scene);
  } catch {
    return null;
  }
}

function renderTopoJSON(source: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    return null;
  }
  const scene = createScene();
  try {
    if (!collectTopoJSON(parsed, scene) || scene.coordinateCount === 0)
      return null;
    return renderScene("topojson", scene);
  } catch {
    return null;
  }
}

export function renderStaticAsset(
  kind: StaticAssetKind,
  source: string,
): string | null {
  try {
    assertSource(source);
    if (kind === "stl") return renderStl(source);
    if (kind === "geojson") return renderGeoJSON(source);
    if (kind === "topojson") return renderTopoJSON(source);
    return null;
  } catch {
    return null;
  }
}
