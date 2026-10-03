import {
  enhanceCodeBlockControls,
  type CodeBlockControlOptions,
} from "./codeBlockControls";
import {
  MAX_MERMAID_SOURCE_LENGTH,
  ensureMermaidRuntime,
  mermaidRuntimeFromGlobal,
  normalizeMermaidSource,
  type MermaidRuntime,
} from "./mermaidValidation";
import {
  mermaidDiagramColors,
  mermaidTextColorForBackground,
  type MermaidPalette,
} from "./mermaidTheme";

export {
  MAX_MERMAID_SOURCE_LENGTH,
  MERMAID_RUNTIME_READY_EVENT,
  ensureMermaidRuntime,
  mermaidRuntimeFromGlobal,
  normalizeMermaidSource,
} from "./mermaidValidation";
export type { MermaidRuntime } from "./mermaidValidation";

export interface RenderingEnhancer {
  dispose(): void;
  invalidate(): void;
}

const MERMAID_SELECTOR = '[data-mm-mermaid="true"]';
const MERMAID_FIRST_USE_START_MARK = "markdown-mint-mermaid-first-use";
const MERMAID_FIRST_USE_END_MARK = "markdown-mint-mermaid-first-rendered";
const configuredThemes = new WeakMap<object, string>();
let nextMermaidId = 0;
let firstMermaidUseMarked = false;
let firstMermaidRenderMarked = false;

function markPerformance(name: string): void {
  try {
    globalThis.performance?.mark(name);
  } catch {
    // Performance marks are diagnostic only and must never affect rendering.
  }
}

function themeHostElement(root: ParentNode, ownerDocument: Document): Element {
  if (root instanceof Element) return root;
  return ownerDocument.body ?? ownerDocument.documentElement;
}

function themeClassPresent(ownerDocument: Document, name: string): boolean {
  const elements = [ownerDocument.documentElement, ownerDocument.body].filter(
    (element): element is HTMLElement => Boolean(element),
  );
  return elements.some((element) => element.classList.contains(name));
}

function hasUsableMermaidColor(value: string): boolean {
  return (
    /^#[0-9a-f]{3,8}$/i.test(value) ||
    /^(?:rgb|rgba|hsl|hsla)\(/i.test(value) ||
    /^(?:transparent|black|white|gray|grey)$/i.test(value)
  );
}

function paletteColor(
  styles: readonly CSSStyleDeclaration[],
  names: readonly string[],
  fallback: string,
): string {
  for (const style of styles)
    for (const name of names) {
      const value = style.getPropertyValue(name).trim();
      if (value && !value.includes("var(") && hasUsableMermaidColor(value))
        return value;
    }
  return fallback;
}

function mermaidPalette(
  root: ParentNode,
  ownerDocument: Document,
): MermaidPalette {
  const element = themeHostElement(root, ownerDocument);
  const view = ownerDocument.defaultView;
  const style = view?.getComputedStyle(element);
  const dark =
    themeClassPresent(ownerDocument, "vscode-dark") ||
    themeClassPresent(ownerDocument, "vscode-high-contrast") ||
    (!themeClassPresent(ownerDocument, "vscode-light") &&
      !themeClassPresent(ownerDocument, "vscode-high-contrast-light") &&
      (view?.matchMedia
        ? view.matchMedia("(prefers-color-scheme: dark)").matches
        : true));
  const highContrast =
    themeClassPresent(ownerDocument, "vscode-high-contrast") ||
    themeClassPresent(ownerDocument, "vscode-high-contrast-light");
  const defaults = highContrast
    ? dark
      ? {
          background: "#000000",
          foreground: "#ffffff",
          surface: "#000000",
          line: "#ffffff",
          accent: "#00a8ff",
          darkMode: true,
          highContrast: true,
          chartColors: [],
        }
      : {
          background: "#ffffff",
          foreground: "#000000",
          surface: "#ffffff",
          line: "#000000",
          accent: "#0000ee",
          darkMode: false,
          highContrast: true,
          chartColors: [],
        }
    : dark
      ? {
          background: "#1e1e1e",
          foreground: "#d4d4d4",
          surface: "#252526",
          line: "#9da5b4",
          accent: "#3794ff",
          darkMode: true,
          highContrast: false,
          chartColors: [],
        }
      : {
          background: "#ffffff",
          foreground: "#1f2328",
          surface: "#f6f8fa",
          line: "#57606a",
          accent: "#0969da",
          darkMode: false,
          highContrast: false,
          chartColors: [],
        };
  if (!style) return defaults;
  const styles = [style];
  if (view) {
    styles.push(view.getComputedStyle(ownerDocument.documentElement));
    if (ownerDocument.body)
      styles.push(view.getComputedStyle(ownerDocument.body));
  }
  const foreground = paletteColor(
    styles,
    ["--vscode-editor-foreground", "--vscode-foreground"],
    defaults.foreground,
  );
  const background = paletteColor(
    styles,
    ["--vscode-editor-background", "--vscode-background"],
    defaults.background,
  );
  const surface = paletteColor(
    styles,
    [
      "--vscode-textCodeBlock-background",
      "--vscode-editorWidget-background",
      "--vscode-sideBar-background",
    ],
    defaults.surface,
  );
  const line = paletteColor(
    styles,
    [
      "--vscode-descriptionForeground",
      "--vscode-textSeparator-foreground",
      "--vscode-panel-border",
    ],
    defaults.line,
  );
  const accent = paletteColor(
    styles,
    ["--vscode-textLink-foreground", "--vscode-focusBorder"],
    defaults.accent,
  );
  const defaultChartColors = mermaidDiagramColors(defaults).chart;
  const chartVariableNames = [
    "--vscode-charts-blue",
    "--vscode-charts-orange",
    "--vscode-charts-green",
    "--vscode-charts-red",
    "--vscode-charts-purple",
    "--vscode-charts-yellow",
  ];
  const chartColors = [
    ...chartVariableNames.map((name, index) =>
      paletteColor(styles, [name], defaultChartColors[index]!),
    ),
    ...defaultChartColors.slice(chartVariableNames.length),
  ];
  const fontFamily = style.fontFamily.trim();
  return {
    background,
    foreground,
    surface,
    line,
    accent,
    darkMode: defaults.darkMode,
    highContrast: defaults.highContrast,
    chartColors,
    ...(fontFamily ? { fontFamily } : {}),
  };
}

function themeVariables(palette: MermaidPalette): Record<string, unknown> {
  const { background, foreground, surface, line, accent, fontFamily } = palette;
  const diagramColors = mermaidDiagramColors(palette);
  const variables: Record<string, unknown> = {
    darkMode: palette.darkMode,
    background,
    primaryColor: surface,
    primaryTextColor: foreground,
    primaryBorderColor: accent,
    secondaryColor: surface,
    secondaryTextColor: foreground,
    secondaryBorderColor: line,
    tertiaryColor: background,
    tertiaryTextColor: foreground,
    tertiaryBorderColor: line,
    lineColor: line,
    arrowheadColor: line,
    textColor: foreground,
    mainBkg: surface,
    nodeBkg: surface,
    nodeBorder: accent,
    nodeTextColor: foreground,
    clusterBkg: background,
    clusterBorder: line,
    defaultLinkColor: line,
    titleColor: foreground,
    edgeLabelColor: foreground,
    edgeLabelBackground: background,
    actorBkg: surface,
    actorBorder: accent,
    actorTextColor: foreground,
    actorLineColor: line,
    labelBoxBkgColor: background,
    labelBoxBorderColor: line,
    labelTextColor: foreground,
    signalColor: line,
    signalTextColor: foreground,
    loopTextColor: foreground,
    noteBkgColor: surface,
    noteBorderColor: line,
    noteTextColor: foreground,
    activationBorderColor: line,
    activationBkgColor: surface,
    sequenceNumberColor: foreground,
    sectionBkgColor: diagramColors.gantt.section,
    sectionBkgColor2: diagramColors.gantt.alternateSection,
    altSectionBkgColor: diagramColors.gantt.alternateSection,
    gridColor: diagramColors.gantt.grid,
    taskBkgColor: diagramColors.gantt.task,
    taskBorderColor: diagramColors.gantt.taskBorder,
    taskTextColor: diagramColors.gantt.taskText,
    taskTextOutsideColor: diagramColors.gantt.outsideText,
    taskTextDarkColor: diagramColors.gantt.taskText,
    taskTextClickableColor: accent,
    activeTaskBkgColor: diagramColors.gantt.activeTask,
    activeTaskBorderColor: diagramColors.gantt.activeTaskBorder,
    doneTaskBkgColor: diagramColors.gantt.doneTask,
    doneTaskBorderColor: diagramColors.gantt.doneTaskBorder,
    critBkgColor: diagramColors.gantt.criticalTask,
    critBorderColor: diagramColors.gantt.criticalTaskBorder,
    todayLineColor: diagramColors.gantt.today,
    vertLineColor: diagramColors.gantt.grid,
    excludeBkgColor: diagramColors.gantt.alternateSection,
    transitionColor: line,
    transitionLabelColor: foreground,
    stateLabelColor: foreground,
    rowOdd: diagramColors.rowOdd,
    rowEven: diagramColors.rowEven,
    pieTitleTextColor: foreground,
    pieSectionTextColor: foreground,
    pieLegendTextColor: foreground,
    pieStrokeColor: line,
    pieStrokeWidth: "2px",
    pieOuterStrokeColor: line,
    pieOuterStrokeWidth: "2px",
    pieOpacity: "1",
    ...(fontFamily ? { fontFamily } : {}),
  };
  for (let index = 0; index < 12; index += 1) {
    const color = diagramColors.chart[index]!;
    variables[`pie${index + 1}`] = color;
    variables[`cScale${index}`] = color;
    variables[`cScaleLabel${index}`] = diagramColors.chartText[index]!;
    variables[`cScalePeer${index}`] = color;
    variables[`cScaleInv${index}`] = line;
    variables[`lineColor${index}`] = line;
  }
  return variables;
}

function initializeRuntimeTheme(
  runtime: MermaidRuntime,
  root: ParentNode,
  ownerDocument: Document,
): { palette: MermaidPalette; variables: Record<string, unknown> } {
  const palette = mermaidPalette(root, ownerDocument);
  const variables = themeVariables(palette);
  const signature = JSON.stringify(variables);
  const runtimeObject = runtime as object;
  if (configuredThemes.get(runtimeObject) === signature)
    return { palette, variables };
  runtime.initialize?.({
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    deterministicIds: true,
    theme: "base",
    themeVariables: variables,
  });
  configuredThemes.set(runtimeObject, signature);
  return { palette, variables };
}

export function enhanceMixedTaskCheckboxes(root: ParentNode): void {
  const boxes = Array.from(
    root.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"][data-task-state="mixed"]',
    ),
  );
  const rootElement = root as Element;
  if (
    typeof rootElement.matches === "function" &&
    rootElement.matches('input[type="checkbox"][data-task-state="mixed"]')
  )
    boxes.unshift(rootElement as HTMLInputElement);
  for (const checkbox of boxes) {
    if (!checkbox.indeterminate) checkbox.indeterminate = true;
    if (checkbox.getAttribute("aria-checked") !== "mixed")
      checkbox.setAttribute("aria-checked", "mixed");
  }
}

function textForStatus(element: HTMLElement, value: string): void {
  const status = element.querySelector<HTMLElement>(".mm-diagram-status");
  if (status) status.textContent = value;
}

function connectedToRoot(
  root: ParentNode,
  element: HTMLElement,
  ownerDocument: Document,
): boolean {
  if (root === element) return true;
  const rootElement = root as Element;
  if (typeof rootElement.contains === "function")
    return rootElement.contains(element);
  return element.isConnected && root === ownerDocument;
}

const SAFE_LOCAL_CSS_FRAGMENT = /^#[A-Za-z0-9_.:-]+$/;

function sanitizeCssText(value: string): string {
  let sanitized = value.replace(/@import\b[^;]*(?:;|$)/gi, "");
  sanitized = sanitized.replace(
    /url\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi,
    (
      _match: string,
      doubleQuoted: string | undefined,
      singleQuoted: string | undefined,
      unquoted: string | undefined,
    ) => {
      const candidate = String(
        doubleQuoted ?? singleQuoted ?? unquoted ?? "",
      ).trim();
      return SAFE_LOCAL_CSS_FRAGMENT.test(candidate)
        ? "url(" + candidate + ")"
        : "none";
    },
  );
  if (/(?:javascript|vbscript|expression\s*\()/i.test(sanitized)) return "";
  return sanitized;
}

function sanitizeSvg(svg: string, ownerDocument: Document): SVGElement | null {
  const template = ownerDocument.createElement("template");
  template.innerHTML = svg;
  const candidate = template.content.firstElementChild;
  if (!candidate || candidate.tagName.toLowerCase() !== "svg") return null;
  const forbidden = new Set([
    "base",
    "embed",
    "foreignobject",
    "form",
    "iframe",
    "link",
    "object",
    "script",
  ]);
  const elements = [candidate, ...Array.from(candidate.querySelectorAll("*"))];
  for (const element of elements) {
    if (forbidden.has(element.tagName.toLowerCase())) {
      element.remove();
      continue;
    }
    if (element.tagName.toLowerCase() === "style") {
      const sanitized = sanitizeCssText(element.textContent ?? "");
      if (sanitized) element.textContent = sanitized;
      else element.remove();
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (
        name.startsWith("on") ||
        name === "src" ||
        name === "href" ||
        name === "xlink:href"
      ) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === "style") {
        const sanitized = sanitizeCssText(value);
        if (sanitized) element.setAttribute(attribute.name, sanitized);
        else element.removeAttribute(attribute.name);
        continue;
      }
      if (/^(?:javascript|data|vbscript):/i.test(value))
        element.removeAttribute(attribute.name);
    }
  }
  return candidate as unknown as SVGElement;
}

/** Mermaid's Git graph arrows are wide paths that must remain unfilled. */
function normalizeGitGraphSvg(svg: SVGElement): void {
  if (svg.getAttribute("aria-roledescription") !== "gitGraph") return;

  for (const arrow of Array.from(
    svg.querySelectorAll<SVGPathElement>("path.arrow"),
  )) {
    arrow.style.setProperty("fill", "none", "important");
  }
}

function normalizeClassDiagramSvg(
  svg: SVGElement,
  palette: MermaidPalette,
  root: ParentNode,
  ownerDocument: Document,
): void {
  if (svg.getAttribute("aria-roledescription") !== "classDiagram") return;

  for (const surface of Array.from(
    svg.querySelectorAll<SVGElement>(".node.default .label-container"),
  )) {
    setImportantStyle(surface, "fill", palette.surface);
    setImportantStyle(surface, "stroke", palette.accent);
    setImportantStyle(surface, "stroke-width", "1.5px");
  }
  for (const divider of Array.from(
    svg.querySelectorAll<SVGElement>(
      ".node.default .divider path, .node.default .divider line",
    ),
  )) {
    setImportantStyle(divider, "fill", "none");
    setImportantStyle(divider, "stroke", palette.accent);
    setImportantStyle(divider, "stroke-width", "1px");
  }
  for (const shape of Array.from(
    svg.querySelectorAll<SVGElement>(".cluster rect, .classLabel .box"),
  )) {
    setImportantStyle(shape, "fill", palette.surface);
    setImportantStyle(shape, "stroke", palette.line);
  }
  for (const text of Array.from(
    svg.querySelectorAll<SVGElement>(
      ".node.default text, .node.default tspan, .classLabel text, .edgeTerminals",
    ),
  )) {
    setImportantStyle(text, "fill", palette.foreground);
    setImportantStyle(text, "color", palette.foreground);
  }
  for (const terminal of Array.from(
    svg.querySelectorAll<SVGTextElement>(".edgeTerminals"),
  )) {
    setImportantStyle(terminal, "stroke", palette.background);
    setImportantStyle(terminal, "stroke-width", "4px");
    setImportantStyle(terminal, "stroke-linejoin", "round");
    setImportantStyle(terminal, "paint-order", "stroke fill");
  }

  for (const relation of Array.from(
    svg.querySelectorAll<SVGPathElement>("path.relation"),
  )) {
    setImportantStyle(relation, "fill", "none");
    setImportantStyle(relation, "stroke", palette.line);
    setImportantStyle(relation, "stroke-width", "1px");
  }

  for (const marker of Array.from(
    svg.querySelectorAll<SVGMarkerElement>('marker[id*="classDiagram-"]'),
  )) {
    const id = marker.id;
    const hollow =
      /classDiagram-(?:extension|aggregation)(?:Start|End)(?:-|$)/.test(id);
    const surface = /classDiagram-lollipop(?:Start|End)$/.test(id);
    const fill = hollow
      ? "transparent"
      : surface
        ? palette.surface
        : palette.line;
    for (const shape of Array.from(
      marker.querySelectorAll<SVGElement>("path, circle, polygon"),
    )) {
      setImportantStyle(shape, "fill", fill);
      setImportantStyle(shape, "stroke", palette.line);
      setImportantStyle(shape, "stroke-width", "1px");
    }
  }

  separateClassDiagramTerminalLabels(svg, root, ownerDocument);
}

interface SvgScreenRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function rectsOverlap(left: SvgScreenRect, right: SvgScreenRect): boolean {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

function markerScreenRect(
  svg: SVGElement,
  relation: SVGPathElement,
  side: "start" | "end",
): SvgScreenRect | undefined {
  if (
    typeof relation.getTotalLength !== "function" ||
    typeof relation.getPointAtLength !== "function" ||
    typeof relation.getScreenCTM !== "function"
  )
    return undefined;
  const reference = relation.getAttribute(`marker-${side}`);
  const id = reference?.match(/#([^)]+)/)?.[1];
  const marker = id ? svg.ownerDocument.getElementById(id) : null;
  const shape = marker?.querySelector<SVGGraphicsElement>(
    "path, circle, polygon",
  );
  if (!marker || !shape || typeof shape.getBBox !== "function")
    return undefined;

  try {
    const length = relation.getTotalLength();
    if (!Number.isFinite(length) || length <= 0) return undefined;
    const pointLength = side === "end" ? length : 0;
    const nearbyLength =
      side === "end" ? Math.max(0, length - 0.1) : Math.min(length, 0.1);
    const endpoint = relation.getPointAtLength(pointLength);
    const nearby = relation.getPointAtLength(nearbyLength);
    let angle = Math.atan2(endpoint.y - nearby.y, endpoint.x - nearby.x);
    const orient = marker.getAttribute("orient")?.trim();
    if (side === "start" && orient !== "auto-start-reverse") angle += Math.PI;
    if (orient && orient !== "auto" && orient !== "auto-start-reverse") {
      const degrees = Number.parseFloat(orient);
      if (Number.isFinite(degrees)) angle = (degrees * Math.PI) / 180;
    }

    const shapeBox = shape.getBBox();
    const refX = Number.parseFloat(marker.getAttribute("refX") ?? "0") || 0;
    const refY = Number.parseFloat(marker.getAttribute("refY") ?? "0") || 0;
    const matrix = relation.getScreenCTM();
    if (!matrix) return undefined;
    const cornerCoordinates: ReadonlyArray<readonly [number, number]> = [
      [shapeBox.x, shapeBox.y],
      [shapeBox.x + shapeBox.width, shapeBox.y],
      [shapeBox.x, shapeBox.y + shapeBox.height],
      [shapeBox.x + shapeBox.width, shapeBox.y + shapeBox.height],
    ];
    const corners = cornerCoordinates.map(([x, y]) => {
      const dx = x - refX;
      const dy = y - refY;
      const point = (svg as SVGSVGElement).createSVGPoint();
      point.x = endpoint.x + dx * Math.cos(angle) - dy * Math.sin(angle);
      point.y = endpoint.y + dx * Math.sin(angle) + dy * Math.cos(angle);
      return point.matrixTransform(matrix);
    });
    const xs = corners.map((point) => point.x);
    const ys = corners.map((point) => point.y);
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    };
  } catch {
    return undefined;
  }
}

function translateTextByScreenDelta(
  text: SVGTextElement,
  deltaX: number,
  deltaY: number,
): boolean {
  const matrix = text.getScreenCTM();
  if (!matrix || typeof text.getBoundingClientRect !== "function") return false;
  try {
    const inverse = matrix.inverse();
    const box = text.getBoundingClientRect();
    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;
    const origin = text.ownerSVGElement?.createSVGPoint();
    if (!origin) return false;
    origin.x = centerX;
    origin.y = centerY;
    const target = origin.matrixTransform(inverse);
    origin.x += deltaX;
    origin.y += deltaY;
    const shifted = origin.matrixTransform(inverse);
    const localX = shifted.x - target.x;
    const localY = shifted.y - target.y;
    if (!Number.isFinite(localX) || !Number.isFinite(localY)) return false;
    const transform = text.getAttribute("transform")?.trim();
    text.setAttribute(
      "transform",
      `${transform ? `${transform} ` : ""}translate(${localX} ${localY})`,
    );
    return true;
  } catch {
    return false;
  }
}

/** Move class relationship labels only when they overlap another SVG item. */
function separateClassDiagramTerminalLabels(
  svg: SVGElement,
  root: ParentNode,
  ownerDocument: Document,
): void {
  const labels = Array.from(
    svg.querySelectorAll<SVGTextElement>(".edgeTerminals"),
  );
  if (!labels.length) return;
  const measuringHost = ownerDocument.createElement("div");
  const diagram = ownerDocument.createElement("div");
  measuringHost.className = "markdown-body mm-document-content";
  diagram.className = "mm-mermaid";
  const rootElement = root as Element;
  const width =
    typeof (rootElement as HTMLElement).getBoundingClientRect === "function"
      ? (rootElement as HTMLElement).getBoundingClientRect().width
      : 0;
  const viewportWidth = Math.max(
    320,
    width || ownerDocument.documentElement?.clientWidth || 1024,
  );
  measuringHost.style.cssText =
    `position:fixed;left:-100000px;top:0;width:${viewportWidth}px;` +
    "visibility:hidden;pointer-events:none;";
  measuringHost.setAttribute("aria-hidden", "true");
  measuringHost.append(diagram);
  diagram.append(svg);
  ownerDocument.body?.append(measuringHost);
  try {
    const relations = Array.from(
      svg.querySelectorAll<SVGPathElement>("path.relation"),
    );
    const markerRects = relations.flatMap((relation) =>
      (["start", "end"] as const)
        .map((side) => markerScreenRect(svg, relation, side))
        .filter((rect): rect is SvgScreenRect => Boolean(rect)),
    );
    const cardRects = Array.from(
      svg.querySelectorAll<SVGGraphicsElement>(
        ".node.default .label-container",
      ),
      (card) => {
        const rect = card.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      },
    );
    const relatedLabels = Array.from(
      svg.querySelectorAll<Element>(".edgeLabel, .edgeTerminals"),
    );
    const svgBounds = svg.getBoundingClientRect();
    const fontSize = Number.parseFloat(getComputedStyle(svg).fontSize) || 14;
    const gap = Math.max(2, fontSize * 0.12);
    for (const label of labels) {
      const rect = label.getBoundingClientRect();
      const labelBox = {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
      if (!labelBox.width || !labelBox.height) continue;
      const overlappingLabels = relatedLabels
        .filter((otherLabel) => otherLabel !== label)
        .map((otherLabel) => {
          const otherRect = otherLabel.getBoundingClientRect();
          return {
            x: otherRect.x,
            y: otherRect.y,
            width: otherRect.width,
            height: otherRect.height,
          };
        })
        .filter((other) => rectsOverlap(labelBox, other));
      const overlappingObstacles = [
        ...markerRects.filter((marker) => rectsOverlap(labelBox, marker)),
        ...cardRects.filter((card) => rectsOverlap(labelBox, card)),
        ...overlappingLabels,
      ];
      if (!overlappingObstacles.length) continue;
      const moves = overlappingObstacles.flatMap((obstacle) => [
        { x: obstacle.x - labelBox.x - labelBox.width - gap, y: 0 },
        { x: obstacle.x + obstacle.width - labelBox.x + gap, y: 0 },
        { x: 0, y: obstacle.y - labelBox.y - labelBox.height - gap },
        { x: 0, y: obstacle.y + obstacle.height - labelBox.y + gap },
      ]);
      moves.sort(
        (left, right) =>
          Math.hypot(left.x, left.y) - Math.hypot(right.x, right.y),
      );
      const move = moves.find((candidate) => {
        const shifted = {
          ...labelBox,
          x: labelBox.x + candidate.x,
          y: labelBox.y + candidate.y,
        };
        const insideSvg =
          shifted.x >= svgBounds.x &&
          shifted.y >= svgBounds.y &&
          shifted.x + shifted.width <= svgBounds.x + svgBounds.width &&
          shifted.y + shifted.height <= svgBounds.y + svgBounds.height;
        return (
          insideSvg &&
          !markerRects.some((marker) => rectsOverlap(shifted, marker)) &&
          !cardRects.some((card) => rectsOverlap(shifted, card)) &&
          !relatedLabels.some((otherLabel) => {
            if (otherLabel === label) return false;
            const otherRect = otherLabel.getBoundingClientRect();
            return rectsOverlap(shifted, {
              x: otherRect.x,
              y: otherRect.y,
              width: otherRect.width,
              height: otherRect.height,
            });
          })
        );
      });
      if (move) translateTextByScreenDelta(label, move.x, move.y);
    }
  } finally {
    measuringHost.remove();
  }
}

function setImportantStyle(
  element: SVGElement,
  property: string,
  value: string,
): void {
  element.style.setProperty(property, value, "important");
}

function pieCategoryForPath(
  path: SVGPathElement,
  index: number,
  colors: readonly string[],
): number {
  const sourceColor = path.getAttribute("fill")?.trim().toLowerCase();
  const found = sourceColor
    ? colors.findIndex((color) => color.toLowerCase() === sourceColor)
    : -1;
  return found >= 0 ? found : index % colors.length;
}

function normalizedPiePaint(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(normalized)?.[1];
  if (hex)
    return hex.length === 3
      ? "#" + Array.from(hex, (channel) => channel + channel).join("")
      : "#" + hex;
  const channels = /^rgba?\(([^)]+)\)$/
    .exec(normalized)?.[1]
    ?.split(/[ ,/]+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((channel) => Math.min(255, Math.max(0, Number.parseFloat(channel))));
  if (!channels || channels.length !== 3 || channels.some(Number.isNaN))
    return undefined;
  return (
    "#" +
    channels
      .map((channel) => Math.round(channel).toString(16).padStart(2, "0"))
      .join("")
  );
}

function pieArc(
  path: SVGPathElement,
): { start: number; end: number; sweep: number } | undefined {
  const numbers =
    /^M\s*([-+.\deE]+)[,\s]+([-+.\deE]+)A\s*[-+.\deE]+[,\s]+[-+.\deE]+[,\s]+[-+.\deE]+[,\s]+([01])[,\s]+([01])[,\s]+([-+.\deE]+)[,\s]+([-+.\deE]+)/i.exec(
      path.getAttribute("d") ?? "",
    );
  if (!numbers) return undefined;
  const startX = Number(numbers[1]);
  const startY = Number(numbers[2]);
  const endX = Number(numbers[5]);
  const endY = Number(numbers[6]);
  const start = (Math.atan2(startY, startX) * 180) / Math.PI;
  const end = (Math.atan2(endY, endX) * 180) / Math.PI;
  return { start, end, sweep: Number(numbers[4]) };
}

function pieLabelPosition(
  label: SVGTextElement,
): { x: number; y: number } | undefined {
  const values = /translate\(\s*([-+.\deE]+)[,\s]+([-+.\deE]+)/i.exec(
    label.getAttribute("transform") ?? "",
  );
  if (!values) return undefined;
  const x = Number(values[1]);
  const y = Number(values[2]);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}

function pieLabelCategory(
  label: SVGTextElement,
  paths: readonly SVGPathElement[],
  pathCategories: readonly number[],
  labelIndex: number,
): number {
  const position = pieLabelPosition(label);
  if (position) {
    const angle = (Math.atan2(position.y, position.x) * 180) / Math.PI;
    for (let index = 0; index < paths.length; index += 1) {
      const arc = pieArc(paths[index]!);
      if (!arc) continue;
      const distance =
        arc.sweep === 1
          ? (angle - arc.start + 360) % 360
          : (arc.start - angle + 360) % 360;
      const size =
        arc.sweep === 1
          ? (arc.end - arc.start + 360) % 360
          : (arc.start - arc.end + 360) % 360;
      if (distance <= size + 0.5) return pathCategories[index]!;
    }
  }
  return pathCategories[labelIndex % pathCategories.length] ?? 0;
}

function normalizeErSvg(svg: SVGElement, palette: MermaidPalette): void {
  const colors = mermaidDiagramColors(palette);
  for (const row of Array.from(
    svg.querySelectorAll<SVGGElement>(".row-rect-odd, .row-rect-even"),
  )) {
    const odd = row.classList.contains("row-rect-odd");
    const background = row.querySelector<SVGPathElement>(":scope > path");
    if (background) {
      setImportantStyle(
        background,
        "fill",
        odd ? colors.rowOdd : colors.rowEven,
      );
      setImportantStyle(background, "stroke", "none");
    }
    for (const border of Array.from(
      row.querySelectorAll<SVGPathElement>(":scope > path ~ path"),
    )) {
      setImportantStyle(border, "fill", "none");
      setImportantStyle(border, "stroke", palette.line);
      setImportantStyle(border, "stroke-width", "1.3px");
    }
  }
  for (const outer of Array.from(
    svg.querySelectorAll<SVGGElement>(".outer-path"),
  )) {
    const [background, ...borders] = Array.from(
      outer.querySelectorAll<SVGPathElement>(":scope > path"),
    );
    if (background) setImportantStyle(background, "fill", palette.surface);
    for (const border of borders) {
      setImportantStyle(border, "fill", "none");
      setImportantStyle(border, "stroke", palette.line);
    }
  }
  for (const divider of Array.from(
    svg.querySelectorAll<SVGGElement>(".divider"),
  )) {
    const [fill, ...lines] = Array.from(
      divider.querySelectorAll<SVGPathElement>(":scope > path"),
    );
    if (fill) setImportantStyle(fill, "fill", palette.line);
    for (const line of lines) {
      setImportantStyle(line, "fill", "none");
      setImportantStyle(line, "stroke", palette.line);
    }
  }
  for (const line of Array.from(
    svg.querySelectorAll<SVGPathElement>(".relationshipLine"),
  )) {
    setImportantStyle(line, "fill", "none");
    setImportantStyle(line, "stroke", palette.line);
    setImportantStyle(line, "stroke-width", "1px");
  }
  for (const marker of Array.from(
    svg.querySelectorAll<SVGElement>(".marker.er path, .marker.er circle"),
  )) {
    setImportantStyle(marker, "fill", palette.surface);
    setImportantStyle(marker, "stroke", palette.line);
    setImportantStyle(marker, "stroke-width", "1px");
  }
  for (const label of Array.from(
    svg.querySelectorAll<SVGGElement>(".edgeLabel"),
  )) {
    for (const background of Array.from(
      label.querySelectorAll<SVGRectElement>("rect, .background"),
    )) {
      setImportantStyle(background, "fill", palette.surface);
      setImportantStyle(background, "stroke", palette.line);
    }
    for (const text of Array.from(
      label.querySelectorAll<SVGTextElement>("text, tspan"),
    )) {
      setImportantStyle(text, "fill", palette.foreground);
      setImportantStyle(text, "color", palette.foreground);
    }
  }
}

function normalizePieSvg(svg: SVGElement, palette: MermaidPalette): void {
  const colors = mermaidDiagramColors(palette);
  const paths = Array.from(
    svg.querySelectorAll<SVGPathElement>("path.pieCircle"),
  );
  const pathCategories = paths.map((path, index) =>
    pieCategoryForPath(path, index, colors.chart),
  );
  paths.forEach((path, index) => {
    const color = colors.chart[pathCategories[index]!]!;
    setImportantStyle(path, "fill", color);
    setImportantStyle(
      path,
      "stroke",
      mermaidTextColorForBackground(color, palette.line, 3),
    );
    setImportantStyle(path, "stroke-width", "2px");
    setImportantStyle(path, "opacity", "1");
  });
  for (const label of Array.from(
    svg.querySelectorAll<SVGTextElement>("text.slice"),
  )) {
    const group = label.parentElement;
    const groupPaths = group
      ? Array.from(group.querySelectorAll<SVGPathElement>("path.pieCircle"))
      : paths;
    const categories = groupPaths.map((path, index) =>
      pieCategoryForPath(path, index, colors.chart),
    );
    const category = pieLabelCategory(
      label,
      groupPaths,
      categories,
      Array.from(svg.querySelectorAll("text.slice")).indexOf(label),
    );
    const textColor = colors.chartText[category] ?? palette.foreground;
    setImportantStyle(label, "fill", textColor);
    setImportantStyle(label, "color", textColor);
  }
  for (const circle of Array.from(
    svg.querySelectorAll<SVGCircleElement>(".pieOuterCircle"),
  )) {
    setImportantStyle(circle, "fill", "none");
    setImportantStyle(circle, "stroke", palette.line);
    setImportantStyle(circle, "stroke-width", "2px");
  }
  const legendRows = Array.from(svg.querySelectorAll<SVGGElement>(".legend"));
  legendRows.forEach((legend, index) => {
    const swatch = legend.querySelector<SVGRectElement>("rect");
    if (!swatch) return;
    const originalColor = normalizedPiePaint(swatch.style.fill);
    const category = colors.chart.findIndex(
      (color) => color.toLowerCase() === originalColor,
    );
    const fallbackCategory =
      pathCategories[index] ?? index % colors.chart.length;
    const color = colors.chart[category >= 0 ? category : fallbackCategory]!;
    setImportantStyle(swatch, "fill", color);
    setImportantStyle(swatch, "stroke", palette.line);
    setImportantStyle(swatch, "stroke-width", "1px");
  });
  for (const text of Array.from(
    svg.querySelectorAll<SVGTextElement>(".pieTitleText, .legend text"),
  )) {
    setImportantStyle(text, "fill", palette.foreground);
    setImportantStyle(text, "color", palette.foreground);
  }
}

function normalizeTimelineSvg(svg: SVGElement, palette: MermaidPalette): void {
  const colors = mermaidDiagramColors(palette);
  for (const node of Array.from(
    svg.querySelectorAll<SVGGElement>(".timeline-node"),
  )) {
    const section = Array.from(node.classList).find((name) =>
      /^section-(?:-?\d+)$/.test(name),
    );
    const sectionIndex =
      section === "section--1"
        ? 0
        : section
          ? Number(section.slice("section-".length)) + 1
          : 0;
    const index =
      ((sectionIndex % colors.chart.length) + colors.chart.length) %
      colors.chart.length;
    const background = colors.chart[index]!;
    const foreground = colors.chartText[index]!;
    const border = mermaidTextColorForBackground(background, palette.line, 3);
    for (const shape of Array.from(
      node.querySelectorAll<SVGElement>(".node-bkg"),
    )) {
      setImportantStyle(shape, "fill", background);
      setImportantStyle(shape, "stroke", border);
      setImportantStyle(shape, "stroke-width", "1.5px");
    }
    for (const text of Array.from(
      node.querySelectorAll<SVGTextElement>("text, tspan"),
    )) {
      setImportantStyle(text, "fill", foreground);
      setImportantStyle(text, "color", foreground);
    }
  }
  for (const connector of Array.from(
    svg.querySelectorAll<SVGElement>(
      "[class^='section-edge-'], [class*=' section-edge-'], [class^='node-line-'], [class*=' node-line-']",
    ),
  )) {
    const shapes = connector.matches("path, line, polyline")
      ? [connector]
      : Array.from(
          connector.querySelectorAll<SVGElement>("path, line, polyline"),
        );
    for (const shape of shapes) {
      setImportantStyle(shape, "fill", "none");
      setImportantStyle(shape, "stroke", palette.line);
      setImportantStyle(shape, "stroke-width", "2px");
    }
  }
  for (const axis of Array.from(
    svg.querySelectorAll<SVGLineElement>(".lineWrapper line"),
  )) {
    setImportantStyle(axis, "fill", "none");
    setImportantStyle(axis, "stroke", palette.foreground);
    setImportantStyle(axis, "stroke-width", "1.5px");
  }
}

function sectionIndex(element: Element, prefix: string): number | undefined {
  for (const className of Array.from(element.classList)) {
    const match = new RegExp(`^${prefix}-(\\d+)$`).exec(className);
    if (match) return Number(match[1]);
  }
  return undefined;
}

function normalizeMindmapSvg(svg: SVGElement, palette: MermaidPalette): void {
  if (svg.getAttribute("aria-roledescription") !== "mindmap") return;
  const colors = mermaidDiagramColors(palette);
  const branchColor = (index: number | undefined): string =>
    index === undefined
      ? palette.line
      : (colors.chart[index % colors.chart.length] ?? palette.line);

  for (const node of Array.from(
    svg.querySelectorAll<SVGGElement>(".mindmap-node"),
  )) {
    const center = node.classList.contains("section-root");
    const index = sectionIndex(node, "section");
    const background = center ? palette.surface : branchColor(index);
    const foreground = center
      ? palette.foreground
      : (colors.chartText[
          index === undefined ? 0 : index % colors.chartText.length
        ] ?? palette.foreground);
    const border = mermaidTextColorForBackground(background, palette.line, 3);

    // Only generated node backgrounds receive node paint. In particular, keep
    // the separately-classed .edge paths out of this selection.
    for (const shape of Array.from(
      node.querySelectorAll<SVGElement>(".node-bkg, .label-container"),
    )) {
      setImportantStyle(shape, "fill", background);
      setImportantStyle(shape, "stroke", border);
      setImportantStyle(shape, "stroke-width", "1.5px");
    }
    for (const line of Array.from(
      node.querySelectorAll<SVGElement>(".node-line"),
    )) {
      setImportantStyle(line, "fill", "none");
      setImportantStyle(line, "stroke", border);
      setImportantStyle(line, "stroke-width", "1.5px");
      setImportantStyle(line, "stroke-linecap", "round");
    }
    for (const text of Array.from(
      node.querySelectorAll<SVGElement>("text, tspan"),
    )) {
      setImportantStyle(text, "fill", foreground);
      setImportantStyle(text, "color", foreground);
      if (center) setImportantStyle(text, "text-anchor", "middle");
    }
    for (const backgroundShape of Array.from(
      node.querySelectorAll<SVGElement>(".label rect.background"),
    )) {
      setImportantStyle(backgroundShape, "fill", "transparent");
      setImportantStyle(backgroundShape, "stroke", "none");
    }
  }

  for (const edge of Array.from(
    svg.querySelectorAll<SVGPathElement>("path.edge"),
  )) {
    const index = sectionIndex(edge, "section-edge");
    const depth = sectionIndex(edge, "edge-depth") ?? 1;
    const strokeWidth = Math.max(1.5, 3.5 - Math.max(0, depth - 1) * 0.4);
    setImportantStyle(edge, "fill", "none");
    setImportantStyle(edge, "stroke", branchColor(index));
    setImportantStyle(edge, "stroke-width", `${strokeWidth}px`);
    setImportantStyle(edge, "stroke-linecap", "round");
    setImportantStyle(edge, "stroke-linejoin", "round");
  }

  // Mermaid's optional .mindmap-node-label class relies on generated CSS for
  // full label centering. The shipped template uses translated label groups;
  // only its root circle needs a centered anchor because its tspan x=0 is the
  // circle center. Do not alter non-root anchors or vertical baselines.
  for (const label of Array.from(
    svg.querySelectorAll<SVGElement>(".mindmap-node-label"),
  )) {
    setImportantStyle(label, "text-anchor", "middle");
    setImportantStyle(label, "alignment-baseline", "middle");
    setImportantStyle(label, "dominant-baseline", "middle");
    setImportantStyle(label, "text-align", "center");
  }
}

function normalizeGanttSvg(svg: SVGElement, palette: MermaidPalette): void {
  if (svg.getAttribute("aria-roledescription") !== "gantt") return;
  const gantt = mermaidDiagramColors(palette).gantt;
  const variables: Readonly<Record<string, string>> = {
    "section-odd": gantt.section,
    "section-even": gantt.alternateSection,
    task: gantt.task,
    "task-border": gantt.taskBorder,
    "task-text": gantt.taskText,
    "outside-text": gantt.outsideText,
    active: gantt.activeTask,
    "active-border": gantt.activeTaskBorder,
    "active-text": gantt.activeTaskText,
    done: gantt.doneTask,
    "done-border": gantt.doneTaskBorder,
    "done-text": gantt.doneTaskText,
    crit: gantt.criticalTask,
    "crit-border": gantt.criticalTaskBorder,
    "crit-text": gantt.criticalTaskText,
    grid: gantt.grid,
    today: gantt.today,
  };
  for (const [name, value] of Object.entries(variables))
    svg.style.setProperty(`--mm-gantt-${name}`, value);

  for (const section of Array.from(
    svg.querySelectorAll<SVGElement>(".section"),
  )) {
    const alternate =
      section.classList.contains("section1") ||
      section.classList.contains("section3");
    setImportantStyle(
      section,
      "fill",
      alternate ? gantt.alternateSection : gantt.section,
    );
    setImportantStyle(section, "stroke", "none");
    setImportantStyle(section, "opacity", "1");
  }

  for (const task of Array.from(svg.querySelectorAll<SVGElement>(".task"))) {
    const active =
      task.classList.contains("active0") ||
      task.classList.contains("active1") ||
      task.classList.contains("active2") ||
      task.classList.contains("active3") ||
      task.classList.contains("activeCrit0") ||
      task.classList.contains("activeCrit1") ||
      task.classList.contains("activeCrit2") ||
      task.classList.contains("activeCrit3");
    const done =
      task.classList.contains("done0") ||
      task.classList.contains("done1") ||
      task.classList.contains("done2") ||
      task.classList.contains("done3") ||
      task.classList.contains("doneCrit0") ||
      task.classList.contains("doneCrit1") ||
      task.classList.contains("doneCrit2") ||
      task.classList.contains("doneCrit3");
    const critical = Array.from(task.classList).some((className) =>
      /^(?:crit|activeCrit|doneCrit)[0-3]$/.test(className),
    );
    setImportantStyle(
      task,
      "fill",
      active
        ? gantt.activeTask
        : done
          ? gantt.doneTask
          : critical
            ? gantt.criticalTask
            : gantt.task,
    );
    setImportantStyle(
      task,
      "stroke",
      critical
        ? gantt.criticalTaskBorder
        : active
          ? gantt.activeTaskBorder
          : done
            ? gantt.doneTaskBorder
            : gantt.taskBorder,
    );
    setImportantStyle(task, "stroke-width", "1.5px");
    setImportantStyle(task, "opacity", "1");
  }

  for (const label of Array.from(
    svg.querySelectorAll<SVGTextElement>(
      ".taskText, .taskTextOutsideLeft, .taskTextOutsideRight",
    ),
  )) {
    const outside =
      label.classList.contains("taskTextOutsideLeft") ||
      label.classList.contains("taskTextOutsideRight");
    const textColor = outside
      ? gantt.outsideText
      : label.classList.contains("doneCritText0") ||
          label.classList.contains("doneCritText1") ||
          label.classList.contains("doneCritText2") ||
          label.classList.contains("doneCritText3") ||
          label.classList.contains("doneText0") ||
          label.classList.contains("doneText1") ||
          label.classList.contains("doneText2") ||
          label.classList.contains("doneText3")
        ? gantt.doneTaskText
        : label.classList.contains("activeCritText0") ||
            label.classList.contains("activeCritText1") ||
            label.classList.contains("activeCritText2") ||
            label.classList.contains("activeCritText3") ||
            label.classList.contains("activeText0") ||
            label.classList.contains("activeText1") ||
            label.classList.contains("activeText2") ||
            label.classList.contains("activeText3")
          ? gantt.activeTaskText
          : label.classList.contains("critText0") ||
              label.classList.contains("critText1") ||
              label.classList.contains("critText2") ||
              label.classList.contains("critText3")
            ? gantt.criticalTaskText
            : gantt.taskText;
    setImportantStyle(label, "fill", textColor);
    setImportantStyle(label, "color", textColor);
    setImportantStyle(
      label,
      "text-anchor",
      label.classList.contains("taskTextOutsideRight")
        ? "start"
        : label.classList.contains("taskTextOutsideLeft")
          ? "end"
          : "middle",
    );
  }

  for (const title of Array.from(
    svg.querySelectorAll<SVGTextElement>(".titleText"),
  )) {
    setImportantStyle(title, "fill", palette.foreground);
    setImportantStyle(title, "color", palette.foreground);
    setImportantStyle(title, "text-anchor", "middle");
  }
  for (const title of Array.from(
    svg.querySelectorAll<SVGTextElement>(".sectionTitle"),
  )) {
    setImportantStyle(title, "fill", palette.foreground);
    setImportantStyle(title, "color", palette.foreground);
    setImportantStyle(title, "text-anchor", "start");
  }
  for (const label of Array.from(
    svg.querySelectorAll<SVGTextElement>(".grid .tick text, .vertText"),
  )) {
    setImportantStyle(label, "fill", palette.foreground);
    setImportantStyle(label, "color", palette.foreground);
  }
  for (const line of Array.from(
    svg.querySelectorAll<SVGElement>(".grid .tick line, .grid path, .vert"),
  )) {
    setImportantStyle(line, "fill", "none");
    setImportantStyle(line, "stroke", gantt.grid);
    setImportantStyle(line, "stroke-width", "1px");
  }
  for (const line of Array.from(
    svg.querySelectorAll<SVGElement>(".today line, line.today"),
  )) {
    setImportantStyle(line, "fill", "none");
    setImportantStyle(line, "stroke", gantt.today);
    setImportantStyle(line, "stroke-width", "2px");
  }
  for (const excluded of Array.from(
    svg.querySelectorAll<SVGElement>(".exclude-range"),
  ))
    setImportantStyle(excluded, "fill", gantt.alternateSection);
}

/**
 * Mermaid's generated stylesheet varies between diagram types. Normalize the
 * presentation properties that otherwise fall back to SVG's black paint,
 * while leaving node surfaces and marker arrowheads to the themed document
 * stylesheet below.
 */
function normalizeMermaidSvg(
  svg: SVGElement,
  palette: MermaidPalette,
  root: ParentNode,
  ownerDocument: Document,
): void {
  const diagramColors = mermaidDiagramColors(palette);
  svg.style.setProperty("background", "transparent", "important");
  svg.style.setProperty("--mm-mermaid-row-odd", diagramColors.rowOdd);
  svg.style.setProperty("--mm-mermaid-row-even", diagramColors.rowEven);
  diagramColors.chart.forEach((color, index) => {
    svg.style.setProperty(`--mm-mermaid-chart-${index}`, color);
    svg.style.setProperty(
      `--mm-mermaid-chart-text-${index}`,
      diagramColors.chartText[index]!,
    );
  });
  normalizeGitGraphSvg(svg);

  for (const background of Array.from(
    svg.querySelectorAll<SVGElement>("rect.background"),
  )) {
    if (background.closest(".edgeLabel")) continue;
    background.style.setProperty("fill", "transparent", "important");
    background.style.setProperty("stroke", "none", "important");
  }

  const edgeElements = svg.querySelectorAll<SVGElement>(
    ".edgePaths path, .edgePath path, .flowchart-link, .messageLine0, .messageLine1, .actor-line, .loopLine, .noteLine, .entityLine",
  );
  for (const edge of Array.from(edgeElements))
    edge.style.setProperty("fill", "none", "important");

  const edgeLabelBackgrounds = svg.querySelectorAll<SVGElement>(
    ".edgeLabel rect, .edgeLabel .labelBkg, .edgeLabel .background",
  );
  for (const background of Array.from(edgeLabelBackgrounds)) {
    background.style.setProperty(
      "fill",
      "var(--mm-mermaid-background)",
      "important",
    );
    background.style.setProperty("stroke", "none", "important");
  }

  const role = svg.getAttribute("aria-roledescription");
  if (role === "er") normalizeErSvg(svg, palette);
  else if (role === "classDiagram")
    normalizeClassDiagramSvg(svg, palette, root, ownerDocument);
  else if (role === "pie") normalizePieSvg(svg, palette);
  else if (role === "timeline") normalizeTimelineSvg(svg, palette);
  else if (role === "mindmap") normalizeMindmapSvg(svg, palette);
  else if (role === "gantt") normalizeGanttSvg(svg, palette);
}

function asSvgMarkup(value: string | { svg?: string }): string | undefined {
  if (typeof value === "string") return value;
  return typeof value.svg === "string" ? value.svg : undefined;
}

let renderTail: Promise<unknown> = Promise.resolve();

/** Shared strict, themed, sanitized rendering for document and modal previews. */
export async function renderSafeMermaidSvg(
  source: string,
  root: ParentNode,
  runtime?: MermaidRuntime,
): Promise<SVGElement> {
  const ownerDocument = documentForRoot(root);
  if (!ownerDocument) throw new Error("Mermaid document is unavailable.");
  if (source.length > MAX_MERMAID_SOURCE_LENGTH)
    throw new Error("Mermaid source exceeds the character limit.");
  const resolved = runtime ?? (await ensureMermaidRuntime());
  if (!resolved) throw new Error("Mermaid renderer is unavailable offline.");
  const render = renderTail.then(async () => {
    const { palette } = initializeRuntimeTheme(resolved, root, ownerDocument);
    const id = "mm-mermaid-" + String(++nextMermaidId);
    try {
      const result = await resolved.render(id, normalizeMermaidSource(source));
      const markup = asSvgMarkup(result);
      const svg = markup ? sanitizeSvg(markup, ownerDocument) : null;
      if (!svg) throw new Error("Mermaid output was rejected.");
      normalizeMermaidSvg(svg, palette, root, ownerDocument);
      return svg;
    } finally {
      // Mermaid may leave its measuring/error container behind on rejection.
      ownerDocument.getElementById("d" + id)?.remove();
    }
  });
  renderTail = render.then(
    () => undefined,
    () => undefined,
  );
  return render;
}

function isHidden(element: HTMLElement): boolean {
  let current: Element | null = element;
  while (current) {
    if (current.hasAttribute("hidden")) return true;
    current = current.parentElement;
  }
  return false;
}

function scopedFragmentTarget(
  root: ParentNode,
  id: string,
): HTMLElement | undefined {
  for (const candidate of Array.from(
    root.querySelectorAll<HTMLElement>("[id]"),
  ))
    if (candidate.id === id) return candidate;
  const rootElement = root as HTMLElement;
  return typeof rootElement.id === "string" && rootElement.id === id
    ? rootElement
    : undefined;
}

interface FragmentDelegation {
  references: number;
  listener: (event: Event) => void;
}

const fragmentDelegations = new WeakMap<Document, FragmentDelegation>();

function retainFragmentDelegation(ownerDocument: Document): () => void {
  const existing = fragmentDelegations.get(ownerDocument);
  if (existing) {
    existing.references += 1;
    return () => releaseFragmentDelegation(ownerDocument);
  }
  const listener = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const link = target.closest<HTMLAnchorElement>('a[href^="#"]');
    if (!link) return;
    const contentRoot =
      link.closest<HTMLElement>(".mm-document-content, .markdown-body") ??
      ownerDocument.body;
    if (!contentRoot || isHidden(contentRoot)) return;
    const href = link.getAttribute("href");
    if (!href) return;
    let id = href.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      return;
    }
    const destination = scopedFragmentTarget(contentRoot, id);
    if (!destination) return;
    event.preventDefault();
    destination.scrollIntoView?.({ block: "start" });
  };
  ownerDocument.addEventListener("click", listener);
  fragmentDelegations.set(ownerDocument, { references: 1, listener });
  return () => releaseFragmentDelegation(ownerDocument);
}

function releaseFragmentDelegation(ownerDocument: Document): void {
  const delegation = fragmentDelegations.get(ownerDocument);
  if (!delegation) return;
  delegation.references -= 1;
  if (delegation.references > 0) return;
  ownerDocument.removeEventListener("click", delegation.listener);
  fragmentDelegations.delete(ownerDocument);
}

function documentForRoot(root: ParentNode): Document | undefined {
  if (typeof document === "undefined") return undefined;
  const candidate = root as Node & { ownerDocument?: Document };
  return candidate.ownerDocument ?? document;
}

/** Stable key for cached SVG rendered with the palette currently in effect. */
export function mermaidThemeSignature(root: ParentNode): string {
  const ownerDocument = documentForRoot(root);
  if (!ownerDocument) return "default";
  return JSON.stringify(themeVariables(mermaidPalette(root, ownerDocument)));
}

export function enhanceRenderedContent(
  root: ParentNode,
  codeBlockOptions: CodeBlockControlOptions = {},
): RenderingEnhancer {
  const ownerDocument = documentForRoot(root);
  const releaseFragmentDelegation = ownerDocument
    ? retainFragmentDelegation(ownerDocument)
    : undefined;
  const codeBlockControls = enhanceCodeBlockControls(root, codeBlockOptions);
  let disposed = false;
  let scanQueued = false;
  const jobs = new WeakMap<
    HTMLElement,
    { generation: number; controller: AbortController }
  >();
  const activeElements = new Set<HTMLElement>();
  const retryElements = new Set<HTMLElement>();
  let themeObserver: MutationObserver | undefined;
  let observedThemeSignature = "";
  const observer =
    typeof MutationObserver !== "undefined" &&
    typeof Node !== "undefined" &&
    root instanceof Node
      ? new MutationObserver(() => scheduleScan())
      : undefined;

  const observeThemeChanges = (): void => {
    if (
      themeObserver ||
      !ownerDocument ||
      typeof MutationObserver === "undefined"
    )
      return;
    observedThemeSignature = mermaidThemeSignature(root);
    themeObserver = new MutationObserver(() => {
      if (disposed) return;
      const signature = mermaidThemeSignature(root);
      if (signature === observedThemeSignature) return;
      observedThemeSignature = signature;
      const candidates = Array.from(
        root.querySelectorAll<HTMLElement>(MERMAID_SELECTOR),
      );
      const rootElement = root as Element;
      if (
        typeof rootElement.matches === "function" &&
        rootElement.matches(MERMAID_SELECTOR)
      )
        candidates.unshift(rootElement as HTMLElement);
      for (const element of candidates)
        if (element.dataset.mmMermaidState === "rendered" || jobs.has(element))
          void renderElement(element, true);
    });
    const attributes = [
      "class",
      "style",
      "data-vscode-theme-id",
      "data-vscode-theme-kind",
    ];
    for (const element of [ownerDocument.documentElement, ownerDocument.body])
      if (element)
        themeObserver.observe(element, {
          attributes: true,
          attributeFilter: attributes,
        });
  };

  const finishFailure = (
    element: HTMLElement,
    generation: number,
    message: string,
  ): void => {
    const current = jobs.get(element);
    if (disposed || !current || current.generation !== generation) return;
    activeElements.delete(element);
    retryElements.add(element);
    element.dataset.mmMermaidState = "failed";
    textForStatus(element, message);
  };

  const renderElement = async (
    element: HTMLElement,
    force = false,
  ): Promise<void> => {
    if (
      disposed ||
      !ownerDocument ||
      !connectedToRoot(root, element, ownerDocument)
    )
      return;
    if (isHidden(element)) return;
    const state = element.dataset.mmMermaidState ?? "";
    const previous = jobs.get(element);
    if (
      !force &&
      (previous ||
        state === "rendering" ||
        state === "rendered" ||
        state === "failed")
    )
      return;
    const source = element.dataset.mermaidSource ?? "";
    if (source.length > MAX_MERMAID_SOURCE_LENGTH) {
      retryElements.add(element);
      element.dataset.mmMermaidState = "failed";
      textForStatus(
        element,
        "Mermaid source is too large for the offline renderer; source preserved.",
      );
      return;
    }
    previous?.controller.abort();
    const generation = (previous?.generation ?? 0) + 1;
    const controller = new AbortController();
    jobs.set(element, { generation, controller });
    activeElements.add(element);
    retryElements.delete(element);
    element.dataset.mmMermaidState = "rendering";
    observeThemeChanges();
    if (!firstMermaidUseMarked) {
      firstMermaidUseMarked = true;
      markPerformance(MERMAID_FIRST_USE_START_MARK);
    }
    let runtime: MermaidRuntime | undefined;
    try {
      runtime =
        mermaidRuntimeFromGlobal() ??
        (await ensureMermaidRuntime()) ??
        undefined;
    } catch {
      runtime = undefined;
    }
    const current = jobs.get(element);
    if (
      disposed ||
      controller.signal.aborted ||
      !current ||
      current.generation !== generation
    )
      return;
    if (!runtime) {
      finishFailure(
        element,
        generation,
        "Mermaid renderer is unavailable offline; source preserved.",
      );
      return;
    }
    renderSafeMermaidSvg(source, root, runtime)
      .then((svg) => {
        const current = jobs.get(element);
        if (
          disposed ||
          controller.signal.aborted ||
          !current ||
          current.generation !== generation ||
          !connectedToRoot(root, element, ownerDocument)
        )
          return;
        const oldSvg = element.querySelector("svg");
        oldSvg?.remove();
        element.insertBefore(svg, element.firstChild);
        const sourceBlock = element.querySelector(".mm-diagram-source");
        if (sourceBlock) sourceBlock.setAttribute("hidden", "true");
        textForStatus(element, "Mermaid diagram");
        element.dataset.mmMermaidState = "rendered";
        if (!firstMermaidRenderMarked) {
          firstMermaidRenderMarked = true;
          markPerformance(MERMAID_FIRST_USE_END_MARK);
        }
        activeElements.delete(element);
        retryElements.delete(element);
      })
      .catch(() => {
        finishFailure(
          element,
          generation,
          "Mermaid could not render this source offline; source preserved.",
        );
      });
  };

  function scan(): void {
    if (disposed) return;
    enhanceMixedTaskCheckboxes(root);
    const candidates = Array.from(
      root.querySelectorAll<HTMLElement>(MERMAID_SELECTOR),
    );
    const rootElement = root as Element;
    if (
      typeof rootElement.matches === "function" &&
      rootElement.matches(MERMAID_SELECTOR)
    )
      candidates.unshift(rootElement as HTMLElement);
    for (const element of candidates) void renderElement(element);
  }

  function scheduleScan(): void {
    if (disposed || scanQueued) return;
    scanQueued = true;
    queueMicrotask(() => {
      scanQueued = false;
      if (!disposed) scan();
    });
  }

  const onRuntimeReady = (): void => {
    for (const element of retryElements) void renderElement(element, true);
    scheduleScan();
  };
  ownerDocument?.defaultView?.addEventListener(
    "markdown-mint-mermaid-ready",
    onRuntimeReady,
  );
  if (observer) observer.observe(root, { childList: true, subtree: true });
  scan();

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      observer?.disconnect();
      themeObserver?.disconnect();
      releaseFragmentDelegation?.();
      codeBlockControls.dispose();
      ownerDocument?.defaultView?.removeEventListener(
        "markdown-mint-mermaid-ready",
        onRuntimeReady,
      );
      for (const element of activeElements)
        jobs.get(element)?.controller.abort();
      activeElements.clear();
      retryElements.clear();
    },
    invalidate: () => {
      if (disposed) return;
      const candidates = Array.from(
        root.querySelectorAll<HTMLElement>(MERMAID_SELECTOR),
      );
      const rootElement = root as Element;
      if (
        typeof rootElement.matches === "function" &&
        rootElement.matches(MERMAID_SELECTOR)
      )
        candidates.unshift(rootElement as HTMLElement);
      for (const element of candidates) void renderElement(element, true);
      scheduleScan();
    },
  };
}
