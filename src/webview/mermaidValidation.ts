export interface MermaidRuntime {
  initialize?: (options: Record<string, unknown>) => void;
  parse?: (source: string) => unknown | Promise<unknown>;
  render: (
    id: string,
    source: string,
  ) => string | { svg?: string } | Promise<string | { svg?: string }>;
}

export const MAX_MERMAID_SOURCE_LENGTH = 200_000;
export const MERMAID_VALIDATION_DEBOUNCE_MS = 300;

export type MermaidValidationStatus =
  "empty" | "checking" | "valid" | "invalid";

export interface MermaidValidationResult {
  valid: boolean;
  diagramType?: string;
  error?: string;
}

export interface MermaidValidationSnapshot extends MermaidValidationResult {
  source: string;
  status: MermaidValidationStatus;
}

export const MERMAID_RUNTIME_READY_EVENT = "markdown-mint-mermaid-ready";
export const MERMAID_RUNTIME_LOAD_START_MARK =
  "markdown-mint-mermaid-load-start";
export const MERMAID_RUNTIME_LOAD_END_MARK = "markdown-mint-mermaid-load-end";

export interface MermaidRuntimeLoaderOptions {
  src?: string;
  nonce?: string;
  ownerDocument?: Document;
}

interface ConfiguredMermaidRuntimeLoader {
  src: string;
  nonce?: string;
  ownerDocument: Document;
}

let configuredMermaidRuntimeLoader: ConfiguredMermaidRuntimeLoader | undefined;
let mermaidRuntimeLoadPromise: Promise<MermaidRuntime | undefined> | undefined;

/** Keep validation and rendering on the same safe Mermaid source. */
export function normalizeMermaidSource(source: string): string {
  return source
    .replaceAll(String.fromCharCode(0), "")
    .replace(/%%\{[\s\S]*?\}%%/g, "")
    .trim();
}

export function mermaidRuntimeFromGlobal(): MermaidRuntime | undefined {
  if (typeof globalThis === "undefined") return undefined;
  const globals = globalThis as unknown as Record<string, unknown>;
  const candidate =
    globals.markdownMintMermaid ?? globals.mermaid ?? globals.mermaidRuntime;
  if (!candidate || typeof candidate !== "object") return undefined;
  const runtime = candidate as Partial<MermaidRuntime>;
  return typeof runtime.render === "function"
    ? (runtime as MermaidRuntime)
    : undefined;
}

/**
 * Configure the local runtime URL supplied by the trusted Webview host.
 * Keeping this separate from the renderer lets the editor bundle stay free of
 * Mermaid's large dependency until the first real Mermaid request.
 */
export function configureMermaidRuntimeLoader(
  options?: MermaidRuntimeLoaderOptions,
): void {
  const src = options?.src?.trim();
  if (!src) {
    configuredMermaidRuntimeLoader = undefined;
    mermaidRuntimeLoadPromise = undefined;
    return;
  }
  const ownerDocument =
    options?.ownerDocument ??
    (typeof document === "undefined" ? undefined : document);
  if (!ownerDocument) return;
  const nonce = options?.nonce?.trim() || undefined;
  if (
    configuredMermaidRuntimeLoader?.src === src &&
    configuredMermaidRuntimeLoader.nonce === nonce &&
    configuredMermaidRuntimeLoader.ownerDocument === ownerDocument
  )
    return;
  configuredMermaidRuntimeLoader = {
    src,
    ownerDocument,
    ...(nonce ? { nonce } : {}),
  };
  mermaidRuntimeLoadPromise = undefined;
}

function markPerformance(name: string): void {
  try {
    globalThis.performance?.mark(name);
  } catch {
    // Performance marks are diagnostic only and must never affect rendering.
  }
}

function loadConfiguredMermaidRuntime(
  config: ConfiguredMermaidRuntimeLoader,
): Promise<MermaidRuntime | undefined> {
  markPerformance(MERMAID_RUNTIME_LOAD_START_MARK);
  return new Promise<MermaidRuntime | undefined>((resolve) => {
    const ownerDocument = config.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    let settled = false;
    const finish = (runtime: MermaidRuntime | undefined): void => {
      if (settled) return;
      settled = true;
      ownerDocument.removeEventListener("DOMContentLoaded", onReady);
      ownerWindow?.removeEventListener(MERMAID_RUNTIME_READY_EVENT, onReady);
      markPerformance(MERMAID_RUNTIME_LOAD_END_MARK);
      resolve(runtime);
    };
    const onReady = (): void => {
      // The runtime's own DOMContentLoaded listener may be registered after
      // this loader's listener. Let the event dispatch finish before checking
      // the global it installs.
      queueMicrotask(() => {
        const runtime = mermaidRuntimeFromGlobal();
        if (runtime) finish(runtime);
      });
    };

    try {
      const script = ownerDocument.createElement("script");
      script.async = true;
      script.src = config.src;
      script.dataset.markdownMintMermaidRuntime = "true";
      if (config.nonce) script.setAttribute("nonce", config.nonce);
      script.addEventListener("load", () => {
        const runtime = mermaidRuntimeFromGlobal();
        if (runtime) {
          finish(runtime);
          return;
        }
        if (ownerDocument.readyState !== "loading") finish(undefined);
      });
      script.addEventListener("error", () => finish(undefined), {
        once: true,
      });
      ownerWindow?.addEventListener(MERMAID_RUNTIME_READY_EVENT, onReady);
      ownerDocument.addEventListener("DOMContentLoaded", onReady, {
        once: true,
      });
      const parent =
        ownerDocument.head ??
        ownerDocument.body ??
        ownerDocument.documentElement;
      if (!parent) {
        finish(undefined);
        return;
      }
      parent.append(script);
    } catch {
      finish(undefined);
    }
  });
}

/** Load the packaged Mermaid runtime once, if the host supplied a local URL. */
export function ensureMermaidRuntime(): Promise<MermaidRuntime | undefined> {
  const current = mermaidRuntimeFromGlobal();
  if (current) return Promise.resolve(current);
  const config = configuredMermaidRuntimeLoader;
  if (!config) return Promise.resolve(undefined);
  if (!mermaidRuntimeLoadPromise)
    mermaidRuntimeLoadPromise = loadConfiguredMermaidRuntime(config);
  return mermaidRuntimeLoadPromise;
}

export function mermaidRuntimeVersionFromGlobal(): string {
  if (typeof globalThis === "undefined") return "unknown";
  const version = (globalThis as unknown as Record<string, unknown>)
    .markdownMintMermaidVersion;
  return typeof version === "string" && version.trim()
    ? version.trim()
    : "unknown";
}

const MERMAID_DIAGRAM_TYPE_LABELS: Readonly<Record<string, string>> = {
  architecture: "Architecture",
  block: "Block diagram",
  "block-beta": "Block diagram",
  c4: "C4 diagram",
  class: "Class diagram",
  classDiagram: "Class diagram",
  "classDiagram-v2": "Class diagram",
  er: "ER diagram",
  eventmodeling: "Event modeling",
  flowchart: "Flowchart",
  "flowchart-elk": "Flowchart",
  "flowchart-v2": "Flowchart",
  gantt: "Gantt",
  gitGraph: "Git graph",
  info: "Info",
  ishikawa: "Ishikawa diagram",
  journey: "User journey",
  kanban: "Kanban",
  mindmap: "Mindmap",
  packet: "Packet diagram",
  "packet-beta": "Packet diagram",
  pie: "Pie chart",
  quadrantChart: "Quadrant chart",
  radar: "Radar chart",
  requirement: "Requirement diagram",
  sankey: "Sankey diagram",
  sequence: "Sequence",
  state: "State diagram",
  stateDiagram: "State diagram",
  "stateDiagram-v2": "State diagram",
  swimlane: "Swimlane diagram",
  timeline: "Timeline",
  treeView: "Tree view",
  treemap: "Treemap",
  venn: "Venn diagram",
  wardley: "Wardley map",
  xychart: "XY chart",
  "xychart-beta": "XY chart",
};

/** Convert Mermaid's internal detector IDs into stable user-facing labels. */
export function humanizeMermaidDiagramType(type: string): string {
  const normalized = type.trim();
  return MERMAID_DIAGRAM_TYPE_LABELS[normalized] ?? (normalized || "Diagram");
}

function errorMessage(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const compact = message.replace(/\s+/g, " ").trim();
  if (!compact) return "Mermaid syntax is invalid.";
  return compact.slice(0, 500);
}

function invalidResult(error: string): MermaidValidationResult {
  return { valid: false, error };
}

export async function validateMermaidSource(
  source: string,
  runtime = mermaidRuntimeFromGlobal(),
): Promise<MermaidValidationResult> {
  if (source.length > MAX_MERMAID_SOURCE_LENGTH)
    return invalidResult(
      `Mermaid source exceeds the ${MAX_MERMAID_SOURCE_LENGTH.toLocaleString()} character limit.`,
    );
  const normalized = normalizeMermaidSource(source);
  if (!normalized) return invalidResult("Mermaid source is empty.");
  const resolvedRuntime = runtime ?? (await ensureMermaidRuntime());
  if (!resolvedRuntime?.parse)
    return invalidResult("Mermaid validator is unavailable offline.");
  try {
    const parsed = await Promise.resolve(resolvedRuntime.parse(normalized));
    if (!parsed || typeof parsed !== "object")
      return invalidResult("Mermaid syntax is invalid.");
    const diagramType = (parsed as { diagramType?: unknown }).diagramType;
    if (typeof diagramType !== "string" || !diagramType.trim())
      return invalidResult("Mermaid did not identify a diagram type.");
    return { valid: true, diagramType: diagramType.trim() };
  } catch (error) {
    return invalidResult(errorMessage(error));
  }
}

export class MermaidValidationController {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly onChange: (snapshot: MermaidValidationSnapshot) => void,
    private readonly delay = MERMAID_VALIDATION_DEBOUNCE_MS,
  ) {}

  schedule(source: string): void {
    if (this.disposed) return;
    this.clearTimer();
    const generation = ++this.generation;
    const normalized = normalizeMermaidSource(source);
    if (!normalized) {
      this.notify({
        source,
        status: "empty",
        ...invalidResult("Mermaid source is empty."),
      });
      return;
    }
    if (source.length > MAX_MERMAID_SOURCE_LENGTH) {
      this.notify({
        source,
        status: "invalid",
        ...invalidResult(
          `Mermaid source exceeds the ${MAX_MERMAID_SOURCE_LENGTH.toLocaleString()} character limit.`,
        ),
      });
      return;
    }
    this.notify({ source, status: "checking", valid: false });
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run(source, generation);
    }, this.delay);
  }

  async validateNow(
    source: string,
  ): Promise<MermaidValidationSnapshot | undefined> {
    if (this.disposed) return undefined;
    this.clearTimer();
    const generation = ++this.generation;
    const normalized = normalizeMermaidSource(source);
    if (!normalized) {
      const snapshot: MermaidValidationSnapshot = {
        source,
        status: "empty",
        ...invalidResult("Mermaid source is empty."),
      };
      this.notify(snapshot);
      return snapshot;
    }
    this.notify({ source, status: "checking", valid: false });
    const result = await validateMermaidSource(source);
    if (this.disposed || generation !== this.generation) return undefined;
    const snapshot: MermaidValidationSnapshot = {
      source,
      status: result.valid ? "valid" : "invalid",
      ...result,
    };
    this.notify(snapshot);
    return snapshot;
  }

  cancel(): void {
    this.clearTimer();
    this.generation += 1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancel();
    this.disposed = true;
  }

  private async run(source: string, generation: number): Promise<void> {
    const result = await validateMermaidSource(source);
    if (this.disposed || generation !== this.generation) return;
    this.notify({
      source,
      status: result.valid ? "valid" : "invalid",
      ...result,
    });
  }

  private notify(snapshot: MermaidValidationSnapshot): void {
    if (!this.disposed) this.onChange(snapshot);
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
