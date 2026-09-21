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

interface MermaidPalette {
  background: string;
  foreground: string;
  surface: string;
  line: string;
  accent: string;
  fontFamily?: string;
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
        }
      : {
          background: "#ffffff",
          foreground: "#000000",
          surface: "#ffffff",
          line: "#000000",
          accent: "#0000ee",
        }
    : dark
      ? {
          background: "#1e1e1e",
          foreground: "#d4d4d4",
          surface: "#252526",
          line: "#9da5b4",
          accent: "#3794ff",
        }
      : {
          background: "#ffffff",
          foreground: "#1f2328",
          surface: "#f6f8fa",
          line: "#57606a",
          accent: "#0969da",
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
  const fontFamily = style.fontFamily.trim();
  return {
    background,
    foreground,
    surface,
    line,
    accent,
    ...(fontFamily ? { fontFamily } : {}),
  };
}

function themeVariables(palette: MermaidPalette): Record<string, unknown> {
  const { background, foreground, surface, line, accent, fontFamily } = palette;
  return {
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
    taskBkgColor: surface,
    taskTextColor: foreground,
    transitionColor: line,
    transitionLabelColor: foreground,
    stateLabelColor: foreground,
    ...(fontFamily ? { fontFamily } : {}),
  };
}

function initializeRuntimeTheme(
  runtime: MermaidRuntime,
  root: ParentNode,
  ownerDocument: Document,
): void {
  const palette = mermaidPalette(root, ownerDocument);
  const variables = themeVariables(palette);
  const signature = JSON.stringify(variables);
  const runtimeObject = runtime as object;
  if (configuredThemes.get(runtimeObject) === signature) return;
  runtime.initialize?.({
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    deterministicIds: true,
    theme: "base",
    themeVariables: variables,
  });
  configuredThemes.set(runtimeObject, signature);
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

/**
 * Mermaid's generated stylesheet varies between diagram types. Normalize the
 * presentation properties that otherwise fall back to SVG's black paint,
 * while leaving node surfaces and marker arrowheads to the themed document
 * stylesheet below.
 */
function normalizeMermaidSvg(svg: SVGElement): void {
  svg.style.setProperty("background", "transparent", "important");

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
}

function asSvgMarkup(value: string | { svg?: string }): string | undefined {
  if (typeof value === "string") return value;
  return typeof value.svg === "string" ? value.svg : undefined;
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
  const observer =
    typeof MutationObserver !== "undefined" &&
    typeof Node !== "undefined" &&
    root instanceof Node
      ? new MutationObserver(() => scheduleScan())
      : undefined;

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
    try {
      initializeRuntimeTheme(runtime, root, ownerDocument);
    } catch {
      finishFailure(
        element,
        generation,
        "Mermaid renderer could not be initialized; source preserved.",
      );
      return;
    }
    const safeSource = normalizeMermaidSource(source);
    const id = "mm-mermaid-" + String(++nextMermaidId);
    Promise.resolve(runtime.render(id, safeSource))
      .then((result) => {
        const current = jobs.get(element);
        if (
          disposed ||
          controller.signal.aborted ||
          !current ||
          current.generation !== generation ||
          !connectedToRoot(root, element, ownerDocument)
        )
          return;
        const markup = asSvgMarkup(result);
        const svg = markup ? sanitizeSvg(markup, ownerDocument) : null;
        if (!svg) {
          finishFailure(
            element,
            generation,
            "Mermaid output was rejected; source preserved.",
          );
          return;
        }
        normalizeMermaidSvg(svg);
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
