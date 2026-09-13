import hljs from "highlight.js/lib/common";
import katex from "katex";
import {
  renderStaticAsset,
  type StaticAssetKind,
} from "./staticAssetRendering";
import { isMathFenceLanguage } from "./math";

export interface HighlightSpan {
  readonly from: number;
  readonly to: number;
  readonly className: string;
}

export interface AdvancedRenderOptions {
  readonly language?: string;
  readonly maxSourceLength?: number;
}

export type CodeLanguageKind = "unspecified" | "plain" | "known" | "custom";

export interface CodeLanguageMetadata {
  /** The identifier as written by the user, without the rest of the info string. */
  readonly identifier: string;
  readonly label: string;
  readonly aliases: readonly string[];
  readonly badge: string;
  readonly highlightLanguage?: string;
  readonly kind: CodeLanguageKind;
}

export const MAX_RENDER_SOURCE_LENGTH = 250_000;
/**
 * Resolve a Markdown info-string identifier to the highlight.js grammar that
 * should render it. Different Markdown languages may intentionally share one
 * grammar, so this table is not used to determine language identity.
 */
const LANGUAGE_HIGHLIGHT_ALIASES: Record<string, string> = {
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  "c++": "cpp",
  cxx: "cpp",
  csharp: "csharp",
  cs: "csharp",
  "c#": "csharp",
  css: "css",
  csv: "csv",
  go: "go",
  html: "xml",
  http: "http",
  ini: "ini",
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

/**
 * Resolve an info-string identifier to its Markdown language identity. Keep
 * this list explicit instead of deriving it from the highlight grammar: TSX
 * and TypeScript, HTML and XML, TOML and INI, and JSX and JavaScript are
 * distinct user-facing choices even when their syntax is highlighted by the
 * same grammar.
 */
const LANGUAGE_IDENTITIES: Record<string, string> = {
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  "c++": "cpp",
  cxx: "cpp",
  csharp: "csharp",
  cs: "csharp",
  "c#": "csharp",
  css: "css",
  csv: "csv",
  go: "go",
  html: "html",
  http: "http",
  ini: "ini",
  java: "java",
  javascript: "javascript",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "jsx",
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
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  typescript: "typescript",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

const LANGUAGE_LABELS: Record<string, string> = {
  bash: "Shell",
  c: "C",
  cpp: "C++",
  "c++": "C++",
  csharp: "C#",
  "c#": "C#",
  css: "CSS",
  csv: "CSV",
  go: "Go",
  html: "HTML",
  http: "HTTP",
  ini: "INI",
  java: "Java",
  javascript: "JavaScript",
  jsx: "JSX",
  json: "JSON",
  kotlin: "Kotlin",
  less: "Less",
  markdown: "Markdown",
  php: "PHP",
  plaintext: "Plain Text",
  python: "Python",
  ruby: "Ruby",
  rust: "Rust",
  scss: "SCSS",
  sql: "SQL",
  swift: "Swift",
  toml: "TOML",
  text: "Plain Text",
  ts: "TypeScript",
  tsx: "TSX",
  typescript: "TypeScript",
  xml: "XML",
  yaml: "YAML",
};

const LANGUAGE_BADGES: Record<string, string> = {
  bash: "SH",
  c: "C",
  cpp: "C++",
  "c++": "C++",
  csharp: "C#",
  "c#": "C#",
  css: "CSS",
  html: "HTML",
  ini: "INI",
  javascript: "JS",
  jsx: "JSX",
  json: "{}",
  markdown: "MD",
  plaintext: "TXT",
  python: "PY",
  ruby: "RB",
  rust: "RS",
  shell: "SH",
  sql: "SQL",
  swift: "SW",
  toml: "TOML",
  ts: "TS",
  tsx: "TSX",
  typescript: "TS",
  xml: "XML",
  yaml: "YML",
};

function languageIdentifier(language: string): string {
  return language.trim().split(/\s+/, 1)[0] ?? "";
}

function normalizedLanguage(language: string): string {
  const first = language.trim().split(/\s+/, 1)[0] ?? "";
  const lower = first.toLowerCase();
  return LANGUAGE_HIGHLIGHT_ALIASES[lower] ?? lower;
}

function knownLanguage(language: string): string | undefined {
  const normalized = normalizedLanguage(language);
  if (!normalized) return undefined;
  return hljs.getLanguage(normalized) ? normalized : undefined;
}

/** Return the first info-string token without altering the original string. */
export function codeLanguageIdentifier(language: string): string {
  return languageIdentifier(language);
}

/** Return the info-string text after the first language identifier. */
export function codeLanguageSuffix(language: string): string {
  const withoutLeadingWhitespace = language.trimStart();
  const identifier = languageIdentifier(withoutLeadingWhitespace);
  return identifier ? withoutLeadingWhitespace.slice(identifier.length) : "";
}

/** Resolve display metadata independently from the value saved in Markdown. */
export function codeLanguageMetadata(language: string): CodeLanguageMetadata {
  const identifier = languageIdentifier(language);
  if (!identifier)
    return {
      identifier: "",
      label: "Plain Text",
      aliases: [],
      badge: "TXT",
      kind: "unspecified",
    };

  const lower = identifier.toLowerCase();
  if (lower === "txt" || lower === "text" || lower === "plaintext")
    return {
      identifier,
      label: "Plain Text",
      aliases: ["txt", "text", "plaintext"],
      badge: "TXT",
      highlightLanguage: "plaintext",
      kind: "plain",
    };

  const highlightLanguage = knownLanguage(identifier);
  if (!highlightLanguage)
    return {
      identifier,
      label: identifier,
      aliases: [identifier],
      badge: "CODE",
      kind: "custom",
    };

  const identity = LANGUAGE_IDENTITIES[lower] ?? lower;
  const aliases = Object.entries(LANGUAGE_IDENTITIES)
    .filter(([, resolved]) => resolved === identity)
    .map(([alias]) => alias);
  const label =
    LANGUAGE_LABELS[lower] ??
    LANGUAGE_LABELS[identity] ??
    LANGUAGE_LABELS[highlightLanguage] ??
    identifier;
  return {
    identifier,
    label,
    aliases: Array.from(new Set([lower, ...aliases])),
    badge:
      LANGUAGE_BADGES[lower] ??
      LANGUAGE_BADGES[highlightLanguage] ??
      identifier.slice(0, 4).toUpperCase(),
    highlightLanguage,
    kind: "known",
  };
}

/** The candidate list is intentionally limited to languages registered in the bundled hljs build. */
export function codeLanguageOptions(): readonly CodeLanguageMetadata[] {
  const options: CodeLanguageMetadata[] = [
    codeLanguageMetadata(""),
    codeLanguageMetadata("plaintext"),
  ];
  const seen = new Set(
    options.map((option) => option.identifier || option.kind),
  );
  // Include aliases as selectable entries as well as searchable metadata. This
  // lets a user who chooses `toml`, `tsx`, or `c#` keep that spelling in the
  // Markdown info string even when highlight.js uses another grammar id.
  const identifiers = [
    ...hljs.listLanguages().sort(),
    // Keep aliases which have their own user-facing spelling visible as
    // entries; the remaining aliases stay searchable through metadata.
    "c#",
    "c++",
    "html",
    "jsx",
    "toml",
    "tsx",
  ];
  for (const identifier of identifiers) {
    const option = codeLanguageMetadata(identifier);
    if (option.kind !== "known" || seen.has(identifier.toLowerCase())) continue;
    seen.add(identifier.toLowerCase());
    options.push(option);
  }
  return options;
}

/** Validate only newly entered identifiers; existing info strings are not rewritten by this check. */
export function isValidCodeLanguageIdentifier(value: string): boolean {
  const hasInvalidCharacter = Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      /\s/.test(character) ||
      character === "`" ||
      character === "~"
    );
  });
  return value.length <= 128 && value.length > 0 && !hasInvalidCharacter;
}

/** Replace only the first info-string token and retain all following metadata verbatim. */
export function replaceCodeLanguageIdentifier(
  info: string,
  identifier: string,
): string {
  const leading = info.match(/^\s*/)?.[0] ?? "";
  const rest = info.slice(leading.length);
  const match = /^(\S+)([\s\S]*)$/.exec(rest);
  if (!match) return leading + identifier;
  return leading + identifier + (match[2] ?? "");
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
  return isValidCodeLanguageIdentifier(language);
}

export function codeLanguageLabel(language: string): string {
  return codeLanguageMetadata(language).label;
}

export function codeLanguageIcon(language: string): string {
  return codeLanguageMetadata(language).badge;
}

export function codeControlIcon(
  name: "copy" | "expand" | "close" | "more" | "chevron",
): string {
  const path =
    name === "copy"
      ? '<rect x="5" y="5" width="10" height="12" rx="1.5"/><path d="M8 5V3.5A1.5 1.5 0 0 1 9.5 2h6A1.5 1.5 0 0 1 17 3.5v8A1.5 1.5 0 0 1 15.5 13H15"/>'
      : name === "expand"
        ? '<path d="M8 3H3v5M3 3l6 6M16 21h5v-5M21 21l-6-6M16 3h5v5M21 3l-6 6M8 21H3v-5M3 21l6-6"/>'
        : name === "close"
          ? '<path d="m5 5 14 14M19 5 5 19"/>'
          : name === "chevron"
            ? '<path d="m5 8 7 7 7-7"/>'
            : '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>';
  return `<svg class="mm-code-action-svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
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
  const identifier = codeLanguageIdentifier(language);
  const normalized = normalizedLanguage(identifier);
  const highlighted =
    safeSource.length <= MAX_RENDER_SOURCE_LENGTH
      ? highlightedHtml(safeSource, language)
      : undefined;
  const body = highlighted ?? escapeHtml(safeSource);
  const languageAttribute =
    identifier && validLanguageAttribute(identifier)
      ? ' data-language="' + escapeHtml(identifier) + '"'
      : "";
  const highlightAttribute =
    safeSource.length > MAX_RENDER_SOURCE_LENGTH
      ? ' data-mm-highlight="skipped-large"'
      : "";
  const metadata = codeLanguageMetadata(language);
  const codeClass =
    highlighted !== undefined &&
    metadata.kind === "known" &&
    normalized &&
    validLanguageAttribute(normalized)
      ? ' class="language-' + escapeHtml(normalized) + " hljs" + '"'
      : "";
  const unsupportedAttribute =
    metadata.kind === "custom" && safeSource.length <= MAX_RENDER_SOURCE_LENGTH
      ? ' data-mm-highlight="unsupported"'
      : "";
  const languageLabel = codeLanguageLabel(language);
  const languageIcon = codeLanguageIcon(language);
  const languageInfoAttribute =
    language.length > 0
      ? ' data-mm-code-info="' + escapeHtml(language) + '"'
      : "";
  return (
    '<div class="mm-code-block"' +
    languageAttribute +
    highlightAttribute +
    unsupportedAttribute +
    languageInfoAttribute +
    ' data-mm-code-language="' +
    escapeHtml(languageLabel) +
    '" data-mm-code-language-kind="' +
    metadata.kind +
    '">' +
    '<div class="mm-code-block-header">' +
    '<div class="mm-code-language-control mm-code-language-readonly" role="img" aria-label="Code language: ' +
    escapeHtml(languageLabel) +
    '">' +
    '<span class="mm-code-language-icon" aria-hidden="true">' +
    escapeHtml(languageIcon) +
    "</span>" +
    '<span class="mm-code-language-label">' +
    escapeHtml(languageLabel) +
    "</span>" +
    "</div>" +
    '<div class="mm-code-block-actions">' +
    '<button type="button" class="mm-code-action" data-mm-code-action="copy" aria-label="Copy code" title="Copy code">' +
    '<span class="mm-code-action-icon">' +
    codeControlIcon("copy") +
    "</span>" +
    '<span class="mm-code-action-label">Copy</span>' +
    "</button>" +
    '<span class="mm-code-action-separator" aria-hidden="true"></span>' +
    '<button type="button" class="mm-code-action" data-mm-code-action="expand" aria-label="Expand code" title="Expand">' +
    '<span class="mm-code-action-icon">' +
    codeControlIcon("expand") +
    "</span>" +
    '<span class="mm-code-action-label">Expand</span>' +
    "</button>" +
    '<button type="button" class="mm-code-action mm-code-action-more" data-mm-code-action="more" aria-label="More code block actions" title="More code block actions">' +
    '<span class="mm-code-action-icon">' +
    codeControlIcon("more") +
    "</span>" +
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
  if (isMathFenceLanguage(language) || isMathFenceLanguage(lowerKind))
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
