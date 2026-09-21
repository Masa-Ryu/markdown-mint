import MarkdownIt from "markdown-it";
import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import * as prettier from "prettier/standalone";
import markdownPrettierPlugin from "prettier/plugins/markdown";
import type { Options as PrettierOptions } from "prettier";
import {
  Fragment,
  type Mark,
  type Node as PMNode,
  type MarkType,
  type MarkSpec,
  type NodeSpec,
  type NodeType,
  Schema,
} from "prosemirror-model";
import { addListNodes } from "prosemirror-schema-list";
import { tableNodes } from "prosemirror-tables";
import {
  renderAdvancedBlock as renderAdvancedBlockHtml,
  renderCodeBlock as renderCodeBlockHtml,
  renderMath as renderMathHtml,
} from "./visualRendering";
import { codeFenceFor } from "./codeBlockSerialization";
import infoIconAsset from "../../assets/menu/github/info-icon.svg?raw";
import lightbulbAsset from "../../assets/menu/github/lightbulb.svg?raw";
import warningTriangleAsset from "../../assets/menu/github/warning-triangle.svg?raw";
import alertOctagonAsset from "../../assets/menu/github/alert-octagon.svg?raw";
import alertCommentAsset from "../../assets/menu/github/alert-comment.svg?raw";
import { parseAlertSource } from "./alerts";
import {
  detailsTagRanges,
  parseDetailsSource as splitDetailsSource,
  type DetailsSourceParts,
  type DetailsTagRange,
} from "./details";
import { isMathFenceLanguage } from "./math";
export {
  isMathFenceLanguage,
  mathFenceLanguage,
  MATH_FENCE_LANGUAGES,
} from "./math";
export {
  alertSourceWithBody,
  alertSourceWithType,
  parseAlertSource,
} from "./alerts";
export type { AlertSourceParts } from "./alerts";
export const alertSourceParts = parseAlertSource;

export { serializeCodeBlockMarkdown } from "./codeBlockSerialization";

/** The Markdown dialect used by the editor and preview. */
export type Profile = "github" | "gitlab" | "commonmark";

/**
 * Maximum number of source-authored empty paragraphs materialized for one
 * blank run. The remainder stays in a source-preserving spacer atom so an
 * untrusted document cannot allocate one PM/DOM node per newline.
 */
export const MAX_MATERIALIZED_EMPTY_PARAGRAPHS = 256;

/** A diagnostic returned by {@link inspectCompatibility}. */
export interface CompatibilityDiagnostic {
  message: string;
  severity?: "info" | "warning";
  code?: string;
  line?: number;
  column?: number;
  kind?: string;
}

/** A source slice associated with an unchanged top-level ProseMirror node. */
export interface MarkdownBlockSnapshot {
  node: PMNode;
  /**
   * The source slice for this node and its boundary. Materialized empty
   * paragraphs and bounded blank-spacer atoms carry the surplus line-ending
   * slice that represents them.
   */
  source: string;
  /** The part covered by the Markdown block token. */
  body: string;
  /** Blank lines and trailing line endings after the block. */
  separator: string;
  startLine: number | undefined;
  endLine: number | undefined;
  kind?: string;
}

/**
 * The parsed document plus enough source information to preserve untouched
 * blocks.  The index signature intentionally leaves room for host metadata.
 */
export interface MarkdownSnapshot {
  doc: PMNode;
  source: string;
  profile?: Profile;
  blocks?: MarkdownBlockSnapshot[];
  /** Footnote definitions collected from the source in document order. */
  footnotes?: FootnoteDefinition[];
  leading?: string;
  trailing?: string;
  lineEnding: "lf" | "crlf" | "mixed" | "none";
  [mapping: string]: unknown;
}

/** A source-preserving GitHub/GitLab footnote definition. */
export interface FootnoteDefinition {
  /** A normalized label used for matching. */
  label: string;
  /** The label as it appeared in the source. */
  sourceLabel: string;
  /** Definition body, with Markdown indentation removed. */
  content: string;
  /** Complete definition source, excluding the trailing separator. */
  source: string;
  /** Zero-based source offsets, when the definition came from a document. */
  start?: number;
  end?: number;
}

/** Optional context used when rendering an individual PM node. */
export interface RenderContext {
  /** The source snapshot that produced the node. */
  snapshot?: MarkdownSnapshot;
  /** A document to use for heading/footnote context. */
  document?: PMNode;
  /** Footnotes can be supplied when rendering a raw atom independently. */
  footnotes?: FootnoteDefinition[];
  /** The active profile, useful to injected advanced renderers. */
  profile?: Profile;
  /** Internal state is public so NodeViews can render a sequence consistently. */
  headingSlugs?: Map<string, number>;
  footnoteRefs?: Map<string, number>;
  footnoteNumbers?: Map<string, number>;
  /** Heading ids belong to positions within a rendering root, not node identity. */
  headingIds?: WeakMap<PMNode, Map<number, string>>;
  /** Optional document position for detached NodeView render calls. */
  nodePosition?: number;
  /** Hosts may provide richer renderers without coupling core to a webview. */
  renderCodeBlock?: (source: string, language?: string) => string | null;
  renderMath?: (source: string, display: boolean) => string | null;
  renderAdvancedBlock?: (
    kind: string,
    source: string,
    options?: Record<string, unknown>,
  ) => string | null;
}

type MarkdownToken = {
  map?: [number, number];
  children?: MarkdownToken[] | null;
  attrs?: Array<[string, string]> | null;
  content?: string;
  info?: string;
  markup?: string;
  tag?: string;
  nesting?: number;
  level?: number;
  type: string;
};

interface SourceLocation {
  start: number;
  end: number;
  startLine?: number;
  endLine?: number;
}

const rawBlockSpec: NodeSpec = {
  group: "block",
  atom: true,
  selectable: true,
  attrs: {
    source: { default: "" },
    kind: { default: "unknown" },
  },
  parseDOM: [
    {
      tag: "pre[data-markdown-raw]",
      getAttrs: (dom) => {
        const element = dom as HTMLElement;
        return {
          source: element.textContent ?? "",
          kind: element.getAttribute("data-kind") ?? "unknown",
        };
      },
    },
  ],
  toDOM: (node) => [
    "pre",
    {
      "data-markdown-raw": "true",
      "data-kind": node.attrs.kind,
    },
    node.attrs.source,
  ],
};

const rawInlineSpec: NodeSpec = {
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,
  attrs: {
    source: { default: "" },
    kind: { default: "unknown" },
  },
  parseDOM: [
    {
      tag: "span[data-markdown-raw]",
      getAttrs: (dom) => {
        const element = dom as HTMLElement;
        return {
          source: element.textContent ?? "",
          kind: element.getAttribute("data-kind") ?? "unknown",
        };
      },
    },
  ],
  toDOM: (node) => [
    "span",
    {
      "data-markdown-raw": "true",
      "data-kind": node.attrs.kind,
    },
    node.attrs.source,
  ],
};

const baseNodes: Record<string, NodeSpec> = {
  doc: { content: "block+" },
  paragraph: {
    content: "inline*",
    group: "block",
    parseDOM: [{ tag: "p" }],
    toDOM: () => ["p", 0],
  },
  blockquote: {
    content: "block+",
    group: "block",
    defining: true,
    parseDOM: [{ tag: "blockquote" }],
    toDOM: () => ["blockquote", 0],
  },
  horizontal_rule: {
    group: "block",
    attrs: { source: { default: null } },
    parseDOM: [{ tag: "hr" }],
    toDOM: () => ["hr"],
  },
  heading: {
    attrs: { level: { default: 1 } },
    content: "inline*",
    group: "block",
    defining: true,
    parseDOM: [
      { tag: "h1", attrs: { level: 1 } },
      { tag: "h2", attrs: { level: 2 } },
      { tag: "h3", attrs: { level: 3 } },
      { tag: "h4", attrs: { level: 4 } },
      { tag: "h5", attrs: { level: 5 } },
      { tag: "h6", attrs: { level: 6 } },
    ],
    toDOM: (node) => [`h${node.attrs.level}`, 0],
  },
  code_block: {
    content: "text*",
    marks: "",
    group: "block",
    code: true,
    defining: true,
    attrs: { params: { default: "" } },
    parseDOM: [
      {
        tag: "pre",
        preserveWhitespace: "full",
        getAttrs: (dom) => {
          const code = (dom as HTMLElement).firstElementChild;
          const classes = code?.getAttribute("class") ?? "";
          const language =
            classes.match(/(?:^|\s)language-([^\s]+)/)?.[1] ?? "";
          return { params: language };
        },
      },
    ],
    toDOM: (node) => [
      "pre",
      [
        "code",
        node.attrs.params &&
        /^[A-Za-z0-9_+.-]+$/.test(String(node.attrs.params))
          ? { class: `language-${node.attrs.params}` }
          : {},
        0,
      ],
    ],
  },
  text: { group: "inline" },
  image: {
    inline: true,
    group: "inline",
    draggable: true,
    attrs: {
      src: { default: "" },
      alt: { default: null },
      title: { default: null },
      width: { default: null },
      height: { default: null },
    },
    parseDOM: [
      {
        tag: "img[src]",
        getAttrs: (dom) => {
          const element = dom as HTMLImageElement;
          return {
            src: safeUrl(element.getAttribute("src") ?? "", true) ?? "",
            alt: element.getAttribute("alt"),
            title: element.getAttribute("title"),
            width: element.getAttribute("width"),
            height: element.getAttribute("height"),
          };
        },
      },
    ],
    toDOM: (node) => {
      const src = safeUrl(node.attrs.src, true);
      return [
        "img",
        {
          ...(src ? { src } : { "data-markdown-unsafe-src": "true" }),
          alt: node.attrs.alt ?? "",
          ...(node.attrs.title ? { title: node.attrs.title } : {}),
          ...(safeImageDimension(node.attrs.width)
            ? { width: safeImageDimension(node.attrs.width) }
            : {}),
          ...(safeImageDimension(node.attrs.height)
            ? { height: safeImageDimension(node.attrs.height) }
            : {}),
        },
      ];
    },
  },
  hard_break: {
    inline: true,
    group: "inline",
    selectable: false,
    linebreakReplacement: true,
    parseDOM: [{ tag: "br" }],
    toDOM: () => ["br"],
  },
  raw_block: rawBlockSpec,
  raw_inline: rawInlineSpec,
  details: {
    group: "block",
    content: "block+",
    defining: true,
    isolating: true,
    attrs: {
      source: { default: "" },
      kind: { default: "details" },
      summarySource: { default: "" },
      sourceProfile: { default: "github" },
    },
    toDOM: (node) => [
      "div",
      {
        "data-mm-details-source": serializeDetails(node),
        "data-mm-details-profile": node.attrs.sourceProfile,
      },
      ["div", { contenteditable: "false" }, node.attrs.summarySource],
      ["div", { "data-mm-details-content": "true" }, 0],
    ],
    parseDOM: [
      {
        tag: "div[data-mm-details-source]",
        contentElement: "[data-mm-details-content]",
        getAttrs: (dom) => {
          const source =
            (dom as HTMLElement).getAttribute("data-mm-details-source") ?? "";
          const sourceProfile = ((dom as HTMLElement).getAttribute(
            "data-mm-details-profile",
          ) ?? "github") as Profile;
          return {
            source,
            summarySource:
              parseDetailsSource(source, sourceProfile)?.summary ?? "",
            sourceProfile,
          };
        },
      },
    ],
  },
};

const marks: Record<string, MarkSpec> = {
  em: {
    parseDOM: [{ tag: "i" }, { tag: "em" }, { style: "font-style=italic" }],
    toDOM: () => ["em", 0],
  },
  strong: {
    parseDOM: [{ tag: "strong" }, { tag: "b" }, { style: "font-weight=500" }],
    toDOM: () => ["strong", 0],
  },
  link: {
    attrs: {
      href: { default: "" },
      title: { default: null },
    },
    inclusive: false,
    parseDOM: [
      {
        tag: "a[href]",
        getAttrs: (dom) => {
          const element = dom as HTMLAnchorElement;
          return {
            href: safeUrl(element.getAttribute("href") ?? "") ?? "",
            title: element.getAttribute("title"),
          };
        },
      },
    ],
    toDOM: (node) => {
      const href = safeUrl(node.attrs.href);
      return [
        "a",
        {
          ...(href ? { href } : { "data-markdown-unsafe-href": "true" }),
          ...(node.attrs.title ? { title: node.attrs.title } : {}),
        },
        0,
      ];
    },
  },
  code: {
    parseDOM: [{ tag: "code" }],
    toDOM: () => ["code", 0],
  },
  strike: {
    parseDOM: [{ tag: "s" }, { tag: "del" }, { tag: "strike" }],
    toDOM: () => ["del", 0],
  },
};

// addListNodes works on ProseMirror's OrderedMap. Creating a tiny base schema
// is the public, version-stable way to obtain that map without depending on
// the transitive `orderedmap` package directly.
const baseSchema = new Schema({ nodes: baseNodes, marks });
let schemaNodes = addListNodes(
  baseSchema.spec.nodes,
  "paragraph block*",
  "block",
);
const listItemSpec = schemaNodes.get("list_item");
if (listItemSpec) {
  schemaNodes = schemaNodes.update("list_item", {
    ...listItemSpec,
    attrs: { ...(listItemSpec.attrs ?? {}), checked: { default: null } },
    parseDOM: [
      {
        tag: "li",
        getAttrs: (dom) => ({
          checked:
            (dom as HTMLElement).getAttribute("data-checked") === "mixed"
              ? "mixed"
              : (dom as HTMLElement).getAttribute("data-checked") === "true"
                ? true
                : null,
        }),
      },
    ],
    toDOM: (node) => [
      "li",
      node.attrs.checked == null
        ? {}
        : { "data-checked": String(node.attrs.checked) },
      0,
    ],
  });
}

const tableNodeSpecs = tableNodes({
  tableGroup: "block",
  // A GFM cell is one inline line. Hard breaks are represented by the
  // whitelist <br> token, so nested blocks cannot be silently truncated by
  // the Markdown serializer.
  cellContent: "paragraph",
  cellAttributes: {
    alignment: {
      default: null,
      getFromDOM: (dom) => {
        const element = dom as HTMLElement;
        const alignment =
          element.style.textAlign || element.getAttribute("align") || "";
        return /^(left|center|right)$/i.test(alignment)
          ? alignment.toLowerCase()
          : null;
      },
      setDOMAttr: (value, attrs) => {
        if (value) attrs.style = `text-align: ${value}`;
      },
    },
  },
});
schemaNodes = schemaNodes.append(tableNodeSpecs);

/** Shared ProseMirror schema used by the editor, clipboard, and preview. */
export const schema = new Schema({ nodes: schemaNodes, marks });

type KnownNodeTypes = {
  [name: string]: NodeType;
  paragraph: NodeType;
  blockquote: NodeType;
  heading: NodeType;
  horizontal_rule: NodeType;
  code_block: NodeType;
  image: NodeType;
  hard_break: NodeType;
  raw_block: NodeType;
  raw_inline: NodeType;
  details: NodeType;
  bullet_list: NodeType;
  ordered_list: NodeType;
  list_item: NodeType;
  table: NodeType;
  table_row: NodeType;
  table_cell: NodeType;
  table_header: NodeType;
};
type KnownMarkTypes = {
  [name: string]: MarkType;
  em: MarkType;
  strong: MarkType;
  strike: MarkType;
  link: MarkType;
  code: MarkType;
};
const nodeTypes = schema.nodes as unknown as KnownNodeTypes;
const markTypes = schema.marks as unknown as KnownMarkTypes;

const emptyParagraph = (): PMNode =>
  nodeTypes.paragraph.create(null, Fragment.empty);

function childrenOf(node: PMNode): PMNode[] {
  const children: PMNode[] = [];
  node.forEach((child) => children.push(child));
  return children;
}

/**
 * Configure a markdown-it instance with the dialect options used by the core.
 * Hosts that need native markdown-it token rendering can use this instance and
 * then apply their renderer. Parsing keeps HTML tokens enabled so unsupported
 * constructs can become source-preserving atoms; safe rendering is performed
 * by renderMarkdown/renderMarkdownDocument.
 */
export function configureMarkdownIt(
  md: MarkdownIt,
  profile: Profile = "github",
): MarkdownIt {
  md.options.html = true;
  md.options.linkify = false;
  md.options.typographer = false;
  md.options.breaks = false;
  if (profile === "commonmark") {
    md.options.xhtmlOut = false;
    md.disable(["table", "strikethrough"]);
  } else {
    md.enable(["table", "strikethrough"]);
  }
  // Math must be claimed before Markdown-it's heading/emphasis rules.  A
  // display equation containing a line with only `=` is otherwise parsed as
  // a Setext heading, and inline equations containing Markdown punctuation
  // can be split into unrelated tokens before the renderer sees them.
  md.block.ruler.before(
    "heading",
    "markdown_mint_math_block",
    markdownMintMathBlock,
  );
  md.inline.ruler.before(
    "text",
    "markdown_mint_math_inline",
    markdownMintMathInline,
  );
  return md;
}

/** Create the parser used by both the PM bridge and host preview adapters. */
export function createMarkdownIt(profile: Profile = "github"): MarkdownIt {
  const preset = profile === "commonmark" ? "commonmark" : "default";
  return configureMarkdownIt(
    new MarkdownIt(preset, { html: true, linkify: false, typographer: false }),
    profile,
  );
}

const escapedDollarMarker = "\uE000\uE001";

const inlineMathPattern = /^\$(?!\$)(?=\S)(?:\\.|[^$\r\n])*?(?<!\s)\$(?![\w$])/;

function isEscapedAt(source: string, offset: number): boolean {
  let slashCount = 0;
  for (let index = offset - 1; index >= 0 && source[index] === "\\"; index -= 1)
    slashCount += 1;
  return slashCount % 2 === 1;
}

function markdownMintMathInline(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (
    state.src.charCodeAt(start) !== 36 ||
    state.src.charCodeAt(start + 1) === 36 ||
    isEscapedAt(state.src, start)
  )
    return false;
  const match = state.src.slice(start).match(inlineMathPattern);
  if (!match) return false;
  if (!silent) {
    const token = state.push("math_inline", "math", 0);
    token.markup = "$";
    token.content = match[0]!;
  }
  state.pos += match[0]!.length;
  return true;
}

function markdownMintMathBlock(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  // Display delimiters are a top-level construct in Markdown Mint. Nested
  // block content keeps the existing quote/list parsing path so its source
  // prefixes are not accidentally sent to KaTeX as part of the expression.
  if (state.level !== 0) return false;
  const opening = state.src.slice(
    state.bMarks[startLine]! + state.tShift[startLine]!,
    state.eMarks[startLine]!,
  );
  const openingTrimmed = opening.trim();
  if (!/^\$\$\s*$/.test(openingTrimmed)) {
    // Also accept a compact one-line display expression such as `$$x^2$$`.
    if (!/^\$\$[\s\S]*\$\$\s*$/.test(openingTrimmed)) return false;
    if (silent) return true;
    const token = state.push("math_block", "math", 0);
    token.block = true;
    token.map = [startLine, startLine + 1];
    token.markup = "$$";
    token.content = openingTrimmed;
    state.line = startLine + 1;
    return true;
  }

  let closingLine = startLine + 1;
  for (; closingLine < endLine; closingLine += 1) {
    const line = state.src.slice(
      state.bMarks[closingLine]! + state.tShift[closingLine]!,
      state.eMarks[closingLine]!,
    );
    if (/^\$\$\s*$/.test(line.trim())) break;
  }
  // An unmatched opening delimiter remains an ordinary paragraph.  This is
  // essential for prose and code examples that happen to contain `$$`.
  if (closingLine >= endLine) return false;
  if (silent) return true;
  const token = state.push("math_block", "math", 0);
  token.block = true;
  token.map = [startLine, closingLine + 1];
  token.markup = "$$";
  token.content = state.getLines(
    startLine + 1,
    closingLine,
    state.blkIndent,
    true,
  );
  state.line = closingLine + 1;
  return true;
}

function maskEscapedDollars(source: string): string {
  // Keep source offsets stable while preventing escaped currency from being
  // mistaken for a TeX delimiter by the lightweight inline math scanner.
  return source.replace(/(?<!\\)\\\$/g, escapedDollarMarker);
}

function restoreEscapedDollars(value: string, literal = false): string {
  return value.split(escapedDollarMarker).join(literal ? "\\$" : "$");
}

function attrsOf(token: MarkdownToken): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of token.attrs ?? []) {
    result[pair[0]] = restoreEscapedDollars(String(pair[1] ?? ""));
  }
  return result;
}

function tokenText(token: MarkdownToken): string {
  return restoreEscapedDollars(token.content ?? "");
}

function literalTokenText(token: MarkdownToken): string {
  return restoreEscapedDollars(token.content ?? "", true);
}

function lineOffsets(source: string): number[] {
  const offsets = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") offsets.push(index + 1);
    else if (source[index] === "\r") {
      if (source[index + 1] === "\n") index += 1;
      offsets.push(index + 1);
    }
  }
  return offsets;
}

function offsetForLine(
  offsets: number[],
  line: number | undefined,
  sourceLength: number,
): number {
  if (line == null || line < 0) return sourceLength;
  return Math.min(offsets[line] ?? sourceLength, sourceLength);
}

function tokenLocation(
  token: MarkdownToken,
  source: string,
  offsets: number[],
): SourceLocation {
  const map = token.map;
  if (!map) return { start: 0, end: source.length };
  return {
    start: offsetForLine(offsets, map[0], source.length),
    end: offsetForLine(offsets, map[1], source.length),
    startLine: map[0],
    endLine: map[1],
  };
}

function markdownLineEnding(source: string): MarkdownSnapshot["lineEnding"] {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\r") {
      if (source[index + 1] === "\n") {
        crlf += 1;
        index += 1;
      } else cr += 1;
    } else if (source[index] === "\n") lf += 1;
  }
  if (crlf === 0 && lf === 0 && cr === 0) return "none";
  if (crlf > 0 && lf === 0 && cr === 0) return "crlf";
  if (lf > 0 && crlf === 0 && cr === 0) return "lf";
  return "mixed";
}

function findClosing(
  tokens: MarkdownToken[],
  openIndex: number,
  openType: string,
  end: number,
): number {
  const closeType = openType.endsWith("_open")
    ? `${openType.slice(0, -5)}_close`
    : "";
  let depth = 0;
  for (let index = openIndex; index < end; index += 1) {
    const type = tokens[index]!.type;
    if (type === openType) depth += 1;
    else if (type === closeType) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return end;
}

function markFor(type: string, attrs: Record<string, string>): Mark | null {
  switch (type) {
    case "em":
      return markTypes.em.create();
    case "strong":
      return markTypes.strong.create();
    case "s":
    case "del":
      return markTypes.strike.create();
    case "link":
      return markTypes.link.create({
        href: attrs.href ?? "",
        title: attrs.title ?? null,
      });
    case "code":
      return markTypes.code.create();
    default:
      return null;
  }
}

const emojiShortcodes: Record<string, string> = {
  tada: "🎉",
  party: "🎉",
  rocket: "🚀",
  warning: "⚠️",
  white_check_mark: "✅",
  heavy_check_mark: "✔️",
  checkered_flag: "🏁",
  construction: "🚧",
  x: "❌",
  cross_mark: "❌",
  bulb: "💡",
  memo: "📝",
  smile: "😄",
  smiley: "😃",
  grin: "😁",
  blush: "😊",
  wink: "😉",
  heart: "❤️",
  sparkles: "✨",
  fire: "🔥",
  eyes: "👀",
  tada_dance: "💃",
};

interface ImageDimensions {
  width: string | null;
  height: string | null;
}

function safeImageDimension(value: unknown): string | null {
  const candidate = String(value ?? "").trim();
  if (!candidate) return null;
  if (!/^\d+(?:\.\d+)?(?:px|%)?$/i.test(candidate)) return null;
  return candidate;
}

function parseImageDimensions(value: string): ImageDimensions | null {
  const match = value.trim().match(/^\{([^{}]+)\}$/);
  if (!match) return null;
  let width: string | null = null;
  let height: string | null = null;
  for (const pair of match[1]!.matchAll(
    /(?:^|\s)(width|height)\s*=\s*([^\s}]+)/gi,
  )) {
    const dimension = safeImageDimension(pair[2]);
    if (!dimension) continue;
    if (pair[1]!.toLowerCase() === "width") width = dimension;
    else height = dimension;
  }
  return width || height ? { width, height } : null;
}

const safeInlineTagNames = new Set([
  "strong",
  "em",
  "b",
  "i",
  "kbd",
  "sup",
  "sub",
  "code",
  "del",
  "s",
  "br",
]);

interface InlineHtmlTag {
  name: string;
  closing: boolean;
  void: boolean;
}

function inlineHtmlTag(source: string): InlineHtmlTag | null {
  const match = source
    .trim()
    .match(/^<\s*(\/?)([a-z][a-z0-9-]*)(?:\s[^>]*)?>$/i);
  if (!match || !safeInlineTagNames.has(match[2]!.toLowerCase())) return null;
  const name = match[2]!.toLowerCase();
  return { name, closing: Boolean(match[1]), void: name === "br" };
}

function rawInline(source: string, kind: string, marks: Mark[] = []): PMNode {
  return nodeTypes.raw_inline.create({ source, kind }, null, marks);
}

const footnoteNodeMetadata = new WeakMap<PMNode, FootnoteDefinition[]>();

function footnoteRawInline(
  source: string,
  kind: string,
  marks: Mark[],
  footnotes: Map<string, FootnoteDefinition> | undefined,
): PMNode {
  const node = rawInline(source, kind, marks);
  if (footnotes && footnotes.size > 0)
    footnoteNodeMetadata.set(node, Array.from(footnotes.values()));
  return node;
}

function inlineTokenSource(token: MarkdownToken): string | null {
  if (token.type === "text") {
    // Markdown-it exposes decoded text here. Re-escape it before rebuilding a
    // safe HTML pair so a literal `*`, `_`, entity, or backslash cannot become
    // Markdown syntax when the pair is rendered again. This is deliberately
    // based on the semantic token value rather than blindly copying markup:
    // the latter is only a summary for some escape/entity tokens.
    return escapeMarkdownText(literalTokenText(token), false, false);
  }
  if (token.type === "html_inline") return literalTokenText(token);
  if (token.type === "softbreak") return "\n";
  if (token.type === "em_open" || token.type === "em_close")
    return token.markup ?? "*";
  if (
    token.type === "strong_open" ||
    token.type === "strong_close" ||
    token.type === "s_open" ||
    token.type === "s_close" ||
    token.type === "del_open" ||
    token.type === "del_close"
  )
    return token.markup ?? "";
  if (token.type === "code_inline") {
    // Markdown-it exposes only the code content and fence marker on a code
    // token. Reconstruct the semantic span with the same padding/fence rules
    // as the serializer so grouping a safe HTML pair cannot trim code-edge
    // whitespace or make backticks part of the surrounding source.
    return serializeCodeSpan(literalTokenText(token));
  }
  return null;
}

function findInlineHtmlPair(
  children: MarkdownToken[],
  openingIndex: number,
  opening: InlineHtmlTag,
): number {
  const stack = [opening.name];
  for (let index = openingIndex + 1; index < children.length; index += 1) {
    const token = children[index]!;
    if (token.type === "html_inline") {
      const tag = inlineHtmlTag(tokenText(token));
      if (tag && !tag.void) {
        if (tag.closing) {
          if (stack[stack.length - 1] !== tag.name) return -1;
          stack.pop();
          if (stack.length === 0) return index;
        } else stack.push(tag.name);
      }
      continue;
    }
    if (inlineTokenSource(token) === null) return -1;
  }
  return -1;
}

function parseInline(
  children: MarkdownToken[] | null | undefined,
  profile: Profile = "github",
  footnotes?: Map<string, FootnoteDefinition>,
): PMNode[] {
  if (!children || children.length === 0) return [];
  const output: PMNode[] = [];
  const markStack: Mark[] = [];
  const emitText = (value: string): void => {
    const restored = restoreEscapedDollars(value);
    if (restored) output.push(schema.text(restored, markStack));
  };
  const pushText = (value: string): void => {
    if (!value) return;
    const footnotePattern =
      footnotes && footnotes.size > 0 ? "\\[\\^[^\\]\\r\\n]+\\]" : "(?!)";
    const pattern = new RegExp(
      "(" +
        footnotePattern +
        (profile === "gitlab"
          ? "|\\{-[\\s\\S]*?-\\}|\\{\\+[\\s\\S]*?\\+\\}|:[a-zA-Z0-9_+\\-]+:"
          : "|:[a-zA-Z0-9_+\\-]+:") +
        ")",
      "g",
    );
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(value)) != null) {
      if (match.index > cursor) emitText(value.slice(cursor, match.index));
      const source = restoreEscapedDollars(match[0]!, true);
      if (source.startsWith("[^")) {
        const label = referenceLabel(source.slice(2, -1));
        if (footnotes?.has(label))
          output.push(
            footnoteRawInline(source, "footnote_ref", markStack, footnotes),
          );
        else emitText(source);
      } else if (source.startsWith("{-") || source.startsWith("{+")) {
        output.push(rawInline(source, "gitlab-inline-diff", markStack));
      } else {
        const name = source.slice(1, -1).toLowerCase();
        if (emojiShortcodes[name])
          output.push(rawInline(source, "emoji", markStack));
        else emitText(source);
      }
      cursor = match.index + source.length;
    }
    if (cursor < value.length) emitText(value.slice(cursor));
  };
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]!;
    const attrs = attrsOf(child);
    switch (child.type) {
      case "em_open": {
        const mark = markFor("em", attrs);
        if (mark) markStack.push(mark);
        break;
      }
      case "em_close":
        if (markStack.length > 0) markStack.pop();
        break;
      case "strong_open": {
        const mark = markFor("strong", attrs);
        if (mark) markStack.push(mark);
        break;
      }
      case "strong_close":
        if (markStack.length > 0) markStack.pop();
        break;
      case "s_open":
      case "del_open": {
        const mark = markFor("s", attrs);
        if (mark) markStack.push(mark);
        break;
      }
      case "s_close":
      case "del_close":
        if (markStack.length > 0) markStack.pop();
        break;
      case "link_open": {
        const next = children[index + 1];
        const reference = tokenText(next ?? ({} as MarkdownToken));
        const label = reference.startsWith("^") ? reference.slice(1) : "";
        const isFootnote =
          Boolean(label) && Boolean(footnotes?.has(referenceLabel(label)));
        if (isFootnote) {
          output.push(
            footnoteRawInline(
              `[^${label}]`,
              "footnote_ref",
              markStack,
              footnotes,
            ),
          );
          while (
            index + 1 < children.length &&
            children[index + 1]!.type !== "link_close"
          )
            index += 1;
          if (index + 1 < children.length) index += 1;
          break;
        }
        const mark = markFor("link", attrs);
        if (mark) markStack.push(mark);
        break;
      }
      case "link_close":
        while (
          markStack.length > 0 &&
          markStack[markStack.length - 1]!.type.name !== "link"
        ) {
          markStack.pop();
        }
        if (markStack.length > 0) markStack.pop();
        break;
      case "code_inline":
        output.push(
          schema.text(literalTokenText(child), [
            ...markStack,
            markTypes.code.create(),
          ]),
        );
        break;
      case "text":
      case "entity":
      case "escape":
      case "html_entity":
        // Restore escaped dollars only after the custom inline rule has
        // claimed real delimiters. This keeps `\$` literal and prevents it
        // from becoming a false math opener.
        pushText(child.content ?? "");
        break;
      case "softbreak":
        emitText("\n");
        break;
      case "hardbreak":
        output.push(nodeTypes.hard_break.create());
        break;
      case "image": {
        const nextText = tokenText(
          children[index + 1] ?? ({} as MarkdownToken),
        );
        const dimensionMatch =
          profile === "gitlab"
            ? nextText.match(/^(\{[^{}]+\})([\s\S]*)$/)
            : null;
        const dimensions = dimensionMatch
          ? parseImageDimensions(dimensionMatch[1]!)
          : null;
        if (dimensions) index += 1;
        output.push(
          nodeTypes.image.create(
            {
              src: attrs.src ?? "",
              alt:
                attrs.alt ||
                tokenText(child) ||
                child.children?.map((entry) => tokenText(entry)).join("") ||
                null,
              title: attrs.title ?? null,
              width: dimensions?.width ?? null,
              height: dimensions?.height ?? null,
            },
            null,
            markStack,
          ),
        );
        if (dimensions && dimensionMatch?.[2]) emitText(dimensionMatch[2]);
        break;
      }
      case "html_inline": {
        const source = literalTokenText(child);
        const tag = inlineHtmlTag(source);
        if (/^<br\s*\/?>(?:\s*)$/i.test(source.trim())) {
          output.push(nodeTypes.hard_break.create());
        } else if (/^<!--[\s\S]*-->$/.test(source.trim())) {
          output.push(rawInline(source, "html-comment", markStack));
        } else if (tag && !tag.closing && !tag.void) {
          // Keep a safe paired element together. Rendering an opener and a
          // closer as separate DOM fragments lets the browser repair the
          // first fragment before its text arrives in a NodeView. Track nested
          // safe tags so a nested <strong> cannot close the outer pair early.
          const closingIndex = findInlineHtmlPair(children, index, tag);
          if (closingIndex > index) {
            const parts = [source];
            for (
              let candidate = index + 1;
              candidate <= closingIndex;
              candidate += 1
            ) {
              const part = inlineTokenSource(children[candidate]!);
              if (part === null) {
                parts.length = 0;
                break;
              }
              parts.push(part);
            }
            if (parts.length > 0) {
              output.push(rawInline(parts.join(""), "html-pair", markStack));
              index = closingIndex;
            } else {
              output.push(rawInline(source, "html-allowed", markStack));
            }
          }
        } else if (tag) {
          output.push(rawInline(source, "html-allowed", markStack));
        } else {
          output.push(rawInline(source, "html", markStack));
        }
        break;
      }
      case "math_inline":
      case "footnote_ref":
      case "footnote_anchor": {
        // Math tokens are created before Markdown-it applies escape rules.
        // Restore an escaped dollar literally so `$x\$y$` stays one source
        // atom and can be serialized without changing its expression.
        const value =
          child.type === "math_inline"
            ? literalTokenText(child)
            : tokenText(child);
        const source = value.startsWith("[^")
          ? value
          : `[^${value.replace(/^\^/, "")}]`;
        output.push(
          rawInline(
            child.type === "math_inline" ? value : source,
            child.type,
            markStack,
          ),
        );
        break;
      }
      default: {
        // Unknown extension tokens remain source atoms. Treating their token
        // name as prose can manufacture Markdown punctuation on save.
        const source = tokenText(child) || child.markup || "";
        if (source)
          output.push(rawInline(source, child.type || "unknown", markStack));
        break;
      }
    }
  }
  return output;
}

function paragraphFromInline(
  token: MarkdownToken | undefined,
  profile: Profile = "github",
  footnotes?: Map<string, FootnoteDefinition>,
): PMNode {
  const content = parseInline(token?.children, profile, footnotes);
  return nodeTypes.paragraph.create(
    null,
    content.length > 0 ? content : Fragment.empty,
  );
}

function firstTextNode(node: PMNode): PMNode | undefined {
  if (node.type.name !== "paragraph") return undefined;
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child.isText) return child;
  }
  return undefined;
}

type TaskState = boolean | "mixed" | null;

function taskInfo(
  children: PMNode[],
  profile: Profile,
): { checked: TaskState; children: PMNode[] } {
  if (profile === "commonmark") return { checked: null, children };
  const firstParagraph = children.find(
    (child) => child.type.name === "paragraph",
  );
  const firstText = firstParagraph ? firstTextNode(firstParagraph) : undefined;
  if (!firstText || !firstText.text) return { checked: null, children };
  const markerPattern = profile === "gitlab" ? " xX~" : " xX";
  const match = firstText.text.match(
    new RegExp("^\\[([" + markerPattern + "])\\][ \t]+"),
  );
  if (!match) return { checked: null, children };
  const marker = match[1]!.toLowerCase();
  const checked: TaskState =
    marker === "x" ? true : marker === "~" ? "mixed" : false;
  const replacement = firstText.text.slice(match[0].length);
  const paragraphIndex = children.indexOf(firstParagraph!);
  const firstParagraphChildren = childrenOf(firstParagraph!);
  const textIndex = firstParagraphChildren.indexOf(firstText);
  if (paragraphIndex < 0 || textIndex < 0) return { checked, children };
  const paragraphChildren = firstParagraphChildren.slice();
  if (replacement)
    paragraphChildren[textIndex] = schema.text(replacement, firstText.marks);
  else paragraphChildren.splice(textIndex, 1);
  const updatedParagraph = nodeTypes.paragraph.create(
    firstParagraph!.attrs,
    paragraphChildren,
  );
  const updated = children.slice();
  updated[paragraphIndex] = updatedParagraph;
  return { checked, children: updated };
}

function parseList(
  tokens: MarkdownToken[],
  openIndex: number,
  closeIndex: number,
  ordered: boolean,
  source?: string,
  offsets?: number[],
  profile: Profile = "github",
  footnotes?: Map<string, FootnoteDefinition>,
): PMNode {
  const items: PMNode[] = [];
  let index = openIndex + 1;
  while (index < closeIndex) {
    const token = tokens[index]!;
    if (token.type !== "list_item_open") {
      index += 1;
      continue;
    }
    const itemClose = findClosing(tokens, index, "list_item_open", closeIndex);
    const children = parseBlocks(
      tokens,
      index + 1,
      itemClose,
      source,
      offsets,
      profile,
      footnotes,
    );
    const content = children.length > 0 ? children : [emptyParagraph()];
    const task = taskInfo(content, profile);
    items.push(
      nodeTypes.list_item.create({ checked: task.checked }, task.children),
    );
    index = itemClose + 1;
  }
  if (ordered) {
    const attrs = attrsOf(tokens[openIndex]!);
    const order = Number.parseInt(attrs.start ?? "1", 10);
    return nodeTypes.ordered_list.create(
      { order: Number.isFinite(order) ? order : 1 },
      items,
    );
  }
  return nodeTypes.bullet_list.create(null, items);
}

function cellAlignment(token: MarkdownToken): string | null {
  const attrs = attrsOf(token);
  const align =
    attrs.align ??
    attrs.style?.match(/text-align\s*:\s*(left|center|right)/i)?.[1];
  if (!align) return null;
  const normalized = align.toLowerCase();
  return normalized === "left" ||
    normalized === "center" ||
    normalized === "right"
    ? normalized
    : null;
}

function parseTable(
  tokens: MarkdownToken[],
  openIndex: number,
  closeIndex: number,
  profile: Profile = "github",
  footnotes?: Map<string, FootnoteDefinition>,
): PMNode {
  const rows: Array<{ header: boolean; cells: PMNode[] }> = [];
  let section: "head" | "body" = "body";
  let index = openIndex + 1;
  while (index < closeIndex) {
    const token = tokens[index]!;
    if (token.type === "thead_open") {
      section = "head";
      index += 1;
    } else if (token.type === "tbody_open") {
      section = "body";
      index += 1;
    } else if (token.type === "tr_open") {
      const rowClose = findClosing(tokens, index, "tr_open", closeIndex);
      const cells: PMNode[] = [];
      let cellIndex = index + 1;
      while (cellIndex < rowClose) {
        const cellToken = tokens[cellIndex]!;
        if (cellToken.type === "th_open" || cellToken.type === "td_open") {
          const cellClose = findClosing(
            tokens,
            cellIndex,
            cellToken.type,
            rowClose,
          );
          const inline = tokens
            .slice(cellIndex + 1, cellClose)
            .find((entry) => entry.type === "inline");
          const paragraph = paragraphFromInline(inline, profile, footnotes);
          const attrs = {
            colspan: 1,
            rowspan: 1,
            colwidth: null,
            alignment: cellAlignment(cellToken),
          };
          const type =
            section === "head" || cellToken.type === "th_open"
              ? "table_header"
              : "table_cell";
          cells.push(nodeTypes[type].create(attrs, paragraph));
          cellIndex = cellClose + 1;
        } else cellIndex += 1;
      }
      rows.push({ header: section === "head", cells });
      index = rowClose + 1;
    } else index += 1;
  }
  if (rows.length === 0) {
    const cell = nodeTypes.table_header.create(
      { colspan: 1, rowspan: 1, colwidth: null, alignment: null },
      emptyParagraph(),
    );
    rows.push({ header: true, cells: [cell] });
  }
  const width = Math.max(1, ...rows.map((row) => row.cells.length));
  for (const row of rows) {
    while (row.cells.length < width) {
      const type = row.header ? "table_header" : "table_cell";
      row.cells.push(
        nodeTypes[type].create(
          { colspan: 1, rowspan: 1, colwidth: null, alignment: null },
          emptyParagraph(),
        ),
      );
    }
  }
  const rowNodes = rows.map((row) =>
    nodeTypes.table_row.create(null, row.cells),
  );
  return nodeTypes.table.create(null, rowNodes);
}

function sourceForToken(
  token: MarkdownToken,
  source: string,
  offsets: number[],
): string {
  const location = tokenLocation(token, source, offsets);
  return source.slice(location.start, location.end);
}

function protectedFence(
  token: MarkdownToken,
  source: string,
  offsets: number[],
): boolean {
  const info = token.info?.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  if (isMathFenceLanguage(token.info ?? "")) return true;
  if (
    /^(?:mermaid|mdx|frontmatter|yaml|geojson|topojson|stl|plantuml|kroki|blockdiag|graphviz)$/.test(
      info,
    )
  )
    return true;
  const raw = sourceForToken(token, source, offsets).trimStart();
  const rawInfo = raw.match(/^(?:`{3,}|~{3,})[ \t]*([^\r\n]*)/)?.[1] ?? "";
  return (
    isMathFenceLanguage(rawInfo) ||
    /^```+\s*mermaid\b/i.test(raw) ||
    /^~~~+\s*mermaid\b/i.test(raw)
  );
}

function protectedBlockText(raw: string): boolean {
  const trimmed = raw.trimStart();
  return (
    /^:::[A-Za-z]/.test(trimmed) ||
    /^>\s*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/im.test(raw)
  );
}

function isMathBlockSource(raw: string): boolean {
  const trimmed = raw.trim();
  // A backslash escaped bracket is ordinary Markdown text in the common
  // profile. Display math is recognized here through the portable $$ form;
  // language-tagged math fences are handled by protectedFence separately.
  return /^\$\$[\s\S]*\$\$$/.test(trimmed);
}

function parseBlocks(
  tokens: MarkdownToken[],
  begin: number,
  end: number,
  source = "",
  offsets: number[] = [],
  profile: Profile = "github",
  footnotes?: Map<string, FootnoteDefinition>,
): PMNode[] {
  const result: PMNode[] = [];
  let index = begin;
  while (index < end) {
    const token = tokens[index]!;
    switch (token.type) {
      case "paragraph_open": {
        const close = findClosing(tokens, index, "paragraph_open", end);
        const inline = tokens
          .slice(index + 1, close)
          .find((entry) => entry.type === "inline");
        result.push(paragraphFromInline(inline, profile, footnotes));
        index = close + 1;
        break;
      }
      case "heading_open": {
        const close = findClosing(tokens, index, "heading_open", end);
        const inline = tokens
          .slice(index + 1, close)
          .find((entry) => entry.type === "inline");
        const level = Math.max(
          1,
          Math.min(6, Number.parseInt((token.tag ?? "h1").slice(1), 10) || 1),
        );
        const content = parseInline(inline?.children, profile, footnotes);
        result.push(nodeTypes.heading.create({ level }, content));
        index = close + 1;
        break;
      }
      case "blockquote_open": {
        const close = findClosing(tokens, index, "blockquote_open", end);
        result.push(
          nodeTypes.blockquote.create(
            null,
            parseBlocks(
              tokens,
              index + 1,
              close,
              source,
              offsets,
              profile,
              footnotes,
            ),
          ),
        );
        index = close + 1;
        break;
      }
      case "bullet_list_open": {
        const close = findClosing(tokens, index, "bullet_list_open", end);
        result.push(
          parseList(
            tokens,
            index,
            close,
            false,
            source,
            offsets,
            profile,
            footnotes,
          ),
        );
        index = close + 1;
        break;
      }
      case "ordered_list_open": {
        const close = findClosing(tokens, index, "ordered_list_open", end);
        result.push(
          parseList(
            tokens,
            index,
            close,
            true,
            source,
            offsets,
            profile,
            footnotes,
          ),
        );
        index = close + 1;
        break;
      }
      case "table_open": {
        const close = findClosing(tokens, index, "table_open", end);
        result.push(parseTable(tokens, index, close, profile, footnotes));
        index = close + 1;
        break;
      }
      case "hr":
        result.push(nodeTypes.horizontal_rule.create({ source: null }));
        index += 1;
        break;
      case "code_block": {
        // Markdown-it includes the line ending after the final indented code
        // line in token.content. The editor stores code without that
        // structural terminator, matching fenced blocks below; the
        // serializer adds it back before the closing fence.
        const content = literalTokenText(token)
          .replace(/\r\n|\r/g, "\n")
          .replace(/\n$/, "");
        result.push(
          nodeTypes.code_block.create(
            { params: "" },
            content ? schema.text(content) : Fragment.empty,
          ),
        );
        index += 1;
        break;
      }
      case "fence": {
        const rawSource = sourceForToken(token, source, offsets);
        if (protectedFence(token, source, offsets)) {
          const info = token.info?.trim().split(/\s+/, 1)[0] ?? "";
          const kind = isMathFenceLanguage(info)
            ? "math-block"
            : "protected-fence";
          result.push(
            nodeTypes.raw_block.create({
              source: rawSource || tokenText(token),
              kind,
            }),
          );
        } else {
          const params = token.info?.trim() ?? "";
          const content = literalTokenText(token)
            .replace(/\r\n|\r/g, "\n")
            .replace(/\n$/, "");
          result.push(
            nodeTypes.code_block.create(
              { params },
              content ? schema.text(content) : Fragment.empty,
            ),
          );
        }
        index += 1;
        break;
      }
      case "math_block":
        result.push(
          nodeTypes.raw_block.create({
            source: sourceForToken(token, source, offsets),
            kind: "math-block",
          }),
        );
        index += 1;
        break;
      case "html_block":
        result.push(
          nodeTypes.raw_block.create({
            source: tokenText(token),
            kind: "html",
          }),
        );
        index += 1;
        break;
      default:
        if (token.nesting === -1 || token.type.endsWith("_close")) {
          index += 1;
          break;
        }
        // Preserve an unrecognised block token as an atom whenever possible.
        result.push(
          nodeTypes.raw_block.create({
            source: tokenText(token),
            kind: token.type || "unknown",
          }),
        );
        index += 1;
        break;
    }
  }
  return result;
}

function isRootStart(token: MarkdownToken): boolean {
  if ((token.level ?? 0) !== 0) return false;
  if (token.nesting === -1 || token.type.endsWith("_close")) return false;
  return token.nesting === 1 || token.nesting === 0;
}

function detectFrontmatter(
  source: string,
): { start: number; end: number } | null {
  const match = source.match(
    /^(?:\uFEFF)?---(?:\r\n|\n|\r)([\s\S]*?)(?:\r\n|\n|\r)(?:---|\.\.\.)(?:(?:\r\n|\n|\r)|$)/,
  );
  if (!match || match.index !== 0) return null;
  return { start: 0, end: match[0].length };
}

interface SourceLine {
  start: number;
  end: number;
  breakEnd: number;
  text: string;
}

function sourceLines(source: string): SourceLine[] {
  const result: SourceLine[] = [];
  let start = 0;
  for (let index = 0; index <= source.length; index += 1) {
    if (
      index === source.length ||
      source[index] === "\n" ||
      source[index] === "\r"
    ) {
      const breakEnd =
        index < source.length &&
        source[index] === "\r" &&
        source[index + 1] === "\n"
          ? index + 2
          : index < source.length
            ? index + 1
            : index;
      result.push({
        start,
        end: index,
        breakEnd,
        text: source.slice(start, index),
      });
      start = breakEnd;
      if (index === source.length) break;
      if (breakEnd === source.length) break;
      if (breakEnd > index + 1) index += 1;
    }
  }
  return result;
}

function maskRanges(
  source: string,
  ranges: Array<{ start: number; end: number }>,
): string {
  if (ranges.length === 0) return source;
  const chars = source.split("");
  for (const range of ranges) {
    const start = Math.max(0, Math.min(source.length, range.start));
    const end = Math.max(start, Math.min(source.length, range.end));
    for (let index = start; index < end; index += 1) {
      if (chars[index] !== "\n" && chars[index] !== "\r") chars[index] = " ";
    }
  }
  return chars.join("");
}

interface FootnoteScan {
  definitions: FootnoteDefinition[];
  ranges: Array<{ start: number; end: number }>;
  byLabel: Map<string, FootnoteDefinition>;
}

function scanFootnotes(source: string): FootnoteScan {
  const lines = sourceLines(source);
  const definitions: FootnoteDefinition[] = [];
  const ranges: Array<{ start: number; end: number }> = [];
  const byLabel = new Map<string, FootnoteDefinition>();
  let fence: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fenceMatch = line.text.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length)
        fence = null;
      continue;
    }
    if (fence) continue;
    const match = line.text.match(/^ {0,3}\[\^([^\]\r\n]+)\]:[ \t]*(.*)$/);
    if (!match) continue;
    const firstBody = match[2] ?? "";
    const bodyLines = [firstBody];
    let last = index;
    for (
      let continuation = index + 1;
      continuation < lines.length;
      continuation += 1
    ) {
      const next = lines[continuation]!;
      if (/^[ \t]{2,}/.test(next.text)) {
        bodyLines.push(next.text.replace(/^[ \t]{1,4}/, ""));
        last = continuation;
        continue;
      }
      break;
    }
    const sourceEnd = lines[last]!.end;
    const sourceValue = source.slice(line.start, sourceEnd);
    const sourceLabel = match[1]!;
    const definition: FootnoteDefinition = {
      label: referenceLabel(sourceLabel),
      sourceLabel,
      content: bodyLines.join("\n"),
      source: sourceValue,
      start: line.start,
      end: sourceEnd,
    };
    definitions.push(definition);
    if (!byLabel.has(definition.label))
      byLabel.set(definition.label, definition);
    ranges.push({ start: line.start, end: sourceEnd });
    index = last;
  }
  return { definitions, ranges, byLabel };
}

const documentMetadata = new WeakMap<
  PMNode,
  {
    footnotes: FootnoteDefinition[];
    source?: string;
    lineEnding?: MarkdownSnapshot["lineEnding"];
    sourcePreservedNoOp?: boolean;
  }
>();

/**
 * Rendering and compatibility inspection commonly consume the same source in
 * one turn. Keep only the most recent parse so those adjacent calls can share
 * the immutable snapshot without retaining documents across the application.
 */
let latestParse:
  { source: string; profile: Profile; snapshot: MarkdownSnapshot } | undefined;

interface DetailsRange {
  start: number;
  end: number;
}

interface DetectedDetails extends DetailsRange {
  tags: DetailsTagRange[];
}

function detailsFenceRanges(source: string): DetailsRange[] {
  const lines = sourceLines(source);
  const ranges: DetailsRange[] = [];
  let fence: string | null = null;
  let fenceStart = 0;
  for (const line of lines) {
    const fenceMatch = line.text.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!fenceMatch) continue;
    const marker = fenceMatch[1]!;
    if (!fence) {
      fence = marker;
      fenceStart = line.start;
    } else if (marker[0] === fence[0] && marker.length >= fence.length) {
      ranges.push({ start: fenceStart, end: line.breakEnd });
      fence = null;
    }
  }
  if (fence) ranges.push({ start: fenceStart, end: source.length });
  return ranges;
}

function detectDetails(source: string, parser: MarkdownIt): DetectedDetails[] {
  const ranges: DetectedDetails[] = [];
  const stack: number[] = [];
  const tags = detailsTagRanges(source, parser);
  let firstTag = 0;
  for (let tagIndex = 0; tagIndex < tags.length; tagIndex += 1) {
    const tag = tags[tagIndex]!;
    const offset = tag.start;
    const lineStart =
      Math.max(
        source.lastIndexOf("\n", offset),
        source.lastIndexOf("\r", offset),
      ) + 1;
    const prefix = source.slice(lineStart, offset);
    if (!tag.closing && stack.length === 0 && prefix.trim() !== "") continue;
    if (tag.closing) {
      if (stack.length === 0) continue;
      const start = stack.pop()!;
      if (stack.length === 0) {
        let end = tag.end;
        end += source.slice(end).match(/^(?:\r\n|\n|\r)/)?.[0].length ?? 0;
        ranges.push({
          start,
          end,
          tags: tags.slice(firstTag, tagIndex + 1).map((candidate) => ({
            start: candidate.start - start,
            end: candidate.end - start,
            closing: candidate.closing,
          })),
        });
      }
    } else {
      if (stack.length === 0) firstTag = tagIndex;
      stack.push(offset);
    }
  }
  return ranges.sort((left, right) => left.start - right.start);
}

function lineIndexAt(source: string, offset: number): number {
  let line = 0;
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source[index] === "\n") line += 1;
    else if (source[index] === "\r") {
      if (source[index + 1] === "\n") index += 1;
      line += 1;
    }
  }
  return line;
}

function isGitlabDescriptionList(value: string): boolean {
  const lines = value
    .replace(/(?:\r\n|\r)/g, "\n")
    .trim()
    .split("\n");
  if (lines.length < 2) return false;
  let hasDefinition = false;
  for (let index = 1; index < lines.length; index += 1) {
    if (/^\s*:\s+/.test(lines[index]!)) hasDefinition = true;
    else if (lines[index]!.trim() !== "") return false;
  }
  return hasDefinition;
}

function isFootnoteDefinitionBlock(value: string): boolean {
  const lines = value.replace(/(?:\r\n|\r)/g, "\n").split("\n");
  const meaningful = lines.filter((line) => line.trim() !== "");
  if (meaningful.length === 0) return false;
  let hasDefinition = false;
  for (const line of meaningful) {
    if (/^ {0,3}\[\^([^\]\r\n]+)\]:/.test(line)) {
      hasDefinition = true;
      continue;
    }
    if (/^[ \t]{2,}/.test(line)) continue;
    return false;
  }
  return hasDefinition;
}

function parseInternal(
  source: string,
  profile: Profile,
  materializeBlankParagraphs = true,
  leadingStructuralLineEndings = 0,
): MarkdownSnapshot {
  const footnoteScan = scanFootnotes(source);
  const md = createMarkdownIt(profile);
  const details = detectDetails(source, md);
  // Keep footnote definition lines visible to markdown-it so its reference
  // tokens can be converted to source-preserving footnote atoms. The parser
  // already treats ordinary definition lines as non-rendering; only details
  // need masking to prevent their interior from becoming separate blocks.
  const maskedSource = maskRanges(source, details);
  const parserSource = maskEscapedDollars(maskedSource);
  const tokens = md.parse(parserSource, {}) as unknown as MarkdownToken[];
  const offsets = lineOffsets(parserSource);
  const roots = tokens
    .map((token, index) => (isRootStart(token) ? index : -1))
    .filter((index) => index >= 0);
  const events: Array<{
    tokenIndex?: number;
    token?: MarkdownToken;
    start: number;
    detail?: DetectedDetails;
  }> = roots.map((tokenIndex) => {
    const token = tokens[tokenIndex]!;
    return {
      tokenIndex,
      token,
      start: tokenLocation(token, maskedSource, offsets).start,
    };
  });
  for (const detail of details) events.push({ start: detail.start, detail });
  events.sort((left, right) => left.start - right.start);

  const parsedBlocks: Array<{
    node: PMNode;
    block: MarkdownBlockSnapshot;
    startOffset: number;
    sourceEndOffset: number;
  }> = [];
  const footnoteMap = footnoteScan.byLabel;
  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex]!;
    const nextEvent = events[eventIndex + 1];
    const nextStart = nextEvent?.start ?? source.length;
    if (event.detail) {
      const detail = event.detail;
      const body = source.slice(detail.start, detail.end);
      const separator = source.slice(detail.end, nextStart);
      const parts = cachedDetailsParts(body, profile, detail.tags, md);
      const node = parts
        ? nodeTypes.details.create(
            {
              source: body,
              summarySource: parts.summary,
              sourceProfile: profile,
            },
            detailsBodySnapshot(parts.body, profile).doc.content,
          )
        : nodeTypes.raw_block.create({ source: body, kind: "details" });
      if (parts) detailsPartsByAttrs.set(node.attrs, parts);
      parsedBlocks.push({
        node,
        block: {
          node,
          source: body + separator,
          body,
          separator,
          startLine: lineIndexAt(source, detail.start),
          endLine:
            lineIndexAt(source, Math.max(detail.start, detail.end - 1)) + 1,
          kind: "details",
        },
        startOffset: detail.start,
        sourceEndOffset: nextStart,
      });
      continue;
    }
    const token = event.token!;
    const tokenIndex = event.tokenIndex!;
    const location = tokenLocation(token, maskedSource, offsets);
    const bodyEnd = Math.max(location.start, Math.min(location.end, nextStart));
    const body = source.slice(location.start, bodyEnd);
    const separator = source.slice(bodyEnd, nextStart);
    let nextTokenIndex: number | undefined;
    for (
      let candidate = eventIndex + 1;
      candidate < events.length;
      candidate += 1
    ) {
      if (events[candidate]!.tokenIndex != null) {
        nextTokenIndex = events[candidate]!.tokenIndex;
        break;
      }
    }
    const parsed = parseBlocks(
      tokens,
      tokenIndex,
      nextTokenIndex ?? tokens.length,
      source,
      offsets,
      profile,
      footnoteMap,
    );
    let node =
      parsed[0] ??
      nodeTypes.raw_block.create({ source: body, kind: "unknown" });
    const fullRaw = source.slice(location.start, nextStart);
    const bodyForDetection = fullRaw.replace(/(?:\r\n|\r|\n)+$/, "");
    if (
      profile !== "commonmark" &&
      node.type.name === "blockquote" &&
      protectedBlockText(fullRaw)
    ) {
      node = nodeTypes.raw_block.create({ source: fullRaw, kind: "alert" });
    } else if (
      profile === "gitlab" &&
      node.type.name === "paragraph" &&
      bodyForDetection.trim() === "[[_TOC_]]"
    ) {
      node = nodeTypes.raw_block.create({
        source: fullRaw,
        kind: "gitlab-toc",
      });
    } else if (
      profile === "gitlab" &&
      node.type.name === "paragraph" &&
      isGitlabDescriptionList(bodyForDetection)
    ) {
      node = nodeTypes.raw_block.create({
        source: fullRaw,
        kind: "gitlab-description-list",
      });
    } else if (node.type.name === "paragraph" && isMathBlockSource(fullRaw)) {
      node = nodeTypes.raw_block.create({
        source: fullRaw,
        kind: "math-block",
      });
    } else if (node.type.name === "paragraph" && protectedBlockText(fullRaw)) {
      node = nodeTypes.raw_block.create({
        source: fullRaw,
        kind: "directive",
      });
    }
    // A contiguous footnote-definition paragraph is source metadata, not
    // editable prose. Its exact slice remains in the neighbouring separator
    // and the structured definition list on the snapshot.
    if (isFootnoteDefinitionBlock(bodyForDetection)) continue;
    parsedBlocks.push({
      node,
      block: {
        node,
        source: body + separator,
        body,
        separator,
        startLine: location.startLine,
        endLine: location.endLine,
        kind: node.type.name,
      },
      startOffset: location.start,
      sourceEndOffset: nextStart,
    });
  }
  if (
    parsedBlocks.length === 0 &&
    source.trim().length > 0 &&
    footnoteScan.definitions.length === 0
  ) {
    const raw = nodeTypes.raw_block.create({ source, kind: "unparsed" });
    parsedBlocks.push({
      node: raw,
      block: {
        node: raw,
        source,
        body: source,
        separator: "",
        startLine: 0,
        endLine: offsets.length,
        kind: "unparsed",
      },
      startOffset: 0,
      sourceEndOffset: source.length,
    });
  }
  const nodes: PMNode[] = [];
  const blocks: MarkdownBlockSnapshot[] = [];
  let leading =
    parsedBlocks.length > 0
      ? source.slice(0, parsedBlocks[0]!.startOffset)
      : source;
  const appendMaterializedBlankBoundary = (
    parts: BlankBoundaryParts,
    startOffset: number,
  ): void => {
    let line = lineIndexAt(source, startOffset);
    for (const part of parts.empty) {
      const block = materializedEmptyBlock(part, line);
      nodes.push(block.node);
      blocks.push(block);
      line += lineEndingCount(part);
    }
    if (parts.overflow) {
      const block = materializedBlankSpacerBlock(parts.overflow, line);
      nodes.push(block.node);
      blocks.push(block);
    }
  };

  const blankOnly =
    parsedBlocks.length === 0 &&
    materializeBlankParagraphs &&
    isLineEndingOnlySource(source) &&
    lineEndingCount(source) > 0;
  if (blankOnly) {
    const parts = splitBlankBoundary(source, leadingStructuralLineEndings);
    appendMaterializedBlankBoundary(parts, parts.structural.length);
    leading = parts.structural;
  }

  if (parsedBlocks.length > 0 && materializeBlankParagraphs) {
    const leadingCount = materializedEmptyCount(
      leading,
      leadingStructuralLineEndings,
    );
    if (leadingCount > 0) {
      const parts = splitBlankBoundary(leading, leadingStructuralLineEndings);
      appendMaterializedBlankBoundary(parts, parts.structural.length);
      leading = parts.structural;
    }

    for (let index = 0; index < parsedBlocks.length; index += 1) {
      const parsedBlock = parsedBlocks[index]!;
      const nextBlock = parsedBlocks[index + 1];
      const hasAdjacentNext =
        nextBlock != null &&
        parsedBlock.sourceEndOffset === nextBlock.startOffset;
      const isTrailing =
        nextBlock == null && parsedBlock.sourceEndOffset === source.length;
      const structuralLineEndings = hasAdjacentNext ? 2 : isTrailing ? 1 : 0;
      const bodySuffix = lineBreakSuffix(parsedBlock.block.body);
      const boundary = bodySuffix + parsedBlock.block.separator;
      const emptyCount =
        structuralLineEndings > 0
          ? materializedEmptyCount(boundary, structuralLineEndings)
          : 0;
      if (emptyCount > 0) {
        const parts = splitBlankBoundary(boundary, structuralLineEndings);
        const firstPart = parts.structural;
        const firstSeparator = firstPart.slice(bodySuffix.length);
        const block = {
          ...parsedBlock.block,
          source: parsedBlock.block.body + firstSeparator,
          separator: firstSeparator,
        };
        nodes.push(parsedBlock.node);
        blocks.push(block);
        const boundaryStart =
          parsedBlock.startOffset +
          parsedBlock.block.body.length -
          bodySuffix.length;
        appendMaterializedBlankBoundary(
          parts,
          boundaryStart + firstPart.length,
        );
      } else {
        nodes.push(parsedBlock.node);
        blocks.push(parsedBlock.block);
      }
    }
  } else {
    for (const parsedBlock of parsedBlocks) {
      nodes.push(parsedBlock.node);
      blocks.push(parsedBlock.block);
    }
  }
  const doc = schema.topNodeType.create(
    null,
    nodes.length > 0 ? nodes : [emptyParagraph()],
  );
  const lineEnding = markdownLineEnding(source);
  documentMetadata.set(doc, {
    footnotes: footnoteScan.definitions,
    source,
    lineEnding,
    sourcePreservedNoOp: blocks.some(
      (block) =>
        block.kind === "empty-paragraph" || block.kind === "blank-spacer",
    ),
  });
  const last = parsedBlocks[parsedBlocks.length - 1]?.block;
  const trailing = last
    ? source.slice(
        last.startLine == null
          ? source.length
          : offsetForLine(offsets, last.endLine, source.length),
      )
    : nodes.length > 0
      ? ""
      : source;
  return {
    doc,
    source,
    profile,
    blocks,
    leading,
    trailing,
    lineEnding,
    footnotes: footnoteScan.definitions,
  };
}

/** Parse Markdown into the shared ProseMirror document model. */
export function parseMarkdown(
  source: string,
  profile: Profile = "github",
): MarkdownSnapshot {
  if (latestParse?.source === source && latestParse.profile === profile)
    return latestParse.snapshot;

  const frontmatter = detectFrontmatter(source);
  if (!frontmatter) {
    const snapshot = parseInternal(source, profile);
    latestParse = { source, profile, snapshot };
    return snapshot;
  }

  const frontSource = source.slice(frontmatter.start, frontmatter.end);
  const restSource = source.slice(frontmatter.end);
  const rest = parseInternal(restSource, profile, true, 1);
  const front = nodeTypes.raw_block.create({
    source: frontSource,
    kind: "frontmatter",
  });
  const children = [front, ...childrenOf(rest.doc)];
  const doc = schema.topNodeType.create(null, children);
  const restBlocks = (rest.blocks ?? []).map((block) => ({ ...block }));
  const blocks: MarkdownBlockSnapshot[] = [
    {
      node: front,
      source: frontSource + (rest.leading ?? ""),
      body: frontSource,
      separator: rest.leading ?? "",
      startLine: 0,
      endLine: source.slice(0, frontmatter.end).split(/\r\n|\n|\r/).length - 1,
      kind: "frontmatter",
    },
    ...restBlocks,
  ];
  const snapshot: MarkdownSnapshot = {
    ...rest,
    doc,
    source,
    blocks,
    leading: "",
    trailing: rest.trailing ?? "",
    lineEnding: markdownLineEnding(source),
    footnotes: rest.footnotes ?? [],
    profile,
  };
  documentMetadata.set(doc, {
    footnotes: snapshot.footnotes ?? [],
    source,
    lineEnding: snapshot.lineEnding,
    sourcePreservedNoOp: blocks.some(
      (block) =>
        block.kind === "empty-paragraph" || block.kind === "blank-spacer",
    ),
  });
  latestParse = { source, profile, snapshot };
  return snapshot;
}

function escapeMarkdownText(
  value: string,
  table = false,
  initialLineStart = true,
): string {
  let result = value.replace(/\\/g, "\\\\");
  let escaped = "";
  // Escape punctuation that can change a paragraph's block shape when a
  // user inserts it at the beginning of a line (headings, lists, quotes,
  // thematic breaks, directives, and setext headings). Escaping is valid in
  // all inline contexts and keeps parse(serialize(doc)) structurally stable.
  const markdownPunctuation = "`*_[]<>#-+.!~$:=&()";
  let lineStart = initialLineStart;
  for (const character of result) {
    if (lineStart && character === " ") {
      // Three leading spaces are indentation in Markdown. Numeric entities
      // retain the actual ASCII space in the PM document without creating a
      // code block or being trimmed by the block parser.
      escaped += "&#32;";
      continue;
    }
    if (lineStart && character === "\t") {
      escaped += "&#9;";
      continue;
    }
    escaped += markdownPunctuation.includes(character)
      ? `\\${character}`
      : character;
    lineStart = character === "\n";
  }
  result = escaped;
  if (table) result = result.replace(/\|/g, "\\|");
  return result.replace(/\n/g, "\n");
}

function serializeCodeSpan(value: string, table = false): string {
  const content = value.replace(/\r\n|\r|\n/g, " ");
  const fence = codeFenceFor(content, "`");
  const protectedContent = table ? content.replace(/\|/g, "\\|") : content;
  if (fence === "`" && !/^\s|\s$|`/.test(content))
    return `\`${protectedContent}\``;
  return `${fence} ${protectedContent} ${fence}`;
}

function escapeLinkDestination(value: unknown, table = false): string {
  // Link destinations are a small, hostile input boundary.  Remove control
  // line breaks before they can terminate a Markdown construct, then use an
  // angle destination for whitespace and balanced punctuation.  Markdown-it
  // percent-encodes spaces and pipes in that form, which is the portable
  // representation accepted by both the VS Code and dedicated renderers.
  const destination = stripUrlControls(
    String(value ?? "").replace(/\r\n|\r|\n/g, " "),
  );
  const compact = destination;
  if (/\s|[()<>]/.test(compact)) {
    let angle = compact.replace(/[<>]/g, "");
    if (table) {
      angle = angle.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
    }
    return `<${angle}>`;
  }
  let escaped = compact.replace(/[\\()]/g, "\\$&");
  if (table) escaped = escaped.replace(/\|/g, "\\|");
  return escaped;
}

function serializeImageAlt(value: unknown, table = false): string {
  const source = String(value ?? "");
  if (!table) return source.replace(/[[\]]/g, "\\$&");
  // Image token content retains literal backslashes. Keep them byte-stable
  // and add one table escape to every pipe, including one after a backslash.
  const normalized = source.replace(/\r\n|\r|\n/g, " ");
  return normalized.replace(/[[\]]/g, "\\$&").replace(/\|/g, "\\|");
}

function serializeInlineTitle(value: unknown, table = false): string {
  const source = String(value ?? "");
  if (!table) return source.replace(/"/g, '\\"');
  // Titles are semantic attributes, so escape their backslashes before
  // protecting table pipes rather than treating existing escapes as source.
  return source
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\|/g, "\\|");
}

function firstCodePoint(value: string): string | undefined {
  return Array.from(value)[0];
}

function lastCodePoint(value: string): string | undefined {
  return Array.from(value).at(-1);
}

function isMarkdownUnicodeWhitespace(value: string | undefined): boolean {
  return value === undefined || /^[\p{Zs}\t\n\f\r]$/u.test(value);
}

function isMarkdownUnicodePunctuation(value: string | undefined): boolean {
  return value !== undefined && /^[\p{P}\p{S}]$/u.test(value);
}

function isFlankingDelimiterMark(mark: Mark): boolean {
  return (
    mark.type.name === "strong" ||
    mark.type.name === "em" ||
    mark.type.name === "strike"
  );
}

function inlineMarkTag(
  mark: Mark,
): { opening: string; closing: string } | undefined {
  switch (mark.type.name) {
    case "strong":
      return { opening: "<strong>", closing: "</strong>" };
    case "em":
      return { opening: "<em>", closing: "</em>" };
    case "strike":
      return { opening: "<del>", closing: "</del>" };
    default:
      return undefined;
  }
}

// A delimiter run cannot represent a mark when its marked punctuation touches
// an alphanumeric neighbour. Safe inline HTML is already supported by every
// profile and preserves that mark without dropping or synthesizing text.
function serializeInlineMarkFallback(
  value: string,
  marks: readonly Mark[],
  code: boolean,
  table: boolean,
): string {
  let output = code
    ? `<code>${escapeMarkdownText(value, table, false)}</code>`
    : escapeMarkdownText(value, table, false);
  for (let index = marks.length - 1; index >= 0; index -= 1) {
    const tag = inlineMarkTag(marks[index]!);
    if (!tag) continue;
    output = `${tag.opening}${output}${tag.closing}`;
  }
  return output;
}

function containsMarkdownUnicodePunctuation(value: string): boolean {
  return Array.from(value).some((character) =>
    isMarkdownUnicodePunctuation(character),
  );
}

function delimiterCanOpen(
  before: string | undefined,
  after: string | undefined,
): boolean {
  const afterWhitespace = isMarkdownUnicodeWhitespace(after);
  const afterPunctuation = isMarkdownUnicodePunctuation(after);
  return (
    !afterWhitespace &&
    (!afterPunctuation ||
      isMarkdownUnicodeWhitespace(before) ||
      isMarkdownUnicodePunctuation(before))
  );
}

function delimiterCanClose(
  before: string | undefined,
  after: string | undefined,
): boolean {
  const beforeWhitespace = isMarkdownUnicodeWhitespace(before);
  const beforePunctuation = isMarkdownUnicodePunctuation(before);
  return (
    !beforeWhitespace &&
    (!beforePunctuation ||
      isMarkdownUnicodeWhitespace(after) ||
      isMarkdownUnicodePunctuation(after))
  );
}

function trimLeadingDelimiterBoundary(
  value: string,
  before: string | undefined,
): { prefix: string; rest: string } {
  // A Markdown delimiter cannot open immediately before whitespace or before
  // punctuation that follows an alphanumeric character. Move only the
  // offending source characters out of the mark; never delete or synthesize
  // content just to make the delimiter look valid.
  const codePoints = Array.from(value);
  let offset = 0;
  let preceding = before;
  while (offset < codePoints.length) {
    const character = codePoints[offset];
    if (!character || delimiterCanOpen(preceding, character)) break;
    offset += 1;
    preceding = character;
  }
  return {
    prefix: codePoints.slice(0, offset).join(""),
    rest: codePoints.slice(offset).join(""),
  };
}

function trimTrailingDelimiterBoundary(
  value: string,
  after: string | undefined,
): { body: string; suffix: string } {
  const codePoints = Array.from(value);
  let end = codePoints.length;
  let following = after;
  while (end > 0) {
    const character = codePoints[end - 1];
    if (!character || delimiterCanClose(character, following)) break;
    end -= 1;
    following = character;
  }
  return {
    body: codePoints.slice(0, end).join(""),
    suffix: codePoints.slice(end).join(""),
  };
}

function serializeInlineMarked(
  node: PMNode,
  table: boolean,
  ignoredLink?: Mark,
  baseMarks: readonly Mark[] = [],
  initialLineStart = true,
): string {
  const children = childrenOf(node);
  let output = "";
  let lineStart = initialLineStart;
  let active: Mark[] = [...baseMarks];
  const delimiter = (mark: Mark): string => {
    if (mark.type.name === "strong") return "**";
    if (mark.type.name === "em") return "*";
    if (mark.type.name === "strike") return "~~";
    return "";
  };
  const nonLinkMarks = (child: PMNode): Mark[] =>
    child.marks.filter(
      (mark) => mark.type.name !== "code" && mark.type.name !== "link",
    );
  const regularMarks = (child: PMNode): Mark[] => {
    const marks = nonLinkMarks(child);
    if (active.length === 0) return marks;
    // Keep marks that are already open in their current nesting order, then
    // append marks newly introduced by this text run. This preserves both
    // `*outer **inner** outer*` and `**outer *inner* outer**` shapes.
    const retained = active.filter((open) =>
      marks.some((mark) => mark.eq(open)),
    );
    const added = marks.filter(
      (mark) => !retained.some((open) => open.eq(mark)),
    );
    return [...retained, ...added];
  };
  const boundaryCharacter = (
    child: PMNode | undefined,
    first: boolean,
  ): string | undefined => {
    if (!child) return undefined;
    const childLink = child.marks.find((mark) => mark.type.name === "link");
    if (childLink && !ignoredLink?.eq(childLink)) return first ? "[" : ")";
    if (child.isText) {
      if (child.marks.some((mark) => mark.type.name === "code")) return "`";
      return first
        ? firstCodePoint(child.text ?? "")
        : lastCodePoint(child.text ?? "");
    }
    if (child.type.name === "hard_break") return first ? "<" : ">";
    if (child.type.name === "image") return first ? "!" : ")";
    if (child.type.name === "raw_inline") {
      const source = String(child.attrs.source ?? "");
      return first ? firstCodePoint(source) : lastCodePoint(source);
    }
    return first
      ? firstCodePoint(child.textContent)
      : lastCodePoint(child.textContent);
  };
  const marksAtBoundary = (index: number): Mark[] => {
    if (index >= children.length) return [...baseMarks];
    const child = children[index]!;
    const childLink = child.marks.find((mark) => mark.type.name === "link");
    if (!childLink || ignoredLink?.eq(childLink)) return nonLinkMarks(child);
    let end = index + 1;
    while (end < children.length) {
      const nextLink = children[end]!.marks.find(
        (mark) => mark.type.name === "link",
      );
      if (!nextLink || !nextLink.eq(childLink)) break;
      end += 1;
    }
    const group = children.slice(index, end).map(nonLinkMarks);
    const first = group[0] ?? [];
    return first.filter((mark) =>
      group.every((marks) => marks.some((entry) => entry.eq(mark))),
    );
  };
  const closeTo = (target: Mark[]): void => {
    let common = 0;
    while (
      common < active.length &&
      common < target.length &&
      active[common]!.eq(target[common]!)
    )
      common += 1;
    for (let index = active.length - 1; index >= common; index -= 1)
      output += delimiter(active[index]!);
    if (active.length !== common) lineStart = false;
    active = active.slice(0, common);
    for (let index = common; index < target.length; index += 1) {
      output += delimiter(target[index]!);
      if (delimiter(target[index]!)) lineStart = false;
      active.push(target[index]!);
    }
  };
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]!;
    const childLink = child.marks.find((mark) => mark.type.name === "link");
    if (childLink && !ignoredLink?.eq(childLink)) {
      let end = index + 1;
      while (end < children.length) {
        const nextLink = children[end]!.marks.find(
          (mark) => mark.type.name === "link",
        );
        if (!nextLink || !nextLink.eq(childLink)) break;
        end += 1;
      }
      const groupTargets = children
        .slice(index, end)
        .map((entry) => regularMarks(entry));
      const firstTarget = groupTargets[0] ?? [];
      const commonMarks = firstTarget.filter((mark) =>
        groupTargets.every((target) => target.some((entry) => entry.eq(mark))),
      );
      const beforeLink = boundaryCharacter(children[index - 1], false);
      const afterLink = boundaryCharacter(children[end], true);
      const surroundingMarks = commonMarks.filter(
        (mark) =>
          !isFlankingDelimiterMark(mark) ||
          (delimiterCanOpen(beforeLink, "[") &&
            delimiterCanClose(")", afterLink)),
      );
      closeTo(surroundingMarks);
      const inner = serializeInlineMarked(
        node.copy(Fragment.fromArray(children.slice(index, end))),
        table,
        childLink,
        surroundingMarks,
        lineStart,
      );
      const title = childLink.attrs.title
        ? ` "${serializeInlineTitle(childLink.attrs.title, table)}"`
        : "";
      output += `[${inner}](${escapeLinkDestination(childLink.attrs.href, table)}${title})`;
      lineStart = false;
      index = end - 1;
      continue;
    }
    if (child.isText) {
      const targetMarks = regularMarks(child);
      const code = child.marks.some((mark) => mark.type.name === "code");
      let value = child.text ?? "";
      // A newly opened mark cannot begin immediately before a softbreak: the
      // delimiter would land at the end of the previous line and Markdown-it
      // would treat it as literal text. Emit leading breaks first, then open
      // the mark on the following line.
      const leadingBreaks = value.match(/^\n+/)?.[0] ?? "";
      const marksChange =
        active.length !== targetMarks.length ||
        active.some((mark, index) => !mark.eq(targetMarks[index]!));
      if (leadingBreaks && marksChange) {
        closeTo([]);
        output += escapeMarkdownText(leadingBreaks, table, lineStart);
        lineStart = leadingBreaks.endsWith("\n");
        value = value.slice(leadingBreaks.length);
      }
      if (!value) {
        closeTo([]);
        continue;
      }
      const nextMarks = marksAtBoundary(index + 1);
      const before = leadingBreaks
        ? lastCodePoint(leadingBreaks)
        : boundaryCharacter(children[index - 1], false);
      const opensDelimiter = targetMarks.some(
        (mark) =>
          isFlankingDelimiterMark(mark) &&
          !active.some((open) => open.eq(mark)),
      );
      const originalValue = value;
      let prefix = "";
      let trailingSuffix = "";
      let useHtmlFallback = false;
      if (opensDelimiter && code) {
        useHtmlFallback = !delimiterCanOpen(before, "`");
      } else if (opensDelimiter) {
        const trimmed = trimLeadingDelimiterBoundary(value, before);
        if (trimmed.rest) {
          prefix = trimmed.prefix;
          value = trimmed.rest;
          useHtmlFallback = containsMarkdownUnicodePunctuation(prefix);
        } else {
          useHtmlFallback = true;
        }
      }
      if (!value) {
        continue;
      }
      const closesDelimiter = targetMarks.some(
        (mark) =>
          isFlankingDelimiterMark(mark) &&
          !nextMarks.some((next) => next.eq(mark)),
      );
      let body = value;
      if (closesDelimiter && code) {
        useHtmlFallback =
          useHtmlFallback ||
          !delimiterCanClose("`", boundaryCharacter(children[index + 1], true));
      } else if (closesDelimiter) {
        const trimmed = trimTrailingDelimiterBoundary(
          value,
          boundaryCharacter(children[index + 1], true),
        );
        body = trimmed.body;
        trailingSuffix = trimmed.suffix;
        useHtmlFallback =
          useHtmlFallback ||
          !body ||
          containsMarkdownUnicodePunctuation(trailingSuffix);
      }
      if (useHtmlFallback) {
        const fallbackMarks = targetMarks.filter(
          (mark) => !baseMarks.some((base) => base.eq(mark)),
        );
        closeTo([...baseMarks]);
        output += serializeInlineMarkFallback(
          originalValue,
          fallbackMarks,
          code,
          table,
        );
        lineStart = false;
        continue;
      }
      if (prefix) {
        const prefixMarks = active.filter((mark) =>
          targetMarks.some((target) => target.eq(mark)),
        );
        closeTo(prefixMarks);
        output += escapeMarkdownText(prefix, table, lineStart);
        lineStart = prefix.endsWith("\n");
      }
      const suffixMarks = targetMarks.filter((mark) =>
        nextMarks.some((next) => next.eq(mark)),
      );
      if (body) closeTo(targetMarks);
      else closeTo(suffixMarks);
      if (body) {
        let text = code
          ? serializeCodeSpan(body, table)
          : escapeMarkdownText(body, table, lineStart);
        const link = child.marks.find(
          (mark) => mark.type.name === "link" && !ignoredLink?.eq(mark),
        );
        if (link) {
          const title = link.attrs.title
            ? ` "${serializeInlineTitle(link.attrs.title, table)}"`
            : "";
          text = `[${text}](${escapeLinkDestination(link.attrs.href, table)}${title})`;
        }
        output += text;
        lineStart = body.endsWith("\n");
      }
      if (trailingSuffix) {
        closeTo(suffixMarks);
        output += escapeMarkdownText(trailingSuffix, table, lineStart);
        lineStart = trailingSuffix.endsWith("\n");
      }
    } else {
      if (child.type.name === "hard_break") {
        closeTo(regularMarks(child));
        output += "<br>";
        lineStart = false;
      } else if (child.type.name === "image") {
        closeTo(regularMarks(child));
        const alt = serializeImageAlt(child.attrs.alt, table);
        const title = child.attrs.title
          ? ` "${serializeInlineTitle(child.attrs.title, table)}"`
          : "";
        const width = safeImageDimension(child.attrs.width);
        const height = safeImageDimension(child.attrs.height);
        const dimensions =
          width || height
            ? `{${width ? `width=${width}` : ""}${width && height ? " " : ""}${height ? `height=${height}` : ""}}`
            : "";
        const image = `![${alt}](${escapeLinkDestination(child.attrs.src, table)}${title})${dimensions}`;
        const link = child.marks.find(
          (mark) => mark.type.name === "link" && !ignoredLink?.eq(mark),
        );
        output += link
          ? `[${image}](${escapeLinkDestination(link.attrs.href, table)}${link.attrs.title ? ` "${serializeInlineTitle(link.attrs.title, table)}"` : ""})`
          : image;
        lineStart = false;
      } else if (child.type.name === "raw_inline") {
        let raw = String(child.attrs.source ?? "");
        const code = child.marks.some((mark) => mark.type.name === "code");
        if (code) raw = serializeCodeSpan(raw, table);
        else if (table) raw = raw.replace(/\|/g, "\\|");
        const regular = regularMarks(child);
        const link = child.marks.find(
          (mark) => mark.type.name === "link" && !ignoredLink?.eq(mark),
        );
        closeTo(regular);
        if (link) {
          const title = link.attrs.title
            ? ` "${serializeInlineTitle(link.attrs.title, table)}"`
            : "";
          raw = `[${raw}](${escapeLinkDestination(link.attrs.href, table)}${title})`;
        }
        output += raw;
        if (raw) lineStart = raw.endsWith("\n");
      } else {
        closeTo([]);
        output += serializeInlineMarked(child, table);
        if (output) lineStart = output.endsWith("\n");
      }
    }
  }
  closeTo([...baseMarks]);
  return output;
}

function serializeInline(node: PMNode, table = false): string {
  return serializeInlineMarked(node, table);
}

/**
 * Escape table delimiters after serializing one cell, where generated pipes
 * cannot be confused with the row's column separators.  Inline syntax such
 * as image alt text, link titles, and raw inline source does not share the
 * normal text escaping path, so protecting the completed cell keeps those
 * contexts consistent.  A pipe already protected by a backslash must not be
 * escaped a second time.
 */
function escapeTableCellPipes(value: string): string {
  let output = "";
  let previousWasBackslash = false;
  for (const character of value) {
    if (character === "|") {
      output += previousWasBackslash ? "|" : "\\|";
      previousWasBackslash = false;
      continue;
    }
    output += character;
    previousWasBackslash = character === "\\";
  }
  return output;
}

function serializeTableCell(node: PMNode): string {
  // The shared schema restricts cells to one paragraph, but clipboard or
  // host integrations can still hand us a structurally malformed node.  Walk
  // every child so a malformed cell cannot silently lose content.
  let value = childrenOf(node)
    .map((child) => serializeBlock(child, true))
    .join("<br>");
  // GFM table cells cannot contain a literal newline. Preserve a newline
  // introduced through editing as the safe, portable hard-break spelling.
  value = value.replace(/\r\n|\r|\n/g, "<br>").trim();
  return escapeTableCellPipes(value) || " ";
}

// Details keep a nested snapshot so an edited paragraph does not regenerate
// untouched code, unknown HTML, nested Details, or their original separators.
const detailsBodySnapshots = new Map<string, MarkdownSnapshot>();
const detailsPartsCache = new Map<string, DetailsSourceParts | null>();
const detailsPartsByAttrs = new WeakMap<
  PMNode["attrs"],
  DetailsSourceParts | null
>();

function cachedDetailsParts(
  source: string,
  profile: Profile,
  tags?: readonly DetailsTagRange[],
  parser?: MarkdownIt,
): DetailsSourceParts | null {
  const key = `${profile}\u0000${source}`;
  if (detailsPartsCache.has(key)) return detailsPartsCache.get(key)!;
  const resolvedParser = parser ?? createMarkdownIt(profile);
  const parts = splitDetailsSource(
    source,
    tags ?? detailsTagRanges(source, resolvedParser),
    resolvedParser,
  );
  if (detailsPartsCache.size >= 64)
    detailsPartsCache.delete(detailsPartsCache.keys().next().value!);
  detailsPartsCache.set(key, parts);
  return parts;
}

/** Reuse the same block contexts during parsing, display and direct edits. */
export function parseDetailsSource(
  source: string,
  profile: Profile = "github",
): DetailsSourceParts | null {
  return cachedDetailsParts(source, profile);
}

/** Immutable attributes retain parsed ranges even in documents above cache size. */
export function detailsSourceParts(node: PMNode): DetailsSourceParts | null {
  if (detailsPartsByAttrs.has(node.attrs))
    return detailsPartsByAttrs.get(node.attrs)!;
  const parts = parseDetailsSource(
    String(node.attrs.source ?? ""),
    node.attrs.sourceProfile as Profile,
  );
  detailsPartsByAttrs.set(node.attrs, parts);
  return parts;
}

function detailsBodySnapshot(
  source: string,
  profile: Profile,
): MarkdownSnapshot {
  const key = `${profile}\u0000${source}`;
  let snapshot = detailsBodySnapshots.get(key);
  if (!snapshot) {
    snapshot = parseInternal(source, profile, false);
    if (detailsBodySnapshots.size >= 64)
      detailsBodySnapshots.delete(detailsBodySnapshots.keys().next().value!);
    detailsBodySnapshots.set(key, snapshot);
  }
  return snapshot;
}

function serializeDetails(node: PMNode): string {
  const source = String(node.attrs.source ?? "");
  const parts = detailsSourceParts(node);
  if (!parts) return source;
  const snapshot = detailsBodySnapshot(
    parts.body,
    node.attrs.sourceProfile as Profile,
  );
  let body = node.content.eq(snapshot.doc.content)
    ? parts.body
    : serializeMarkdown(
        schema.topNodeType.create(null, node.content),
        snapshot,
      );
  if (
    !node.content.eq(snapshot.doc.content) &&
    !snapshot.blocks?.length &&
    body
  ) {
    const ending = parts.body.includes("\r\n") ? "\r\n" : "\n";
    // An empty body has no block snapshots. Retain its original whitespace,
    // then give the first typed paragraph valid Markdown block boundaries.
    const prefix = parts.body.endsWith(`${ending}${ending}`)
      ? parts.body
      : parts.body + `${ending}${ending}`;
    body = prefix + body + `${ending}${ending}`;
  }
  return (
    parts.beforeSummary +
    String(node.attrs.summarySource ?? parts.summary) +
    parts.afterSummary +
    body +
    parts.closing
  );
}

function serializeBlock(node: PMNode, tableCell = false): string {
  switch (node.type.name) {
    case "paragraph":
      return serializeInline(node, tableCell);
    case "heading":
      return `${"#".repeat(node.attrs.level)} ${serializeInline(node)}`;
    case "blockquote":
      return childrenOf(node)
        .map((child) => serializeBlock(child))
        .join("\n\n")
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    case "horizontal_rule":
      return "---";
    case "code_block": {
      const content = node.textContent.replace(/\r\n|\r/g, "\n");
      const fence = codeFenceFor(content);
      const info = node.attrs.params ? String(node.attrs.params) : "";
      // The newline immediately before the closing fence is structural. It
      // must be emitted even when content already ends in a newline, or a
      // trailing blank line disappears when the document is reopened.
      return `${fence}${info}\n${content}\n${fence}`;
    }
    case "raw_block": {
      const source = String(node.attrs.source ?? "");
      if (String(node.attrs.kind ?? "") === "blank-spacer") return source;
      return source.replace(/(?:\r\n|\n|\r)+$/, "");
    }
    case "details":
      return serializeDetails(node).replace(/(?:\r\n|\n|\r)+$/, "");
    case "bullet_list":
      return childrenOf(node)
        .map((item) => serializeListItem(item, "- "))
        .join("\n");
    case "ordered_list": {
      const start = Number(node.attrs.order) || 1;
      return childrenOf(node)
        .map((item, index) => serializeListItem(item, `${start + index}. `))
        .join("\n");
    }
    case "list_item":
      return childrenOf(node)
        .map((child) => serializeBlock(child))
        .join("\n\n");
    case "table": {
      const rows = childrenOf(node);
      if (rows.length === 0) return "|  |\n| -- |";
      const width = Math.max(1, ...rows.map((row) => row.childCount));
      const values = rows.map((row) => {
        const cells = childrenOf(row).map(serializeTableCell);
        while (cells.length < width) cells.push(" ");
        return `| ${cells.join(" | ")} |`;
      });
      const first = rows[0]!;
      const alignments = childrenOf(first).map(
        (cell) => cell.attrs.alignment as string | null,
      );
      while (alignments.length < width) alignments.push(null);
      const divider = `| ${alignments
        .slice(0, width)
        .map((alignment) => {
          if (alignment === "left") return ":---";
          if (alignment === "right") return "---:";
          if (alignment === "center") return ":---:";
          return "---";
        })
        .join(" | ")} |`;
      return [values[0], divider, ...values.slice(1)].join("\n");
    }
    case "table_row":
      return childrenOf(node).map(serializeTableCell).join(" | ");
    case "table_cell":
    case "table_header":
      return childrenOf(node)
        .map((child) => serializeBlock(child, true))
        .join("\n\n");
    default:
      return node.textContent;
  }
}

/**
 * Serialize top-level blocks while giving empty paragraphs one line ending of
 * their own. A regular block boundary is two line endings, so a document with
 * one empty paragraph between two blocks has three rather than four. This is
 * the inverse of parseInternal's surplus-line materialization rule.
 */
function serializeTopLevelChildren(
  children: PMNode[],
  ending: "\n" | "\r\n",
): string {
  if (children.length === 0) return "";
  let output = "";
  let index = 0;
  while (index < children.length && isBlankSpacingNode(children[index])) {
    const node = children[index]!;
    output += isBlankSpacerNode(node) ? serializeBlock(node) : ending;
    index += 1;
  }
  if (index >= children.length) return output;

  output += serializeBlock(children[index]!);
  index += 1;
  while (index < children.length) {
    let emptyCount = 0;
    let spacer = "";
    while (index < children.length && isBlankSpacingNode(children[index])) {
      const node = children[index]!;
      if (isBlankSpacerNode(node)) spacer += serializeBlock(node);
      else emptyCount += 1;
      index += 1;
    }
    if (emptyCount > 0 || spacer) {
      if (index >= children.length) {
        output += ending.repeat(emptyCount + 1) + spacer;
        break;
      }
      output += ending.repeat(emptyCount + 2) + spacer;
      output += serializeBlock(children[index]!);
      index += 1;
      continue;
    }
    output += `${ending}${ending}${serializeBlock(children[index]!)}`;
    index += 1;
  }
  return output;
}

function appendGeneratedEmptyParagraph(
  output: string,
  ending: "\n" | "\r\n",
  hasContentBefore: boolean,
): string {
  if (!hasContentBefore) return output + ending;
  return output.endsWith(ending)
    ? output + ending
    : output + `${ending}${ending}`;
}

function serializeListItem(item: PMNode, marker: string): string {
  const task = item.attrs.checked;
  const content = childrenOf(item)
    .map((child) => serializeBlock(child))
    .join("\n\n");
  const taskPrefix =
    task == null ? "" : task === "mixed" ? "[~] " : task ? "[x] " : "[ ] ";
  const lines = content.split("\n");
  if (lines.length > 0) lines[0] = `${marker}${taskPrefix}${lines[0]}`;
  const continuationIndent = " ".repeat(Math.max(2, marker.length));
  return lines
    .map((line, index) => (index === 0 ? line : `${continuationIndent}${line}`))
    .join("\n");
}

function lineBreakSuffix(value: string): string {
  return value.match(/(?:\r\n|\n|\r)+$/)?.[0] ?? "";
}

function trailingBlankLineEndings(value: string): number {
  let start = value.length;
  while (
    start > 0 &&
    (value[start - 1] === " " ||
      value[start - 1] === "\t" ||
      value[start - 1] === "\r" ||
      value[start - 1] === "\n")
  )
    start -= 1;
  return lineEndingCount(value.slice(start));
}

function lineEndingCount(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\r") {
      if (value[index + 1] === "\n") index += 1;
      count += 1;
    } else if (character === "\n") count += 1;
  }
  return count;
}

function isBlankSource(value: string): boolean {
  return value.length > 0 && /^[\t \r\n]*$/u.test(value);
}

/**
 * A blank-only source made solely of line endings gets one editable paragraph
 * per line ending. Whitespace-only starter sources retain their established
 * single-paragraph shape so their source-preservation contract is unchanged.
 */
function isLineEndingOnlySource(value: string): boolean {
  return /^(?:\r\n|\n|\r)+$/u.test(value);
}

/**
 * Return the number of editable empty paragraphs represented by a source
 * boundary. A regular block boundary consumes two line endings; the final
 * terminator of a document consumes one, while leading blank lines have no
 * structural line ending to consume.
 */
function materializedEmptyCount(
  boundary: string,
  structuralLineEndings: number,
): number {
  if (!isBlankSource(boundary)) return 0;
  return Math.max(0, lineEndingCount(boundary) - structuralLineEndings);
}

/**
 * Split a blank boundary into the regular structural part followed by one
 * line-ending slice per materialized empty paragraph. Keeping the slices in
 * the snapshot lets an edit preserve the original whitespace bytes around
 * unchanged nodes instead of normalizing the source globally.
 */
interface BlankBoundaryParts {
  /** The structural separator that remains attached to the preceding block. */
  structural: string;
  /** At most the bounded number of editable empty paragraph source slices. */
  empty: string[];
  /** The unmaterialized suffix, kept in one source-preserving spacer atom. */
  overflow: string;
}

function splitBlankBoundary(
  value: string,
  structuralLineEndings: number,
): BlankBoundaryParts {
  const totalLineEndings = lineEndingCount(value);
  const extraLineEndings = totalLineEndings - structuralLineEndings;
  if (extraLineEndings <= 0)
    return { structural: value, empty: [], overflow: "" };

  const empty: string[] = [];
  let endingIndex = 0;
  let partStart = 0;
  let structuralEnd = structuralLineEndings === 0 ? 0 : -1;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    let endingLength = 0;
    if (character === "\r") {
      endingLength = value[index + 1] === "\n" ? 2 : 1;
    } else if (character === "\n") endingLength = 1;
    if (endingLength === 0) continue;

    endingIndex += 1;
    const end = index + endingLength;
    if (structuralLineEndings > 0 && endingIndex === structuralLineEndings) {
      structuralEnd = end;
      partStart = end;
    } else if (
      endingIndex > structuralLineEndings &&
      empty.length < MAX_MATERIALIZED_EMPTY_PARAGRAPHS
    ) {
      empty.push(value.slice(partStart, end));
      partStart = end;
    }
    index += endingLength - 1;
    if (
      empty.length === MAX_MATERIALIZED_EMPTY_PARAGRAPHS &&
      extraLineEndings > MAX_MATERIALIZED_EMPTY_PARAGRAPHS
    )
      break;
  }

  if (structuralEnd < 0) return { structural: value, empty: [], overflow: "" };
  const structural = value.slice(0, structuralEnd);
  const remainder = value.slice(partStart);
  if (empty.length < extraLineEndings) {
    return { structural, empty, overflow: remainder };
  }
  if (empty.length > 0) empty[empty.length - 1] += remainder;
  return { structural, empty, overflow: "" };
}

function materializedEmptyBlock(
  value: string,
  startLine: number,
): MarkdownBlockSnapshot {
  const node = emptyParagraph();
  return {
    node,
    source: value,
    body: "",
    separator: value,
    startLine,
    endLine: startLine + lineEndingCount(value),
    kind: "empty-paragraph",
  };
}

function materializedBlankSpacerBlock(
  value: string,
  startLine: number,
): MarkdownBlockSnapshot {
  const node = nodeTypes.raw_block.create({
    source: value,
    kind: "blank-spacer",
  });
  return {
    node,
    source: value,
    body: "",
    separator: value,
    startLine,
    endLine: startLine + lineEndingCount(value),
    kind: "blank-spacer",
  };
}

function isMaterializedEmptyBlock(
  block: MarkdownBlockSnapshot | undefined,
): boolean {
  return (
    block?.kind === "empty-paragraph" &&
    block.node.type.name === "paragraph" &&
    block.node.content.size === 0
  );
}

function isEmptyParagraph(node: PMNode | undefined): boolean {
  return node?.type.name === "paragraph" && node.content.size === 0;
}

function isBlankSpacerNode(node: PMNode | undefined): boolean {
  return (
    node?.type.name === "raw_block" &&
    String(node.attrs.kind ?? "") === "blank-spacer"
  );
}

export function isBlankSpacingNode(node: PMNode | undefined): boolean {
  return isEmptyParagraph(node) || isBlankSpacerNode(node);
}

interface ReferenceDefinitionSnapshot {
  label: string;
  source: string;
}

function referenceLabel(value: string): string {
  return value
    .trim()
    .replace(/[\t\r\n ]+/g, " ")
    .toLowerCase();
}

type ReferenceRule = (
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
) => boolean;

/**
 * Collect the exact source ranges accepted by markdown-it's reference block
 * rule. Reference definitions do not produce tokens, so scanning the rendered
 * block slices cannot distinguish multiline titles, code contents, or nested
 * container source from an actual definition.
 */
function referenceDefinitions(
  value: string,
  profile: Profile = "github",
): ReferenceDefinitionSnapshot[] {
  if (!value || !/\][ \t]*:/.test(value)) return [];

  const md = createMarkdownIt(profile);
  const referenceRule = md.block.ruler
    .getRules("")
    .find((rule) => rule.name === "reference") as ReferenceRule | undefined;
  if (!referenceRule) return [];

  const offsets = lineOffsets(value);
  const result: ReferenceDefinitionSnapshot[] = [];
  md.block.ruler.at(
    "reference",
    (
      state: StateBlock,
      startLine: number,
      endLine: number,
      silent: boolean,
    ) => {
      const knownLabels = new Set(
        Object.keys(state.env.references ?? Object.create(null)),
      );
      const accepted = referenceRule(state, startLine, endLine, silent);
      if (!accepted || silent) return accepted;

      const references = state.env.references ?? Object.create(null);
      const start = offsets[startLine] ?? 0;
      const end = offsets[state.line] ?? value.length;
      const source = value.slice(start, end).replace(/(?:\r\n|\n|\r)$/, "");
      for (const label of Object.keys(references)) {
        if (knownLabels.has(label) || label.startsWith("^")) continue;
        result.push({ label: referenceLabel(label), source });
      }
      return accepted;
    },
  );
  md.parse(value, {});
  return result;
}

function previousReferenceDefinitions(
  previous: MarkdownSnapshot,
): ReferenceDefinitionSnapshot[] {
  return referenceDefinitions(previous.source, previous.profile);
}

function preserveReferenceDefinitions(
  output: string,
  previous: MarkdownSnapshot,
  ending: "\n" | "\r\n",
): string {
  const definitions = previousReferenceDefinitions(previous);
  if (definitions.length === 0) return output;
  const existing = new Map(
    referenceDefinitions(output, previous.profile).map((definition) => [
      definition.label,
      toLineEnding(definition.source, ending),
    ]),
  );
  const missing = definitions.filter(
    (definition) =>
      existing.get(definition.label) !==
      toLineEnding(definition.source, ending),
  );
  if (missing.length === 0) return output;
  const insertion = `${missing.map((definition) => toLineEnding(definition.source, ending)).join(ending)}${ending}${ending}`;
  const leading = previous.leading ?? "";
  if (leading && output.startsWith(leading))
    return (
      output.slice(0, leading.length) + insertion + output.slice(leading.length)
    );
  return insertion + output;
}

function toLineEnding(value: string, ending: "\n" | "\r\n"): string {
  return value.replace(/\r\n|\r|\n/g, ending);
}

function previousFootnoteDefinitions(
  previous: MarkdownSnapshot,
): FootnoteDefinition[] {
  if (previous.footnotes && previous.footnotes.length > 0)
    return previous.footnotes;
  return scanFootnotes(previous.source).definitions;
}

function appendFootnoteDefinitions(
  output: string,
  definitions: FootnoteDefinition[],
  ending: "\n" | "\r\n",
): string {
  if (definitions.length === 0) return output;
  const existing = new Set(
    scanFootnotes(output).definitions.map((definition) => definition.label),
  );
  const missing = definitions.filter(
    (definition) => !existing.has(definition.label),
  );
  if (missing.length === 0) return output;
  const rendered = missing
    .map((definition) => toLineEnding(definition.source, ending))
    .join(ending);
  if (!output) return rendered;
  const separator = output.endsWith(ending + ending)
    ? ""
    : output.endsWith(ending)
      ? ending
      : ending + ending;
  return output + separator + rendered;
}

interface FootnoteInsertionGroup {
  definitions: FootnoteDefinition[];
  /** The previous block immediately before this definition group. */
  afterBlock: number;
  /** The exact source gap following the group, including its line endings. */
  trailing: string;
}

function footnoteInsertionGroups(
  previous: MarkdownSnapshot,
  definitions: FootnoteDefinition[],
): FootnoteInsertionGroup[] {
  const blocks = previous.blocks ?? [];
  if (definitions.length === 0) return [];
  const offsets = lineOffsets(previous.source);
  const starts = blocks.map((block) =>
    offsetForLine(offsets, block.startLine, previous.source.length),
  );
  const groups = new Map<number, FootnoteDefinition[]>();
  for (const definition of definitions) {
    const start = definition.start ?? previous.source.length;
    let afterBlock = -1;
    for (let index = 0; index < starts.length; index += 1) {
      if (starts[index]! >= start) break;
      afterBlock = index;
    }
    const group = groups.get(afterBlock);
    if (group) group.push(definition);
    else groups.set(afterBlock, [definition]);
  }
  return Array.from(groups.entries())
    .map(([afterBlock, group]) => {
      const lastEnd = Math.max(
        ...group.map((definition) => definition.end ?? definition.start ?? 0),
      );
      const nextStart =
        starts.find((start) => start > lastEnd) ?? previous.source.length;
      return {
        afterBlock,
        definitions: group.sort(
          (left, right) => (left.start ?? 0) - (right.start ?? 0),
        ),
        trailing: previous.source.slice(lastEnd, nextStart),
      };
    })
    .sort(
      (left, right) =>
        (left.definitions[0]!.start ?? 0) - (right.definitions[0]!.start ?? 0),
    );
}

function preserveFootnoteDefinitions(
  output: string,
  previous: MarkdownSnapshot,
  ending: "\n" | "\r\n",
): string {
  const definitions = previousFootnoteDefinitions(previous);
  if (definitions.length === 0) return output;
  const existing = new Set(
    scanFootnotes(output).definitions.map((definition) => definition.label),
  );
  const missing = definitions.filter(
    (definition) => !existing.has(definition.label),
  );
  if (missing.length === 0) return output;

  const blocks = previous.blocks ?? [];
  if (blocks.length === 0)
    return appendFootnoteDefinitions(output, missing, ending);

  // Locate preserved source slices in their document order. Changed blocks
  // are absent, so an insertion can fall back to the closest preserved block.
  const preservedOffsets: Array<number | undefined> = [];
  let searchFrom = 0;
  for (const block of blocks) {
    const position = block.source
      ? output.indexOf(block.source, searchFrom)
      : -1;
    preservedOffsets.push(position >= 0 ? position : undefined);
    if (position >= 0) searchFrom = position + block.source.length;
  }

  const groups = footnoteInsertionGroups(previous, missing);
  const insertions = groups.map((group) => {
    let position: number | undefined;
    for (let index = group.afterBlock; index >= 0; index -= 1) {
      const preserved = preservedOffsets[index];
      if (preserved === undefined) continue;
      position = preserved + blocks[index]!.source.length;
      break;
    }
    if (position === undefined) {
      for (
        let index = group.afterBlock + 1;
        index < blocks.length;
        index += 1
      ) {
        const preserved = preservedOffsets[index];
        if (preserved !== undefined) {
          position = preserved;
          break;
        }
      }
    }
    return {
      position: position ?? (group.afterBlock < 0 ? 0 : output.length),
      source:
        group.definitions
          .map((definition) => toLineEnding(definition.source, ending))
          .join(ending) + toLineEnding(group.trailing || ending, ending),
    };
  });

  // Insert from the end so earlier offsets remain valid. The final append is
  // a defensive fallback for metadata whose source location is unavailable.
  insertions
    .sort((left, right) => right.position - left.position)
    .forEach((insertion) => {
      output =
        output.slice(0, insertion.position) +
        insertion.source +
        output.slice(insertion.position);
    });
  return appendFootnoteDefinitions(output, missing, ending);
}

function nodeFingerprint(node: PMNode): string {
  return JSON.stringify(node.toJSON());
}

function sourceMatches(
  current: PMNode[],
  previous: MarkdownBlockSnapshot[],
): Map<number, number> {
  // Matching is deliberately linear. A document can contain thousands of
  // short paragraphs and this function runs after every edit; a quadratic LCS
  // matrix would turn a harmless keystroke into an avoidable memory spike.
  const candidates = new Map<string, number[]>();
  const identityCandidates = new Map<PMNode, number[]>();
  for (let index = 0; index < previous.length; index += 1) {
    const previousNode = previous[index]!.node;
    const key = nodeFingerprint(previousNode);
    const list = candidates.get(key);
    if (list) list.push(index);
    else candidates.set(key, [index]);
    const identities = identityCandidates.get(previousNode);
    if (identities) identities.push(index);
    else identityCandidates.set(previousNode, [index]);
  }
  const matches = new Map<number, number>();
  const usedPrevious = new Set<number>();
  const identityCursors = new Map<PMNode, number>();
  const identityMatches = new Map<number, number>();
  // ProseMirror preserves object identity for untouched nodes through a
  // transaction. Prefer that identity before comparing fingerprints so
  // consecutive source-authored empty paragraphs retain their own source
  // slices even though their semantic node JSON is identical.
  for (let index = 0; index < current.length; index += 1) {
    const node = current[index]!;
    const identities = identityCandidates.get(node);
    if (!identities) continue;
    let cursor = identityCursors.get(node) ?? 0;
    while (cursor < identities.length && usedPrevious.has(identities[cursor]!))
      cursor += 1;
    if (cursor >= identities.length) {
      identityCursors.set(node, cursor);
      continue;
    }
    const candidate = identities[cursor]!;
    identityCursors.set(node, cursor + 1);
    identityMatches.set(index, candidate);
  }
  // A reordered document needs the old fingerprint matcher to retain its
  // established source-order behavior. Identity is only safe when the
  // untouched nodes still occur in previous-document order; otherwise an
  // identity match could make a moved duplicate consume a distant source
  // slice and leave the following blocks unmatched.
  let previousIdentity = -1;
  let identityOrderValid = true;
  for (let index = 0; index < current.length; index += 1) {
    const candidate = identityMatches.get(index);
    if (candidate == null) continue;
    if (candidate <= previousIdentity) {
      identityOrderValid = false;
      break;
    }
    previousIdentity = candidate;
  }
  const orderedIdentityMatches = identityOrderValid
    ? identityMatches
    : new Map<number, number>();
  if (identityOrderValid) {
    orderedIdentityMatches.forEach((candidate, index) => {
      matches.set(index, candidate);
      usedPrevious.add(candidate);
    });
  }
  // Fingerprint matches must stay inside the interval delimited by the
  // identity anchors. Without this upper bound, a new node can claim a
  // source block belonging to a later anchor, producing a non-monotonic
  // sequence such as 0, 2, 1. Keep a blocked candidate unconsumed so a later
  // current node can still use it after the anchor.
  const nextIdentityPrevious: Array<number | undefined> = new Array(
    current.length,
  );
  let nextIdentity: number | undefined;
  for (let index = current.length - 1; index >= 0; index -= 1) {
    nextIdentityPrevious[index] = nextIdentity;
    const candidate = orderedIdentityMatches.get(index);
    if (candidate != null) nextIdentity = candidate;
  }
  let previousCursor = -1;
  const cursors = new Map<string, number>();
  for (let index = 0; index < current.length; index += 1) {
    const identityMatch = matches.get(index);
    if (identityMatch != null) {
      previousCursor = Math.max(previousCursor, identityMatch);
      continue;
    }
    const key = nodeFingerprint(current[index]!);
    const list = candidates.get(key);
    if (!list) continue;
    let cursor = cursors.get(key) ?? 0;
    while (
      cursor < list.length &&
      (list[cursor]! <= previousCursor || usedPrevious.has(list[cursor]!))
    )
      cursor += 1;
    // Persist only candidates that are already behind the lower bound. The
    // candidate at cursor may be blocked by the future anchor and must remain
    // available for a later current node after that anchor.
    cursors.set(key, cursor);
    if (cursor >= list.length) {
      continue;
    }
    const candidate = list[cursor]!;
    const nextIdentityPreviousIndex = nextIdentityPrevious[index];
    if (
      nextIdentityPreviousIndex != null &&
      candidate >= nextIdentityPreviousIndex
    )
      continue;
    cursors.set(key, cursor + 1);
    matches.set(index, candidate);
    usedPrevious.add(candidate);
    previousCursor = candidate;
  }
  return matches;
}

function normalisedRaw(node: PMNode): string {
  if (node.type.name === "details") return serializeDetails(node);
  if (node.type.name === "raw_block" || node.type.name === "raw_inline")
    return String(node.attrs.source ?? "");
  return "";
}

interface RawInlineSourceChange {
  oldSource: string;
  newSource: string;
}

function sameMarks(left: PMNode, right: PMNode): boolean {
  return (
    left.marks.length === right.marks.length &&
    left.marks.every((mark, index) => mark.eq(right.marks[index]!))
  );
}

/** Find a single raw-inline source edit without matching identical text. */
function rawInlineSourceChange(
  previous: PMNode,
  current: PMNode,
  changes: RawInlineSourceChange[] = [],
): RawInlineSourceChange | null | undefined {
  if (previous.type !== current.type || !sameMarks(previous, current))
    return null;
  if (previous.type.name === "raw_inline") {
    if (String(previous.attrs.kind ?? "") !== String(current.attrs.kind ?? ""))
      return null;
    const oldSource = String(previous.attrs.source ?? "");
    const newSource = String(current.attrs.source ?? "");
    if (oldSource !== newSource) changes.push({ oldSource, newSource });
    return changes.length <= 1 ? changes[0] : null;
  }
  if (previous.isText || current.isText)
    return previous.eq(current) ? changes[0] : null;
  if (
    !previous.sameMarkup(current) ||
    previous.childCount !== current.childCount
  )
    return null;
  for (let index = 0; index < previous.childCount; index += 1) {
    const change = rawInlineSourceChange(
      previous.child(index),
      current.child(index),
      changes,
    );
    if (change === null) return null;
  }
  return changes.length <= 1 ? changes[0] : null;
}

/** Preserve all surrounding paragraph bytes for a sole inline raw edit. */
function preserveRawInlineSourceSlice(
  currentNode: PMNode,
  previous: MarkdownSnapshot,
  previousBlock: MarkdownBlockSnapshot,
): string | null {
  if (previousBlock.node.type.name !== "paragraph") return null;
  const change = rawInlineSourceChange(previousBlock.node, currentNode);
  if (!change || !change.oldSource || change.oldSource === change.newSource)
    return null;
  const occurrences: number[] = [];
  let searchFrom = 0;
  while (occurrences.length < 64) {
    const occurrence = previousBlock.source.indexOf(
      change.oldSource,
      searchFrom,
    );
    if (occurrence < 0) break;
    occurrences.push(occurrence);
    searchFrom = occurrence + Math.max(1, change.oldSource.length);
  }
  for (const occurrence of occurrences) {
    const candidate =
      previousBlock.source.slice(0, occurrence) +
      change.newSource +
      previousBlock.source.slice(occurrence + change.oldSource.length);
    const candidateNode = parseMarkdown(candidate, previous.profile ?? "github")
      .doc.firstChild;
    if (candidateNode?.eq(currentNode)) return candidate;
  }
  return null;
}

/**
 * Serialize a ProseMirror document. If a snapshot is supplied, exact source
 * slices are reused for unchanged top-level nodes, including their line
 * endings and surrounding blank lines.
 */
function sourceNeedsExactCanonicalPreservation(source: string): boolean {
  return (
    /<!--[\s\S]*-->|<\/?(?:strong|em|kbd|sup|sub|details)\b/i.test(source) ||
    /(?:^|\n)\s*\[\^([^\]\r\n]+)\]:/m.test(source) ||
    /(?:^|\n)\s*\[\[_TOC_\]\]/m.test(source) ||
    /\{[-+][\s\S]*?[-+]\}/.test(source) ||
    /!\[[^\]]*\]\([^)]*\)\{(?:width|height)=/i.test(source) ||
    /:[a-zA-Z0-9_+-]+:/.test(source)
  );
}

/** An info-string edit must not reserialize code or its original fence. */
function codeInfoOnlySource(
  node: PMNode,
  previous: MarkdownBlockSnapshot,
): string | null {
  if (
    node.type.name !== "code_block" ||
    previous.node.type !== node.type ||
    !node.content.eq(previous.node.content)
  )
    return null;
  const opening = previous.source.match(
    /^( {0,3}(?:`{3,}|~{3,}))([^\r\n]*)(?:\r\n|\r|\n|$)/,
  );
  if (
    !opening ||
    opening[2]!.trim() !== String(previous.node.attrs.params ?? "")
  )
    return null;
  const params = String(node.attrs.params ?? "");
  if (
    /[\r\n]/.test(params) ||
    (opening[1]!.includes("`") && params.includes("`"))
  )
    return null;
  const info = opening[2]!;
  const leading = info.match(/^[\t ]*/)?.[0] ?? "";
  const trailing = info.slice(leading.length).match(/[\t ]*$/)?.[0] ?? "";
  const end = opening[1]!.length + info.length;
  return opening[1] + leading + params + trailing + previous.source.slice(end);
}

export function serializeMarkdown(
  doc: PMNode,
  previous?: MarkdownSnapshot,
): string {
  if (previous?.doc && doc.eq(previous.doc)) return previous.source;
  if (!previous) {
    const metadata = documentMetadata.get(doc);
    if (
      metadata?.source &&
      (metadata.sourcePreservedNoOp ||
        sourceNeedsExactCanonicalPreservation(metadata.source))
    )
      return metadata.source;
  }
  const children = childrenOf(doc);
  const blocks = previous?.blocks ?? [];
  const preserveSourceMetadata = (
    output: string,
    ending: "\n" | "\r\n",
  ): string => {
    if (previous)
      return preserveFootnoteDefinitions(
        preserveReferenceDefinitions(output, previous, ending),
        previous,
        ending,
      );
    const metadata = documentMetadata.get(doc);
    return appendFootnoteDefinitions(output, metadata?.footnotes ?? [], ending);
  };
  if (blocks.length === 0) {
    const metadata = documentMetadata.get(doc);
    const ending: "\n" | "\r\n" =
      previous?.lineEnding === "crlf" || metadata?.lineEnding === "crlf"
        ? "\r\n"
        : "\n";
    const serialized = serializeTopLevelChildren(children, ending);
    const last = children[children.length - 1];
    if (
      (last?.type.name === "raw_block" && !isBlankSpacerNode(last)) ||
      last?.type.name === "details"
    ) {
      const rawEnding = lineBreakSuffix(String(last.attrs.source ?? ""));
      if (rawEnding) {
        const ending = rawEnding.includes("\r\n")
          ? "\r\n"
          : rawEnding.includes("\r")
            ? "\r"
            : "\n";
        const metadataEnding = ending === "\r\n" ? "\r\n" : "\n";
        return preserveSourceMetadata(serialized + ending, metadataEnding);
      }
    }
    return preserveSourceMetadata(serialized, ending);
  }

  const matches = sourceMatches(children, blocks);
  const ending: "\n" | "\r\n" = previous?.lineEnding === "crlf" ? "\r\n" : "\n";
  const leading = previous?.leading ?? "";
  // Look ahead through the match map once.  Rebuilding and scanning all
  // entries for every inserted node turns a large document edit into a
  // quadratic operation even though source matching itself is linear.
  const nextMatchedPrevious: Array<number | undefined> = new Array(
    children.length,
  );
  let nextPrevious: number | undefined;
  for (let index = children.length - 1; index >= 0; index -= 1) {
    nextMatchedPrevious[index] = nextPrevious;
    const matched = matches.get(index);
    if (matched !== undefined) nextPrevious = matched;
  }
  const hasContentAfter: boolean[] = new Array(children.length);
  let contentAfter = false;
  for (let index = children.length - 1; index >= 0; index -= 1) {
    hasContentAfter[index] = contentAfter;
    if (!isBlankSpacingNode(children[index])) contentAfter = true;
  }
  let output = leading;
  let hasContentBefore = false;
  for (let index = 0; index < children.length; index += 1) {
    const node = children[index]!;
    const matched = matches.get(index);
    if (matched != null) {
      const previousBlock = blocks[matched]!;
      // A matched block's source normally includes the separator before the
      // next previous block. If that previous suffix was deleted and this is
      // now the current terminal block, retain only the block body; otherwise
      // a removed block's separator would become a new trailing blank line.
      output +=
        !isBlankSpacingNode(node) &&
        index === children.length - 1 &&
        matched < blocks.length - 1
          ? previousBlock.body
          : previousBlock.source;
      if (!isBlankSpacingNode(node)) hasContentBefore = true;
      continue;
    }

    const samePosition = blocks[index];
    const insertion = !samePosition || nextMatchedPrevious[index] === index;
    if (isEmptyParagraph(node)) {
      output = appendGeneratedEmptyParagraph(output, ending, hasContentBefore);
      continue;
    }
    if (isBlankSpacerNode(node)) {
      output += serializeBlock(node);
      continue;
    }
    if (samePosition && isMaterializedEmptyBlock(samePosition)) {
      let emptyParagraphsBefore = 0;
      for (
        let previousIndex = index - 1;
        previousIndex >= 0 && isEmptyParagraph(children[previousIndex]);
        previousIndex -= 1
      )
        emptyParagraphsBefore += 1;
      const requiredLineEndings = hasContentBefore
        ? 2 + emptyParagraphsBefore
        : 0;
      const existingLineEndings = trailingBlankLineEndings(output);
      if (index > 0 && requiredLineEndings > existingLineEndings) {
        output += ending.repeat(requiredLineEndings - existingLineEndings);
      }
      output += toLineEnding(serializeBlock(node), ending);
      if (hasContentAfter[index]) output += `${ending}${ending}`;
      else if (index < children.length - 1) output += ending;
      hasContentBefore = true;
      continue;
    }
    if (previous && !insertion && samePosition) {
      const preservedInline = preserveRawInlineSourceSlice(
        node,
        previous,
        samePosition,
      );
      if (preservedInline) {
        output += preservedInline;
        continue;
      }
    }
    const codeInfoSource =
      !insertion && samePosition && codeInfoOnlySource(node, samePosition);
    if (codeInfoSource) {
      output += codeInfoSource;
      continue;
    }
    // Details can interrupt paragraphs, and a raw HTML block can end directly
    // before a paragraph. Preserve those existing adjacent source boundaries
    // when their preceding block is unchanged. Existing blank separators can
    // also use CR or mixed endings, independently of the generated line ending.
    const previousNode = blocks[index - 1]?.node;
    let emptyParagraphsBefore = 0;
    for (
      let previousIndex = index - 1;
      previousIndex >= 0 && isEmptyParagraph(children[previousIndex]);
      previousIndex -= 1
    )
      emptyParagraphsBefore += 1;
    const requiredLineEndings = hasContentBefore
      ? 2 + emptyParagraphsBefore
      : 0;
    const existingLineEndings = trailingBlankLineEndings(output);
    const preservedSourceBoundary =
      !insertion &&
      matches.get(index - 1) === index - 1 &&
      ((node.type.name === "details" &&
        samePosition?.node.type.name === "details") ||
        (node.type.name === "paragraph" &&
          samePosition?.node.type.name === "paragraph" &&
          previousNode?.type.name === "raw_block" &&
          previousNode.attrs.kind === "html") ||
        /(?:\r\n|\r(?!\n)|\n)[\t ]*(?:\r\n?|\n)$/.test(output));
    if (
      index > 0 &&
      !preservedSourceBoundary &&
      requiredLineEndings > existingLineEndings
    ) {
      output += ending.repeat(requiredLineEndings - existingLineEndings);
    }
    const generated =
      node.type.name === "details"
        ? serializeBlock(node)
        : toLineEnding(serializeBlock(node), ending);
    output += generated;
    if (!insertion && samePosition) {
      // Markdown-it's map includes the final line ending in a block body,
      // while the generic serializer intentionally omits it. Restore that
      // exact boundary before the preserved separator.
      output += lineBreakSuffix(samePosition.body) + samePosition.separator;
    } else if (index < children.length - 1) {
      output += `${ending}${ending}`;
    } else if (
      (previous?.source ?? "").endsWith("\n") ||
      (previous?.source ?? "").endsWith("\r")
    ) {
      output += ending;
    }
    hasContentBefore = true;
  }
  if (children.length === 0 && previous?.trailing) output += previous.trailing;
  return preserveSourceMetadata(output, ending);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripUrlControls(value: string): string {
  let result = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f || code === 0xa0) continue;
    result += character;
  }
  return result;
}

function safeUrl(value: unknown, image = false): string | null {
  const source = stripUrlControls(String(value ?? ""));
  const normalized = source.trim().toLowerCase();
  const scheme = normalized.match(/^([a-z][a-z0-9+.-]*):/i)?.[1];
  if (!scheme) return source;
  if (["http", "https", "mailto", "tel"].includes(scheme)) return source;
  if (
    image &&
    scheme === "data" &&
    /^data:image\/(?:gif|png|jpeg|jpg|webp);base64,[a-z0-9+/=]+$/i.test(source)
  )
    return source;
  return null;
}

function renderSafeInlineHtml(source: string): string {
  const tokenPattern = /<!--[\s\S]*-->|<\/?[a-z][a-z0-9-]*(?:\s[^>]*)?>/gi;
  let output = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(source)) != null) {
    output += escapeHtml(source.slice(cursor, match.index));
    const token = match[0]!;
    if (/^<!--[\s\S]*-->$/.test(token)) {
      // Comments are source-preserving but intentionally absent from preview.
    } else {
      const tag = inlineHtmlTag(token);
      if (!tag) output += escapeHtml(token);
      else if (tag.void) output += "<br>";
      else output += `<${tag.closing ? "/" : ""}${tag.name}>`;
    }
    cursor = match.index + token.length;
  }
  output += escapeHtml(source.slice(cursor));
  return output;
}

function renderHtmlPair(source: string, state: RenderState): string {
  const openingMatch = source.match(/^\s*<([a-z][a-z0-9-]*)(?:\s[^>]*)?>/i);
  if (!openingMatch) return renderSafeInlineHtml(source);
  const opening = openingMatch[0]!;
  const openingTag = inlineHtmlTag(opening);
  if (!openingTag || openingTag.closing || openingTag.void)
    return renderSafeInlineHtml(source);
  const closingPattern = new RegExp(
    "</" + openingTag.name + "(?:\\s[^>]*)?>\\s*$",
    "i",
  );
  const closingMatch = closingPattern.exec(source);
  if (!closingMatch || closingMatch.index <= opening.length)
    return renderSafeInlineHtml(source);
  const closing = closingMatch[0]!;
  const body = source.slice(opening.length, closingMatch.index);
  const bodyHtml =
    body && openingTag.name === "code"
      ? escapeHtml(unescapeSerializedInlineText(body))
      : body
        ? renderInlineSource(body, state.profile, state)
        : "";
  return (
    renderSafeInlineHtml(opening) + bodyHtml + renderSafeInlineHtml(closing)
  );
}

function unescapeSerializedInlineText(value: string): string {
  const escapable = new Set(Array.from("\\`*_[]<>#-+.!~$:=&()|"));
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    const next = value[index + 1];
    if (character === "\\" && next && escapable.has(next)) {
      output += next;
      index += 1;
    } else output += character;
  }
  return output;
}

function renderCodeFallback(source: string, language: string): string {
  // Keep custom renderers and the built-in renderer on the same accessible
  // code-card contract when a host renderer declines a block.
  return renderCodeBlockHtml(source, language);
}

function renderTextMarks(value: string, marks: readonly Mark[]): string {
  let output = escapeHtml(value);
  for (let index = marks.length - 1; index >= 0; index -= 1) {
    const mark = marks[index]!;
    if (mark.type.name === "code") output = `<code>${output}</code>`;
    else if (mark.type.name === "strong") output = `<strong>${output}</strong>`;
    else if (mark.type.name === "em") output = `<em>${output}</em>`;
    else if (mark.type.name === "strike") output = `<del>${output}</del>`;
    else if (mark.type.name === "link") {
      const href = safeUrl(mark.attrs.href);
      if (href) {
        const title = mark.attrs.title
          ? ` title="${escapeHtml(mark.attrs.title)}"`
          : "";
        output = `<a href="${escapeHtml(href)}"${title}>${output}</a>`;
      }
    }
  }
  return output;
}

interface RenderState extends RenderContext {
  profile: Profile;
  footnotes: FootnoteDefinition[];
  headingSlugs: Map<string, number>;
  footnoteRefs: Map<string, number>;
  footnoteNumbers: Map<string, number>;
  headingIds: WeakMap<PMNode, Map<number, string>>;
}

type RenderInput = RenderContext | MarkdownSnapshot | PMNode | undefined;

function isSnapshot(value: RenderInput): value is MarkdownSnapshot {
  return Boolean(
    value && typeof value === "object" && "doc" in value && "source" in value,
  );
}

function isPMDocument(value: RenderInput): value is PMNode {
  return Boolean(
    value &&
    typeof value === "object" &&
    "type" in value &&
    "childCount" in value,
  );
}

function createRenderState(profile: Profile, input?: RenderInput): RenderState {
  let context: RenderContext = {};
  let document: PMNode | undefined;
  let snapshot: MarkdownSnapshot | undefined;
  if (isSnapshot(input)) {
    snapshot = input;
    document = input.doc;
    context = input;
  } else if (isPMDocument(input)) {
    document = input;
    context = { document: input };
  } else if (input) {
    context = input;
    document = input.document ?? input.snapshot?.doc;
    snapshot = input.snapshot;
  }
  const metadata = document ? documentMetadata.get(document) : undefined;
  let inheritedFootnotes = metadata?.footnotes ?? [];
  if (document && inheritedFootnotes.length === 0) {
    document.descendants((node) => {
      const nodeFootnotes = footnoteNodeMetadata.get(node);
      if (nodeFootnotes && nodeFootnotes.length > 0) {
        inheritedFootnotes = nodeFootnotes;
        return false;
      }
      return true;
    });
  }
  const footnotes =
    context.footnotes ?? snapshot?.footnotes ?? inheritedFootnotes;
  const state: RenderState = {
    // The visual helpers are pure and can be overridden by a host renderer.
    // Put the defaults before the caller context so an injected renderer wins.
    renderCodeBlock: renderCodeBlockHtml,
    renderMath: renderMathHtml,
    renderAdvancedBlock: (kind, source, options) => {
      const renderOptions: { language?: string; maxSourceLength?: number } = {};
      if (typeof options?.language === "string")
        renderOptions.language = options.language;
      if (typeof options?.maxSourceLength === "number")
        renderOptions.maxSourceLength = options.maxSourceLength;
      return renderAdvancedBlockHtml(kind, source, renderOptions);
    },
    ...context,
    profile,
    footnotes,
    headingSlugs: context.headingSlugs ?? new Map<string, number>(),
    footnoteRefs: context.footnoteRefs ?? new Map<string, number>(),
    footnoteNumbers: context.footnoteNumbers ?? new Map<string, number>(),
    headingIds:
      context.headingIds ?? new WeakMap<PMNode, Map<number, string>>(),
  };
  if (document) state.document = document;
  if (snapshot) state.snapshot = snapshot;
  return state;
}

function headingText(node: PMNode): string {
  let output = "";
  node.forEach((child) => {
    if (child.isText) output += child.text ?? "";
    else if (child.type.name === "image")
      output += String(child.attrs.alt ?? "");
    else if (child.type.name === "raw_inline") {
      const kind = String(child.attrs.kind ?? "");
      const source = String(child.attrs.source ?? "");
      if (kind === "emoji")
        output += emojiShortcodes[source.slice(1, -1).toLowerCase()] ?? source;
      else if (kind !== "html-comment")
        output += source.replace(/<[^>]*>/g, "");
    } else output += headingText(child);
  });
  return output;
}

function slugBase(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]+/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || "section";
}

function headingId(
  node: PMNode,
  state: RenderState,
  root: PMNode,
  position: number,
): string {
  // Details body snapshots deliberately share immutable nodes. The rendering
  // root and position identify an occurrence, including inside nested Details;
  // separate source fragments get their own root without reusing these slots.
  let positions = state.headingIds.get(root);
  if (!positions) {
    positions = new Map<number, string>();
    state.headingIds.set(root, positions);
  }
  const existing = positions.get(position);
  if (existing) return existing;
  const base = slugBase(headingText(node));
  const count = state.headingSlugs.get(base) ?? 0;
  state.headingSlugs.set(base, count + 1);
  const id = count === 0 ? base : `${base}-${count}`;
  positions.set(position, id);
  return id;
}

function prepareHeadingIds(node: PMNode, state: RenderState): void {
  if (node.type.name === "heading") headingId(node, state, node, 0);
  const contentStart = node.type.name === "doc" ? 0 : 1;
  node.descendants((child, position) => {
    if (child.type.name === "heading")
      headingId(child, state, node, position + contentStart);
  });
}

function footnoteLabelFromSource(source: string): string {
  const match = source.match(/^\[\^([^\]]+)\]/);
  return referenceLabel(match?.[1] ?? source);
}

function footnoteNumber(label: string, state: RenderState): number {
  if (!state.footnotes.some((definition) => definition.label === label))
    return 0;
  const existing = state.footnoteNumbers.get(label);
  if (existing !== undefined) return existing;
  const number = state.footnoteNumbers.size + 1;
  state.footnoteNumbers.set(label, number);
  return number;
}

function registerFootnoteRef(source: string, state: RenderState): void {
  const label = footnoteLabelFromSource(source);
  const number = footnoteNumber(label, state);
  if (!number) return;
  const count = state.footnoteRefs.get(label) ?? 0;
  state.footnoteRefs.set(label, count + 1);
}

function renderFootnoteRef(source: string, state: RenderState): string {
  const label = footnoteLabelFromSource(source);
  const number = footnoteNumber(label, state);
  if (!number) return escapeHtml(source);
  const count = state.footnoteRefs.get(label) ?? 0;
  state.footnoteRefs.set(label, count + 1);
  const suffix = count === 0 ? "" : `-${count + 1}`;
  return `<sup id="fnref-${escapeHtml(label)}${suffix}" class="footnote-ref"><a href="#fn-${escapeHtml(label)}">${number}</a></sup>`;
}

function registerFootnoteReferencesBeforeNode(
  document: PMNode | undefined,
  target: PMNode,
  state: RenderState,
): void {
  if (!document || document === target) return;
  if (state.nodePosition !== undefined && Number.isFinite(state.nodePosition)) {
    document.descendants((node, position) => {
      // Positions are ordered in document traversal. Once a node starts at or
      // after the target, its descendants and following siblings cannot be
      // references that precede the target.
      if (position >= state.nodePosition!) return false;
      if (node.type.name !== "raw_inline") return true;
      const kind = String(node.attrs.kind ?? "");
      if (kind === "footnote_ref" || kind === "footnote_anchor")
        registerFootnoteRef(String(node.attrs.source ?? ""), state);
      return true;
    });
    return;
  }
  const ordered: PMNode[] = [];
  walk(document, (node) => ordered.push(node));
  const targetIndex = ordered.indexOf(target);
  if (targetIndex < 0) return;
  for (let index = 0; index < targetIndex; index += 1) {
    const node = ordered[index]!;
    if (node.type.name !== "raw_inline") continue;
    const kind = String(node.attrs.kind ?? "");
    if (kind === "footnote_ref" || kind === "footnote_anchor")
      registerFootnoteRef(String(node.attrs.source ?? ""), state);
  }
}

function renderInlineDiff(source: string): string {
  const removed = source.match(/^\{-([\s\S]*?)-\}$/);
  if (removed)
    return `<del class="gitlab-inline-diff">${escapeHtml(removed[1]!)}</del>`;
  const added = source.match(/^\{\+([\s\S]*?)\+\}$/);
  if (added)
    return `<ins class="gitlab-inline-diff">${escapeHtml(added[1]!)}</ins>`;
  return escapeHtml(source);
}

function renderRawInline(node: PMNode, state: RenderState): string {
  const source = String(node.attrs.source ?? "");
  const kind = String(node.attrs.kind ?? "unknown");
  let output: string;
  if (kind === "html-comment") output = "";
  else if (kind === "html" || kind === "html-allowed")
    output = renderSafeInlineHtml(source);
  else if (kind === "html-pair") output = renderHtmlPair(source, state);
  else if (kind === "emoji")
    output = escapeHtml(
      emojiShortcodes[source.slice(1, -1).toLowerCase()] ?? source,
    );
  else if (kind === "gitlab-inline-diff") output = renderInlineDiff(source);
  else if (kind === "footnote_ref" || kind === "footnote_anchor")
    output = renderFootnoteRef(source, state);
  else if (kind === "math_inline") {
    const rendered = state.renderMath?.(source, false) ?? null;
    output =
      rendered ?? `<span class="math-inline">${escapeHtml(source)}</span>`;
  } else
    output = `<span data-markdown-raw="true" data-kind="${escapeHtml(kind)}">${escapeHtml(source)}</span>`;
  if (!output) return output;
  const renderedAsNodeView =
    state.document !== undefined &&
    state.nodePosition !== undefined &&
    state.document.nodeAt(state.nodePosition) === node;
  // ProseMirror renders the node's marks around a NodeView. Applying them
  // again here would create nested links/marks, including invalid <a> inside
  // <a> markup for linked inline Math.
  if (renderedAsNodeView) return output;
  return applyInlineMarks(output, node.marks);
}

function applyInlineMarks(value: string, marks: readonly Mark[]): string {
  let output = value;
  for (let index = marks.length - 1; index >= 0; index -= 1) {
    const mark = marks[index]!;
    if (mark.type.name === "strong") output = `<strong>${output}</strong>`;
    else if (mark.type.name === "em") output = `<em>${output}</em>`;
    else if (mark.type.name === "strike") output = `<del>${output}</del>`;
    else if (mark.type.name === "code") output = `<code>${output}</code>`;
    else if (mark.type.name === "link") {
      const href = safeUrl(mark.attrs.href);
      if (href) {
        const title = mark.attrs.title
          ? ` title="${escapeHtml(mark.attrs.title)}"`
          : "";
        output = `<a href="${escapeHtml(href)}"${title}>${output}</a>`;
      }
    }
  }
  return output;
}

function renderInline(node: PMNode, state: RenderState): string {
  let output = "";
  node.forEach((child) => {
    if (child.isText) output += renderTextMarks(child.text ?? "", child.marks);
    else if (child.type.name === "hard_break") output += "<br>\n";
    else if (child.type.name === "raw_inline")
      output += renderRawInline(child, state);
    else if (child.type.name === "image") {
      const src = safeUrl(child.attrs.src, true);
      let image = src
        ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(child.attrs.alt ?? "")}"${child.attrs.title ? ` title="${escapeHtml(child.attrs.title)}"` : ""}${safeImageDimension(child.attrs.width) ? ` width="${escapeHtml(safeImageDimension(child.attrs.width)!)}"` : ""}${safeImageDimension(child.attrs.height) ? ` height="${escapeHtml(safeImageDimension(child.attrs.height)!)}"` : ""}>`
        : escapeHtml(child.attrs.alt ?? "");
      image = applyInlineMarks(image, child.marks);
      output += image;
    } else output += renderInline(child, state);
  });
  return output;
}

function renderCodeBlock(node: PMNode, state: RenderState): string {
  const language = String(node.attrs.params ?? "");
  const source = node.textContent;
  const rendered = state.renderCodeBlock?.(source, language) ?? null;
  return rendered ?? renderCodeFallback(source, language);
}

const ALERT_ICON_SOURCES = {
  note: infoIconAsset,
  tip: lightbulbAsset,
  important: alertOctagonAsset,
  warning: warningTriangleAsset,
  caution: alertCommentAsset,
} as const;

function renderAlert(source: string, state: RenderState): string {
  const parts = parseAlertSource(source);
  const marker = parts.marker;
  const body = parts.body;
  const title = marker.charAt(0).toUpperCase() + marker.slice(1);
  const bodyHtml = body ? renderSourceFragment(body, state.profile, state) : "";
  const icon =
    ALERT_ICON_SOURCES[marker as keyof typeof ALERT_ICON_SOURCES] ??
    ALERT_ICON_SOURCES.note;
  return `<div class="markdown-alert markdown-alert-${escapeHtml(marker)}"><p class="markdown-alert-title"><span class="markdown-alert-icon" aria-hidden="true">${icon}</span><span class="markdown-alert-title-text">${escapeHtml(title)}</span></p>${bodyHtml}</div>`;
}

function matchingDetailsClose(source: string, start = 0): number {
  const tags = /<\/?details\b[^>]*>/gi;
  const fenceRanges = detailsFenceRanges(source);
  const insideFence = (offset: number): boolean =>
    fenceRanges.some((range) => offset >= range.start && offset < range.end);
  tags.lastIndex = start;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(source)) != null) {
    if (insideFence(match.index)) continue;
    if (match[0]!.startsWith("</")) {
      depth -= 1;
      if (depth === 0) return match.index;
    } else depth += 1;
  }
  return -1;
}

function renderDetails(source: string, state: RenderState): string {
  const opening = source.match(/^\s*<details\b([^>]*)>/i);
  const open = Boolean(
    opening?.[1] && /(?:^|\s)open(?:\s|$)/i.test(opening[1]!),
  );
  const summaryMatch = source.match(
    /<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i,
  );
  const closingIndex = matchingDetailsClose(source, opening?.index ?? 0);
  const bodyStart = summaryMatch
    ? (summaryMatch.index ?? 0) + summaryMatch[0].length
    : (opening?.[0].length ?? 0);
  const bodyEnd = closingIndex >= bodyStart ? closingIndex : source.length;
  const summary = summaryMatch?.[1] ?? "Details";
  const body = source.slice(bodyStart, bodyEnd).replace(/^\s+|\s+$/g, "");
  const summaryHtml = renderInlineSource(summary, state.profile, state);
  const bodyHtml = body ? renderSourceFragment(body, state.profile, state) : "";
  return `<details${open ? " open" : ""}><summary>${summaryHtml}</summary>${bodyHtml}</details>`;
}

function renderDescriptionList(source: string, state: RenderState): string {
  const lines = source
    .replace(/\r\n|\r/g, "\n")
    .trim()
    .split("\n");
  const parts: string[] = ["<dl>"];
  let term: string | null = null;
  for (const line of lines) {
    if (/^\s*:\s+/.test(line)) {
      if (term != null)
        parts.push(
          `<dt>${renderInlineSource(term, state.profile, state)}</dt>`,
        );
      const value = line.replace(/^\s*:\s+/, "");
      parts.push(`<dd>${renderInlineSource(value, state.profile, state)}</dd>`);
      term = null;
    } else {
      if (term != null)
        parts.push(
          `<dt>${renderInlineSource(term, state.profile, state)}</dt>`,
        );
      term = line.trim();
    }
  }
  if (term != null)
    parts.push(`<dt>${renderInlineSource(term, state.profile, state)}</dt>`);
  parts.push("</dl>");
  return parts.join("");
}

function renderToc(state: RenderState): string {
  const root = state.document;
  if (!root) return "";
  const items: string[] = [];
  root.descendants((heading, position) => {
    if (heading.type.name === "heading")
      items.push(
        `<li class="toc-level-${Number(heading.attrs.level) || 1}"><a href="#${escapeHtml(headingId(heading, state, root, position))}">${renderInline(heading, state)}</a></li>`,
      );
  });
  if (items.length === 0) return "";
  return `<nav class="table-of-contents" aria-label="Table of contents"><ul>${items.join("")}</ul></nav>`;
}

function collectFootnoteReferences(node: PMNode, state: RenderState): void {
  if (node.type.name === "raw_inline") {
    const kind = String(node.attrs.kind ?? "");
    if (kind === "footnote_ref" || kind === "footnote_anchor")
      registerFootnoteRef(String(node.attrs.source ?? ""), state);
  }
  node.forEach((child) => collectFootnoteReferences(child, state));
}

function renderFootnotes(state: RenderState): string {
  const definitions = new Map(
    state.footnotes.map((definition) => [definition.label, definition]),
  );
  const used = Array.from(state.footnoteNumbers.entries())
    .sort((left, right) => left[1] - right[1])
    .map(([label]) => definitions.get(label))
    .filter((definition): definition is FootnoteDefinition =>
      Boolean(definition),
    );
  if (used.length === 0) return "";
  const items = used
    .map((definition) => {
      const body = renderSourceFragment(
        definition.content,
        state.profile,
        state,
      );
      const count = state.footnoteRefs.get(definition.label) ?? 1;
      const backlinks = Array.from({ length: count }, (_, index) => {
        const suffix = index === 0 ? "" : `-${index + 1}`;
        return `<a href="#fnref-${escapeHtml(definition.label)}${suffix}" class="footnote-backref">↩</a>`;
      }).join(" ");
      return `<li id="fn-${escapeHtml(definition.label)}">${body}<p class="footnote-backrefs">${backlinks}</p></li>`;
    })
    .join("");
  return `<section class="footnotes" aria-label="Footnotes"><ol>${items}</ol></section>`;
}

function childrenWithPositions(
  node: PMNode,
  position: number,
): Array<{ node: PMNode; position: number }> {
  const children: Array<{ node: PMNode; position: number }> = [];
  const contentStart = position + (node.type.name === "doc" ? 0 : 1);
  node.forEach((child, offset) => {
    children.push({ node: child, position: contentStart + offset });
  });
  return children;
}

function renderChildren(
  node: PMNode,
  state: RenderState,
  root: PMNode,
  position: number,
  separator = "",
): string {
  return childrenWithPositions(node, position)
    .map((child) => renderNode(child.node, state, root, child.position))
    .join(separator);
}

function renderNode(
  node: PMNode,
  state: RenderState,
  root: PMNode,
  position: number,
): string {
  switch (node.type.name) {
    case "paragraph":
      return node.content.size === 0
        ? "<p><br></p>"
        : `<p>${renderInline(node, state)}</p>`;
    case "heading": {
      const level = Math.max(1, Math.min(6, Number(node.attrs.level) || 1));
      return `<h${level} id="${escapeHtml(headingId(node, state, root, position))}">${renderInline(node, state)}</h${level}>`;
    }
    case "blockquote":
      return `<blockquote>${renderChildren(node, state, root, position, "\n")}</blockquote>`;
    case "horizontal_rule":
      return "<hr>";
    case "code_block":
      return renderCodeBlock(node, state);
    case "details": {
      const parts = detailsSourceParts(node);
      const summary = renderInlineSource(
        String(node.attrs.summarySource ?? ""),
        state.profile,
        state,
      );
      return `<details${parts?.open ? " open" : ""}><summary>${summary}</summary>${renderChildren(node, state, root, position, "\n")}</details>`;
    }
    case "raw_inline":
      return renderRawInline(node, state);
    case "raw_block": {
      const source = String(node.attrs.source ?? "");
      const kind = String(node.attrs.kind ?? "unknown");
      if (kind === "blank-spacer")
        return '<div class="mm-blank-spacer" data-mm-blank-spacer="true" aria-hidden="true"></div>';
      if (kind === "html-comment" || /^\s*<!--[\s\S]*-->\s*$/.test(source))
        return "";
      if (kind === "alert") return renderAlert(source, state);
      if (kind === "details") return renderDetails(source, state);
      if (kind === "gitlab-toc") return renderToc(state);
      if (kind === "gitlab-description-list")
        return renderDescriptionList(source, state);
      if (kind === "math-block") {
        const math = state.renderMath?.(source, true) ?? null;
        if (math) return math;
      }
      if (
        kind === "protected-fence" ||
        kind === "directive" ||
        kind === "math-block"
      ) {
        const options: Record<string, unknown> = { profile: state.profile };
        if (kind === "math-block") options.language = "math";
        const advanced =
          state.renderAdvancedBlock?.(kind, source, options) ?? null;
        if (advanced) return advanced;
      }
      if (kind === "html") return renderSafeInlineHtml(source);
      const advanced =
        state.renderAdvancedBlock?.(kind, source, { profile: state.profile }) ??
        null;
      if (advanced) return advanced;
      return `<pre data-markdown-raw="true" data-kind="${escapeHtml(kind)}">${escapeHtml(source)}</pre>`;
    }
    case "bullet_list":
    case "ordered_list": {
      const ordered = node.type.name === "ordered_list";
      const start =
        ordered && Number(node.attrs.order) !== 1
          ? ` start="${Number(node.attrs.order)}"`
          : "";
      const taskList = childrenOf(node).some(
        (item) => item.attrs.checked != null,
      );
      const className = taskList ? ` class="contains-task-list"` : "";
      return `<${ordered ? "ol" : "ul"}${start}${className}>${renderChildren(node, state, root, position)}</${ordered ? "ol" : "ul"}>`;
    }
    case "list_item": {
      const task = node.attrs.checked as TaskState;
      const checkbox =
        task == null
          ? ""
          : `<input type="checkbox" disabled${task === true ? " checked" : ""}${task === "mixed" ? ' data-task-state="mixed" aria-checked="mixed"' : ""}> `;
      const className = task == null ? "" : ` class="task-list-item"`;
      return `<li${className}>${checkbox}${renderChildren(node, state, root, position)}</li>`;
    }
    case "table": {
      const rows = childrenWithPositions(node, position);
      if (rows.length === 0) return "<table></table>";
      const renderRow = (row: { node: PMNode; position: number }): string =>
        `<tr>${childrenWithPositions(row.node, row.position)
          .map((cell) => {
            const tag = cell.node.type.name === "table_header" ? "th" : "td";
            const alignment = cell.node.attrs.alignment;
            const style = alignment
              ? ` style="text-align:${escapeHtml(alignment)}"`
              : "";
            return `<${tag}${style}>${renderChildren(cell.node, state, root, cell.position)}</${tag}>`;
          })
          .join("")}</tr>`;
      const head = rows.filter(
        (row) => row.node.child(0)?.type.name === "table_header",
      );
      const body = rows.filter(
        (row) => row.node.child(0)?.type.name !== "table_header",
      );
      return `<table>${head.length ? `<thead>${head.map(renderRow).join("")}</thead>` : ""}${body.length ? `<tbody>${body.map(renderRow).join("")}</tbody>` : ""}</table>`;
    }
    case "table_row":
      return `<tr>${renderChildren(node, state, root, position)}</tr>`;
    case "table_cell":
      return `<td>${renderChildren(node, state, root, position)}</td>`;
    case "table_header":
      return `<th>${renderChildren(node, state, root, position)}</th>`;
    default:
      return escapeHtml(node.textContent);
  }
}

/** Render summary source with the same sanitisation policy as the preview. */
export function renderDetailsSummaryHtml(
  source: string,
  profile: Profile = "github",
): string {
  return renderInlineSource(source, profile);
}

function renderInlineSource(
  source: string,
  profile: Profile,
  state?: RenderState,
): string {
  const snapshot = parseMarkdown(source, profile);
  const local = state ?? createRenderState(profile, snapshot);
  if (state && state.footnotes.length === 0 && snapshot.footnotes)
    state.footnotes = snapshot.footnotes;
  const first = snapshot.doc.childCount > 0 ? snapshot.doc.child(0) : null;
  return first?.type.name === "paragraph"
    ? renderInline(first, local)
    : renderSourceFragment(source, profile, local);
}

/** Render the generated footnote section for an editor document. */
export function renderFootnotesHtml(
  doc: PMNode,
  profile: Profile = "github",
  input?: RenderInput,
): string {
  const state = createRenderState(profile, input ?? doc);
  state.document = doc;
  collectFootnoteReferences(doc, state);
  return renderFootnotes(state);
}

export interface HeadingAnchor {
  /** ProseMirror document position at which the heading starts. */
  position: number;
  /** Stable profile-specific slug used by heading links and TOC entries. */
  id: string;
}

/** Return heading positions and the exact ids used by the HTML renderer. */
export function headingAnchorIds(
  doc: PMNode,
  profile: Profile = "github",
): HeadingAnchor[] {
  const state = createRenderState(profile, doc);
  prepareHeadingIds(doc, state);
  const anchors: HeadingAnchor[] = [];
  doc.descendants((node, position) => {
    if (node.type.name === "heading")
      anchors.push({ position, id: headingId(node, state, doc, position) });
    return true;
  });
  return anchors;
}

/** Render an individual PM node, including rich source-preserving atoms. */
export function renderNodeHtml(
  node: PMNode,
  profile: Profile = "github",
  input?: RenderInput,
): string {
  const state = createRenderState(profile, input);
  if (node.type.name === "doc") {
    state.document = node;
    prepareHeadingIds(node, state);
    return renderChildren(node, state, node, 0, "\n") + renderFootnotes(state);
  }
  let root = node;
  let position = 0;
  if (state.document) {
    const suppliedPosition = state.nodePosition;
    if (
      suppliedPosition !== undefined &&
      Number.isInteger(suppliedPosition) &&
      suppliedPosition >= 0 &&
      suppliedPosition < state.document.content.size &&
      state.document.nodeAt(suppliedPosition) === node
    ) {
      root = state.document;
      position = suppliedPosition;
    } else if (suppliedPosition === undefined) {
      // Without an explicit position the first occurrence is the only one an
      // individual render call can identify. NodeViews supply getPos().
      state.document.descendants((child, childPosition) => {
        if (root === state.document) return false;
        if (child === node) {
          root = state.document!;
          position = childPosition;
          return false;
        }
        return true;
      });
    }
    prepareHeadingIds(state.document, state);
  }
  if (root !== state.document) prepareHeadingIds(root, state);
  registerFootnoteReferencesBeforeNode(state.document, node, state);
  return renderNode(node, state, root, position);
}

/** Render a PM document with profile-aware anchors, atoms, and footnotes. */
export function renderMarkdownDocument(
  doc: PMNode,
  profile: Profile = "github",
  input?: RenderInput,
): string {
  const state = createRenderState(profile, input ?? doc);
  state.document = doc;
  prepareHeadingIds(doc, state);
  return renderChildren(doc, state, doc, 0, "\n") + renderFootnotes(state);
}

/** Render an arbitrary Markdown source fragment using the shared renderer. */
export function renderSourceFragment(
  source: string,
  profile: Profile = "github",
  input?: RenderInput,
): string {
  const snapshot = parseMarkdown(source, profile);
  const state = createRenderState(profile, input ?? snapshot);
  if (state.footnotes.length === 0 && snapshot.footnotes)
    state.footnotes = snapshot.footnotes;
  const document = snapshot.doc;
  prepareHeadingIds(document, state);
  return (
    renderChildren(document, state, document, 0, "\n") +
    (input ? "" : renderFootnotes(state))
  );
}

/** Render a parsed Markdown document with the same safe HTML policy. */
export function renderMarkdownDocumentWithProfile(
  doc: PMNode,
  profile: Profile = "github",
  input?: RenderInput,
): string {
  return renderMarkdownDocument(doc, profile, input);
}

/** Parse and render Markdown without allowing raw HTML or unsafe URLs to execute. */
export function renderMarkdown(
  source: string,
  profile: Profile = "github",
): string {
  const snapshot = parseMarkdown(source, profile);
  return renderMarkdownDocument(snapshot.doc, profile, snapshot);
}

function walk(node: PMNode, visitor: (node: PMNode) => void): void {
  visitor(node);
  node.forEach((child) => walk(child, visitor));
}

/** Inspect constructs that require extension-specific handling or sanitisation. */
export function inspectCompatibility(
  source: string,
  profile: Profile = "github",
): CompatibilityDiagnostic[] {
  const snapshot = parseMarkdown(source, profile);
  const diagnostics: CompatibilityDiagnostic[] = [];
  const renderedBlockKinds = new Set([
    "alert",
    "details",
    "gitlab-toc",
    "gitlab-description-list",
    "math-block",
    "protected-fence",
    "blank-spacer",
  ]);
  for (const block of snapshot.blocks ?? []) {
    if (block.node.type.name !== "raw_block") continue;
    const kind = String(block.node.attrs.kind ?? "unknown");
    const raw = String(block.node.attrs.source ?? block.body ?? "");
    const commentOnly = /^\s*<!--[\s\S]*-->\s*$/.test(raw);
    if (kind === "html" && !commentOnly) {
      diagnostics.push({
        message: "Raw HTML is preserved and shown safely in preview.",
        severity: "warning",
        code: "raw-html",
        kind: "html",
        line: (block.startLine ?? 0) + 1,
      });
    } else if (!renderedBlockKinds.has(kind) && kind !== "html") {
      diagnostics.push({
        message: "This Markdown feature is preserved as source for editing.",
        severity: "info",
        code: "raw-block",
        kind,
        line: (block.startLine ?? 0) + 1,
      });
    }
  }
  walk(snapshot.doc, (node) => {
    if (
      node.type.name === "raw_inline" &&
      node.attrs.kind === "html" &&
      !/^\s*<!--[\s\S]*-->\s*$/.test(String(node.attrs.source ?? ""))
    ) {
      diagnostics.push({
        message: "Inline HTML is preserved and shown safely in preview.",
        severity: "warning",
        code: "raw-html-inline",
        kind: "html",
      });
    }
    if (node.type.name === "image") {
      if (!safeUrl(node.attrs.src, true))
        diagnostics.push({
          message: "The image URL is unsafe and will be shown as alt text.",
          severity: "warning",
          code: "unsafe-image-url",
          kind: "image",
        });
    }
    for (const mark of node.marks) {
      if (mark.type.name === "link" && !safeUrl(mark.attrs.href))
        diagnostics.push({
          message:
            "The link URL is unsafe and will be rendered without a link.",
          severity: "warning",
          code: "unsafe-link-url",
          kind: "link",
        });
    }
  });
  const unsafeDestination =
    /!?\[[^\]]*\]\(\s*(?:<\s*)?(javascript|vbscript|data):/gi;
  let unsafeMatch: RegExpExecArray | null;
  while ((unsafeMatch = unsafeDestination.exec(source)) != null) {
    const line = source.slice(0, unsafeMatch.index).split(/\r\n|\n|\r/).length;
    diagnostics.push({
      message: `Unsafe ${unsafeMatch[1]!.toLowerCase()} URL is kept as text and will not be activated.`,
      severity: "warning",
      code: "unsafe-url",
      kind: "url",
      line,
    });
  }
  if (
    profile === "commonmark" &&
    /(^|\n)\s*\|?.+\|.+\|?\s*(?:\n|$)/.test(source) &&
    /(^|\n)\s*\|?\s*-{3,}/.test(source)
  ) {
    diagnostics.push({
      message:
        "GFM table syntax is outside the CommonMark profile and is kept as source where needed.",
      severity: "info",
      code: "gfm-table",
      kind: "table",
    });
  }
  return diagnostics;
}

function semanticNode(node: PMNode, codeContext = false): unknown {
  if (node.isText) {
    const text = node.text ?? "";
    return {
      type: "text",
      text:
        codeContext || node.marks.some((mark) => mark.type.name === "code")
          ? text
          : text.replace(/[\t \r\n]+/g, " "),
      marks: node.marks.map((mark) => mark.toJSON()),
    };
  }
  const nextCodeContext =
    codeContext ||
    node.type.name === "code_block" ||
    node.type.name === "raw_block";
  const attrs = { ...node.attrs };
  return {
    type: node.type.name,
    attrs,
    marks: node.marks.map((mark) => mark.toJSON()),
    content: childrenOf(node).map((child) =>
      semanticNode(child, nextCodeContext),
    ),
  };
}

function semanticDocument(
  source: string,
  profile: Profile,
  ignoreTopLevelEmptyParagraphs = false,
): string {
  const snapshot = parseMarkdown(source, profile);
  if (!ignoreTopLevelEmptyParagraphs)
    return JSON.stringify(semanticNode(snapshot.doc));
  const children = childrenOf(snapshot.doc).filter(
    (node) => !isBlankSpacingNode(node),
  );
  const document = schema.topNodeType.create(
    null,
    children.length > 0 ? children : [emptyParagraph()],
  );
  return JSON.stringify(semanticNode(document));
}

function protectedSources(snapshot: MarkdownSnapshot): string[] {
  const result: string[] = [];
  walk(snapshot.doc, (node) => {
    if (isBlankSpacerNode(node)) return;
    const raw = normalisedRaw(node);
    if (raw) result.push(raw);
  });
  return result;
}

/**
 * Format Markdown with Prettier when available. If Prettier fails or changes
 * the PM structure/protected atoms, the original source is returned safely.
 * Top-level empty paragraphs are spacing representation and may be removed by
 * this explicit formatting operation.
 */
export async function formatMarkdown(
  source: string,
  options: PrettierOptions = {},
): Promise<string> {
  try {
    const profile =
      (options as { markdownProfile?: Profile }).markdownProfile ?? "github";
    const before = parseMarkdown(source, profile);
    const formatted = await prettier.format(source, {
      ...options,
      parser: "markdown",
      plugins: [markdownPrettierPlugin],
      proseWrap: options.proseWrap ?? "preserve",
      embeddedLanguageFormatting: "off",
      endOfLine:
        options.endOfLine ??
        (markdownLineEnding(source) === "crlf" ? "crlf" : "auto"),
    });
    if (typeof formatted !== "string")
      throw new Error(
        "Markdown formatting was skipped because Prettier returned no text.",
      );
    const after = parseMarkdown(formatted, profile);
    const beforeRaw = protectedSources(before).sort();
    const afterRaw = protectedSources(after).sort();
    if (JSON.stringify(beforeRaw) !== JSON.stringify(afterRaw)) {
      throw new Error(
        "Markdown formatting was skipped because protected source syntax would change.",
      );
    }
    if (
      semanticDocument(source, profile, true) !==
      semanticDocument(formatted, profile, true)
    ) {
      throw new Error(
        "Markdown formatting was skipped because the parsed document structure would change.",
      );
    }
    return formatted;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Markdown formatting was skipped")
    )
      throw error;
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`Markdown formatting was skipped${detail}`);
  }
}

export default schema;
