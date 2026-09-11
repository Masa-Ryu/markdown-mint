import hljs from "highlight.js/lib/common";
import katex from "katex";
import {
  renderStaticAsset,
  type StaticAssetKind,
} from "./staticAssetRendering";

export interface HighlightSpan {
  readonly from: number;
  readonly to: number;
  readonly className: string;
}

export interface AdvancedRenderOptions {
  readonly language?: string;
  readonly maxSourceLength?: number;
}

export const MAX_RENDER_SOURCE_LENGTH = 250_000;
const LANGUAGE_ALIASES: Record<string, string> = {
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  css: "css",
  csv: "csv",
  go: "go",
  html: "xml",
  http: "http",
  java: "java",
  javascript: "javascript",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "javascript",
  kotlin: "kotlin",
  kt: "kotlin",
  less: "less",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  mjs: "javascript",
  php: "php",
  py: "python",
  python: "python",
  rb: "ruby",
  ruby: "ruby",
  rs: "rust",
  rust: "rust",
  scss: "scss",
  sh: "bash",
  shell: "bash",
  sql: "sql",
  swift: "swift",
  text: "plaintext",
  toml: "ini",
  ts: "typescript",
  tsx: "typescript",
  typescript: "typescript",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

function normalizedLanguage(language: string): string {
  const first = language.trim().split(/\s+/, 1)[0] ?? "";
  const lower = first.toLowerCase();
  return LANGUAGE_ALIASES[lower] ?? lower;
}

function knownLanguage(language: string): string | undefined {
  const normalized = normalizedLanguage(language);
  if (!normalized) return undefined;
  return hljs.getLanguage(normalized) ? normalized : undefined;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function validLanguageAttribute(language: string): boolean {
  return /^[A-Za-z0-9_+.-]+$/.test(language);
}

const LANGUAGE_LABELS: Record<string, string> = {
  bash: "Shell",
  c: "C",
  cpp: "C++",
  css: "CSS",
  csv: "CSV",
  go: "Go",
  http: "HTTP",
  ini: "INI",
  java: "Java",
  javascript: "JavaScript",
  json: "JSON",
  kotlin: "Kotlin",
  less: "Less",
  markdown: "Markdown",
  php: "PHP",
  plaintext: "txt",
  python: "Python",
  ruby: "Ruby",
  rust: "Rust",
  scss: "SCSS",
  sql: "SQL",
  swift: "Swift",
  typescript: "TypeScript",
  xml: "XML",
  yaml: "YAML",
};

export function codeLanguageLabel(language: string): string {
  const normalized = normalizedLanguage(language);
  return (
    LANGUAGE_LABELS[knownLanguage(language) ?? ""] ??
    (normalized && knownLanguage(language) ? normalized : "txt")
  );
}

export function codeLanguageIcon(language: string): string {
  const normalized = knownLanguage(language) ?? "plaintext";
  if (normalized === "plaintext") return "";
  if (normalized === "typescript") return "TS";
  if (normalized === "javascript") return "JS";
  if (normalized === "python") return "🐍";
  if (normalized === "json") return "{}";
  if (normalized === "markdown") return "M↓";
  if (normalized === "css" || normalized === "scss" || normalized === "less")
    return "#";
  if (normalized === "html" || normalized === "xml") return "<>";
  return "</>";
}

function codeLineNumbers(source: string): string {
  const lineCount = Math.max(1, source.split(/\r\n|\r|\n/).length);
  // A very large source file should remain cheap to render. The code remains
  // fully visible; the gutter simply stops adding individual labels after a
  // bounded point where a number is no longer useful to scan.
  const boundedCount = Math.min(lineCount, 10_000);
  return Array.from(
    { length: boundedCount },
    (_, index) => `<span>${index + 1}</span>`,
  ).join("");
}

function highlightedHtml(source: string, language: string): string | undefined {
  const resolved = knownLanguage(language);
  if (!resolved) return undefined;
  try {
    return hljs.highlight(source, {
      language: resolved,
      ignoreIllegals: true,
    }).value;
  } catch {
    return undefined;
  }
}

export function renderCodeBlock(source: string, language = ""): string {
  const safeSource = source;
  const normalized = normalizedLanguage(language);
  const highlighted =
    safeSource.length <= MAX_RENDER_SOURCE_LENGTH
      ? highlightedHtml(safeSource, language)
      : undefined;
  const body = highlighted ?? escapeHtml(safeSource);
  const languageAttribute =
    normalized && validLanguageAttribute(normalized)
      ? ' data-language="' + escapeHtml(normalized) + '"'
      : "";
  const highlightAttribute =
    safeSource.length > MAX_RENDER_SOURCE_LENGTH
      ? ' data-mm-highlight="skipped-large"'
      : "";
  const codeClass =
    normalized && validLanguageAttribute(normalized)
      ? ' class="language-' + escapeHtml(normalized) + " hljs" + '"'
      : "";
  const languageLabel = codeLanguageLabel(language);
  const languageIcon = codeLanguageIcon(language);
  return (
    '<div class="mm-code-block"' +
    languageAttribute +
    highlightAttribute +
    ' data-mm-code-language="' +
    escapeHtml(languageLabel) +
    '">' +
    '<div class="mm-code-block-header">' +
    '<div class="mm-code-language-control" role="img" aria-label="Code language: ' +
    escapeHtml(languageLabel) +
    '">' +
    '<span class="mm-code-language-icon" aria-hidden="true">' +
    escapeHtml(languageIcon) +
    "</span>" +
    '<span class="mm-code-language-label">' +
    escapeHtml(languageLabel) +
    "</span>" +
    '<span class="mm-code-language-chevron" aria-hidden="true">⌄</span>' +
    "</div>" +
    '<div class="mm-code-block-actions">' +
    '<button type="button" class="mm-code-action" data-mm-code-action="copy" aria-label="Copy code" title="Copy code">' +
    '<span class="mm-code-action-icon" aria-hidden="true">⧉</span>' +
    '<span class="mm-code-action-label">Copy</span>' +
    "</button>" +
    '<span class="mm-code-action-separator" aria-hidden="true"></span>' +
    '<button type="button" class="mm-code-action" data-mm-code-action="expand" aria-label="Expand code" title="Expand">' +
    '<span class="mm-code-action-icon" aria-hidden="true">⤢</span>' +
    '<span class="mm-code-action-label">Expand</span>' +
    "</button>" +
    '<button type="button" class="mm-code-action mm-code-action-more" data-mm-code-action="more" aria-label="More code block actions" title="More code block actions">' +
    '<span class="mm-code-action-icon" aria-hidden="true">•••</span>' +
    "</button>" +
    "</div>" +
    "</div>" +
    '<div class="mm-code-block-body">' +
    '<div class="mm-code-line-numbers" aria-hidden="true">' +
    codeLineNumbers(source) +
    "</div>" +
    '<pre class="mm-code-block-pre"><code' +
    codeClass +
    ">" +
    body +
    "</code></pre>" +
    "</div></div>"
  );
}

function decodeHighlightedText(value: string): string {
  return value.replace(
    /&(?:amp|lt|gt|quot|#39|#x27|#\d+|#x[0-9a-f]+);/gi,
    (entity: string) => {
      const lower = entity.toLowerCase();
      if (lower === "&amp;") return "&";
      if (lower === "&lt;") return "<";
      if (lower === "&gt;") return ">";
      if (lower === "&quot;") return '"';
      if (lower === "&#39;" || lower === "&#x27;") return "'";
      if (lower.startsWith("&#x")) {
        const codePoint = Number.parseInt(lower.slice(3, -1), 16);
        return Number.isSafeInteger(codePoint)
          ? String.fromCodePoint(Math.min(codePoint, 0x10ffff))
          : entity;
      }
      if (lower.startsWith("&#")) {
        const codePoint = Number.parseInt(lower.slice(2, -1), 10);
        return Number.isSafeInteger(codePoint)
          ? String.fromCodePoint(Math.min(codePoint, 0x10ffff))
          : entity;
      }
      return entity;
    },
  );
}

function highlightedTextLength(value: string): number {
  return decodeHighlightedText(value).length;
}

function spansFromHighlightedHtml(value: string): HighlightSpan[] {
  const spans: HighlightSpan[] = [];
  const tags = /<span\s+class="([^"]+)">|<\/span>/gi;
  const stack: Array<{ start: number; className: string }> = [];
  let sourceOffset = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(value)) !== null) {
    const text = value.slice(cursor, match.index);
    sourceOffset += highlightedTextLength(text);
    const whole = match[0].toLowerCase();
    if (whole.startsWith("<span")) {
      const className = (match[1] ?? "")
        .split(/\s+/)
        .filter((name) => /^hljs-[A-Za-z0-9_-]+$/.test(name))
        .join(" ");
      if (className) stack.push({ start: sourceOffset, className });
    } else {
      const item = stack.pop();
      if (item && item.start < sourceOffset)
        spans.push({
          from: item.start,
          to: sourceOffset,
          className: item.className,
        });
    }
    cursor = match.index + match[0].length;
  }
  sourceOffset += highlightedTextLength(value.slice(cursor));
  while (stack.length > 0) {
    const item = stack.pop();
    if (item && item.start < sourceOffset)
      spans.push({
        from: item.start,
        to: sourceOffset,
        className: item.className,
      });
  }
  return spans
    .filter((span) => span.to > span.from)
    .sort((left, right) => left.from - right.from || left.to - right.to);
}

export function highlightCodeSpans(
  source: string,
  language = "",
): HighlightSpan[] {
  const highlighted =
    source.length <= MAX_RENDER_SOURCE_LENGTH
      ? highlightedHtml(source, language)
      : undefined;
  return highlighted ? spansFromHighlightedHtml(highlighted) : [];
}

function stripMathDelimiters(source: string): string {
  const value = source.trim();
  if (value.startsWith("$$") && value.endsWith("$$"))
    return value.slice(2, -2).trim();
  if (value.startsWith("\\[") && value.endsWith("\\]"))
    return value.slice(2, -2).trim();
  if (value.startsWith("\\(") && value.endsWith("\\)"))
    return value.slice(2, -2).trim();
  if (value.startsWith("$") && value.endsWith("$") && value.length > 1)
    return value.slice(1, -1).trim();
  return value;
}

export function renderMath(source: string, display = false): string {
  const value = stripMathDelimiters(source);
  const className = display
    ? "mm-math mm-math-block"
    : "mm-math mm-math-inline";
  const tag = display ? "div" : "span";
  const fallback = (reason: string): string => {
    const fallbackClass = className + " mm-math-fallback";
    return (
      "<" +
      tag +
      ' class="' +
      fallbackClass +
      '" data-mm-math-error="' +
      escapeHtml(reason) +
      '"><code>' +
      escapeHtml(value) +
      "</code></" +
      tag +
      ">"
    );
  };
  if (value.length > MAX_RENDER_SOURCE_LENGTH) return fallback("too-large");
  try {
    const rendered = katex.renderToString(value, {
      displayMode: display,
      output: "htmlAndMathml",
      throwOnError: false,
      strict: "ignore",
      trust: false,
    });
    return (
      "<" +
      tag +
      ' class="' +
      className +
      '" data-mm-math-display="' +
      String(display) +
      '">' +
      rendered +
      "</" +
      tag +
      ">"
    );
  } catch {
    return fallback("parse-error");
  }
}

interface FenceInfo {
  readonly language: string;
  readonly body: string;
  readonly fenced: boolean;
}

function extractFence(source: string, languageHint = ""): FenceInfo {
  const normalizedSource = source.replace(/\r\n?/g, "\n");
  const lines = normalizedSource.split("\n");
  const fenceCharacter = String.fromCharCode(96);
  const openingRegex = new RegExp(
    "^ {0,3}((?:" + fenceCharacter + "{3,})|(?:~{3,}))[ \\t]*(.*)$",
  );
  const opening = openingRegex.exec(lines[0] ?? "");
  if (!opening)
    return {
      language: languageHint,
      body: normalizedSource,
      fenced: false,
    };
  const marker = opening[1] ?? "";
  const info = (opening[2] ?? "").trim();
  const character = marker[0] ?? fenceCharacter;
  const closingRegex = new RegExp(
    "^ {0,3}" +
      (character === fenceCharacter ? fenceCharacter : "~") +
      "{" +
      marker.length +
      ",}[ \\t]*$",
  );
  let closing = lines.length;
  for (let index = 1; index < lines.length; index += 1) {
    if (closingRegex.test(lines[index] ?? "")) {
      closing = index;
      break;
    }
  }
  return {
    language: info || languageHint,
    body: lines.slice(1, closing).join("\n").replace(/\n$/, ""),
    fenced: true,
  };
}

function attr(name: string, value: string): string {
  return " " + name + '="' + escapeHtml(value) + '"';
}

function mermaidPlaceholder(source: string): string {
  return (
    '<div class="mm-diagram mm-mermaid" data-mm-mermaid="true"' +
    attr("data-mermaid-source", source) +
    ' data-mm-mermaid-state="pending">' +
    '<p class="mm-diagram-status">Rendering Mermaid diagram...</p>' +
    '<pre class="mm-diagram-source">' +
    escapeHtml(source) +
    "</pre></div>"
  );
}

function unsupportedDiagram(kind: string, source: string): string {
  const label = kind || "diagram";
  return (
    '<div class="mm-diagram mm-diagram-unsupported"' +
    attr("data-mm-diagram-kind", label) +
    ">" +
    '<p class="mm-diagram-status">Offline preview unavailable for ' +
    escapeHtml(label) +
    "; source is preserved below.</p>" +
    '<pre class="mm-diagram-source">' +
    escapeHtml(source) +
    "</pre></div>"
  );
}

function staticAssetPreview(kind: string, source: string): string {
  const normalizedKind = kind.toLowerCase();
  if (
    normalizedKind === "geojson" ||
    normalizedKind === "topojson" ||
    normalizedKind === "stl"
  ) {
    const rendered = renderStaticAsset(
      normalizedKind as StaticAssetKind,
      source,
    );
    if (rendered) return rendered;
  }
  const label = normalizedKind === "stl" ? "STL" : normalizedKind.toUpperCase();
  let display = source;
  let status = "Static " + label + " data preview (offline).";
  if (source.length > MAX_RENDER_SOURCE_LENGTH)
    status =
      "Static " + label + " source preview (offline; data too large to parse).";
  if (normalizedKind !== "stl" && source.length <= MAX_RENDER_SOURCE_LENGTH) {
    try {
      display = JSON.stringify(JSON.parse(source), null, 2);
    } catch {
      status = "Static " + label + " source preview (offline; invalid JSON).";
    }
  }
  return (
    '<div class="mm-static-asset mm-static-' +
    escapeHtml(normalizedKind) +
    '"' +
    attr("data-mm-asset-kind", normalizedKind) +
    ">" +
    '<p class="mm-asset-status">' +
    escapeHtml(status) +
    "</p>" +
    '<pre class="mm-diagram-source">' +
    escapeHtml(display) +
    "</pre></div>"
  );
}

const B_OWNED_KINDS = new Set([
  "alert",
  "details",
  "footnote",
  "footnote_block",
  "frontmatter",
  "html",
  "html_block",
]);

export function renderAdvancedBlock(
  kind: string,
  source: string,
  options: AdvancedRenderOptions = {},
): string | null {
  const bounded = source;
  const lowerKind = kind.trim().toLowerCase();
  if (B_OWNED_KINDS.has(lowerKind)) return null;
  const fence = extractFence(bounded, options.language ?? "");
  const language = normalizedLanguage(fence.language);
  if (
    lowerKind === "math_inline" ||
    lowerKind === "inline_math" ||
    lowerKind === "math-inline"
  )
    return renderMath(fence.body, false);
  if (
    language === "mermaid" ||
    lowerKind === "mermaid" ||
    lowerKind === "diagram-mermaid"
  )
    return mermaidPlaceholder(fence.body);
  if (
    language === "math" ||
    language === "latex" ||
    language === "tex" ||
    language === "asciimath" ||
    lowerKind === "math" ||
    lowerKind === "latex" ||
    lowerKind === "tex"
  )
    return renderMath(fence.body, true);
  if (
    language === "geojson" ||
    language === "topojson" ||
    lowerKind === "geojson" ||
    lowerKind === "topojson"
  )
    return staticAssetPreview(
      language === "topojson" || lowerKind === "topojson"
        ? "topojson"
        : "geojson",
      fence.body,
    );
  if (
    language === "stl" ||
    lowerKind === "stl" ||
    lowerKind === "stl-ascii" ||
    lowerKind === "stl-binary"
  )
    return staticAssetPreview("stl", fence.body);
  if (
    language === "plantuml" ||
    language === "kroki" ||
    language === "blockdiag" ||
    language === "graphviz" ||
    lowerKind === "plantuml" ||
    lowerKind === "kroki" ||
    lowerKind === "blockdiag"
  )
    return unsupportedDiagram(language || lowerKind, fence.body);
  if (fence.fenced || lowerKind === "protected-fence" || lowerKind === "code")
    return renderCodeBlock(fence.body, fence.language);
  if (lowerKind === "raw_block" || lowerKind === "unknown" || !lowerKind)
    return renderCodeBlock(bounded, fence.language);
  return null;
}
