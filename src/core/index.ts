import MarkdownIt from "markdown-it";
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

/** The Markdown dialect used by the editor and preview. */
export type Profile = "github" | "gitlab" | "commonmark";

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
  /** The complete original slice, including the separator after this block. */
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
  leading?: string;
  trailing?: string;
  lineEnding: "lf" | "crlf" | "mixed" | "none";
  [mapping: string]: unknown;
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
            (dom as HTMLElement).getAttribute("data-checked") === "true"
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

function attrsOf(token: MarkdownToken): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of token.attrs ?? []) {
    result[pair[0]] = pair[1];
  }
  return result;
}

function tokenText(token: MarkdownToken): string {
  return token.content ?? "";
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
  const crlf = (source.match(/\r\n/g) ?? []).length;
  const lf = (source.match(/(?<!\r)\n/g) ?? []).length;
  const cr = (source.match(/\r(?!\n)/g) ?? []).length;
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

function rawInline(source: string, kind: string): PMNode {
  return nodeTypes.raw_inline.create({ source, kind });
}

function parseInline(children: MarkdownToken[] | null | undefined): PMNode[] {
  if (!children || children.length === 0) return [];
  const output: PMNode[] = [];
  const markStack: Mark[] = [];
  const pushText = (value: string): void => {
    if (!value) return;
    output.push(schema.text(value, markStack));
  };
  for (const child of children) {
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
          schema.text(tokenText(child), [
            ...markStack,
            markTypes.code.create(),
          ]),
        );
        break;
      case "text":
      case "entity":
      case "escape":
      case "html_entity":
        pushText(tokenText(child));
        break;
      case "softbreak":
        pushText("\n");
        break;
      case "hardbreak":
        output.push(nodeTypes.hard_break.create());
        break;
      case "image":
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
            },
            null,
            markStack,
          ),
        );
        break;
      case "html_inline":
        if (/^<br\s*\/?>$/i.test(tokenText(child).trim()))
          output.push(nodeTypes.hard_break.create());
        else output.push(rawInline(tokenText(child), "html"));
        break;
      case "math_inline":
      case "footnote_ref":
      case "footnote_anchor":
        output.push(rawInline(tokenText(child), child.type));
        break;
      default:
        // Keeping an unrecognised inline token visible is safer than dropping
        // source that an extension may understand.
        pushText(tokenText(child) || child.markup || child.type);
        break;
    }
  }
  return output;
}

function paragraphFromInline(token: MarkdownToken | undefined): PMNode {
  const content = parseInline(token?.children);
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

function taskInfo(
  children: PMNode[],
  profile: Profile,
): { checked: boolean | null; children: PMNode[] } {
  if (profile === "commonmark") return { checked: null, children };
  const firstParagraph = children.find(
    (child) => child.type.name === "paragraph",
  );
  const firstText = firstParagraph ? firstTextNode(firstParagraph) : undefined;
  if (!firstText || !firstText.text) return { checked: null, children };
  const match = firstText.text.match(/^\[([ xX])\][ \t]+/);
  if (!match) return { checked: null, children };
  const checked = match[1]!.toLowerCase() === "x";
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
          const paragraph = paragraphFromInline(inline);
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
  if (
    /^(?:mermaid|math|latex|tex|asciimath|mdx|jsx|tsx|html|frontmatter|yaml)$/.test(
      info,
    )
  )
    return true;
  const raw = sourceForToken(token, source, offsets).trimStart();
  return (
    /^```+\s*(?:mermaid|math|latex|tex)\b/i.test(raw) ||
    /^~~~+\s*(?:mermaid|math|latex|tex)\b/i.test(raw)
  );
}

function protectedBlockText(raw: string): boolean {
  const trimmed = raw.trimStart();
  return (
    /^:::[A-Za-z]/.test(trimmed) ||
    /^>\s*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/im.test(raw) ||
    /^\s*\$\$/.test(trimmed)
  );
}

function parseBlocks(
  tokens: MarkdownToken[],
  begin: number,
  end: number,
  source = "",
  offsets: number[] = [],
  profile: Profile = "github",
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
        result.push(paragraphFromInline(inline));
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
        const content = parseInline(inline?.children);
        result.push(nodeTypes.heading.create({ level }, content));
        index = close + 1;
        break;
      }
      case "blockquote_open": {
        const close = findClosing(tokens, index, "blockquote_open", end);
        result.push(
          nodeTypes.blockquote.create(
            null,
            parseBlocks(tokens, index + 1, close, source, offsets, profile),
          ),
        );
        index = close + 1;
        break;
      }
      case "bullet_list_open": {
        const close = findClosing(tokens, index, "bullet_list_open", end);
        result.push(
          parseList(tokens, index, close, false, source, offsets, profile),
        );
        index = close + 1;
        break;
      }
      case "ordered_list_open": {
        const close = findClosing(tokens, index, "ordered_list_open", end);
        result.push(
          parseList(tokens, index, close, true, source, offsets, profile),
        );
        index = close + 1;
        break;
      }
      case "table_open": {
        const close = findClosing(tokens, index, "table_open", end);
        result.push(parseTable(tokens, index, close));
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
        const content = tokenText(token)
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
          result.push(
            nodeTypes.raw_block.create({
              source: rawSource || tokenText(token),
              kind: "protected-fence",
            }),
          );
        } else {
          const params = token.info?.trim() ?? "";
          const content = tokenText(token)
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

function parseInternal(source: string, profile: Profile): MarkdownSnapshot {
  const md = createMarkdownIt(profile);
  const tokens = md.parse(source, {}) as unknown as MarkdownToken[];
  const offsets = lineOffsets(source);
  const roots = tokens
    .map((token, index) => (isRootStart(token) ? index : -1))
    .filter((index) => index >= 0);
  const nodes: PMNode[] = [];
  const blocks: MarkdownBlockSnapshot[] = [];
  let leading = "";
  if (roots.length > 0) {
    const firstLocation = tokenLocation(tokens[roots[0]!]!, source, offsets);
    leading = source.slice(0, firstLocation.start);
    for (let root = 0; root < roots.length; root += 1) {
      const token = tokens[roots[root]!]!;
      const nextToken =
        roots[root + 1] == null ? undefined : tokens[roots[root + 1]!]!;
      const location = tokenLocation(token, source, offsets);
      const nextLocation = nextToken
        ? tokenLocation(nextToken, source, offsets)
        : null;
      const nextStart = nextLocation?.start ?? source.length;
      const bodyEnd = Math.max(
        location.start,
        Math.min(location.end, nextStart),
      );
      const body = source.slice(location.start, bodyEnd);
      const separator = source.slice(bodyEnd, nextStart);
      const parsed = parseBlocks(
        tokens,
        roots[root]!,
        roots[root + 1] ?? tokens.length,
        source,
        offsets,
        profile,
      );
      const node =
        parsed[0] ??
        nodeTypes.raw_block.create({ source: body, kind: "unknown" });
      nodes.push(node);
      blocks.push({
        node,
        source: body + separator,
        body,
        separator,
        startLine: location.startLine,
        endLine: location.endLine,
        kind: node.type.name,
      });
      // A blockquote alert/directive is a valid Markdown-it tree, but its
      // semantics are extension-owned. Keep its source opaque.
      const fullRaw = source.slice(location.start, nextStart);
      if (node.type.name === "blockquote" && protectedBlockText(fullRaw)) {
        const raw = nodeTypes.raw_block.create({
          source: fullRaw,
          kind: "alert",
        });
        nodes[nodes.length - 1] = raw;
        blocks[blocks.length - 1]!.node = raw;
        blocks[blocks.length - 1]!.kind = "alert";
      }
      if (node.type.name === "paragraph" && protectedBlockText(fullRaw)) {
        const raw = nodeTypes.raw_block.create({
          source: fullRaw,
          kind: "directive",
        });
        nodes[nodes.length - 1] = raw;
        blocks[blocks.length - 1]!.node = raw;
        blocks[blocks.length - 1]!.kind = "directive";
      }
    }
  } else if (source.length > 0) {
    const raw = nodeTypes.raw_block.create({ source, kind: "unparsed" });
    nodes.push(raw);
    blocks.push({
      node: raw,
      source,
      body: source,
      separator: "",
      startLine: 0,
      endLine: offsets.length,
      kind: "unparsed",
    });
  }
  const doc = schema.topNodeType.create(
    null,
    nodes.length > 0 ? nodes : [emptyParagraph()],
  );
  const last = blocks[blocks.length - 1];
  const trailing = last
    ? source.slice(
        last.startLine == null
          ? source.length
          : offsetForLine(offsets, last.endLine, source.length),
      )
    : source;
  const snapshot: MarkdownSnapshot = {
    doc,
    source,
    profile,
    blocks,
    leading,
    trailing,
    lineEnding: markdownLineEnding(source),
  };
  return snapshot;
}

/** Parse Markdown into the shared ProseMirror document model. */
export function parseMarkdown(
  source: string,
  profile: Profile = "github",
): MarkdownSnapshot {
  const frontmatter = detectFrontmatter(source);
  if (!frontmatter) return parseInternal(source, profile);

  const frontSource = source.slice(frontmatter.start, frontmatter.end);
  const restSource = source.slice(frontmatter.end);
  const rest = parseInternal(restSource, profile);
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
    profile,
  };
  return snapshot;
}

function escapeMarkdownText(value: string, table = false): string {
  let result = value.replace(/\\/g, "\\\\");
  let escaped = "";
  // Escape punctuation that can change a paragraph's block shape when a
  // user inserts it at the beginning of a line (headings, lists, quotes,
  // thematic breaks, directives, and setext headings). Escaping is valid in
  // all inline contexts and keeps parse(serialize(doc)) structurally stable.
  const markdownPunctuation = "`*_[]<>#-+.!~$:=&()";
  let lineStart = true;
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

function codeFenceFor(value: string, preferred = "```"): string {
  const runs = value.match(/`+/g) ?? [];
  const longest = Math.max(0, ...runs.map((run) => run.length));
  const count = Math.max(preferred.length, longest + 1);
  return "`".repeat(Math.max(preferred.length, count));
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
  if (/\s|[()<>]/.test(compact)) return `<${compact.replace(/[<>]/g, "")}>`;
  let escaped = compact.replace(/[\\()]/g, "\\$&");
  if (table) escaped = escaped.replace(/\|/g, "\\|");
  return escaped;
}

function serializeInlineMarked(node: PMNode, table: boolean): string {
  const children = childrenOf(node);
  let output = "";
  let active: Mark[] = [];
  const delimiter = (mark: Mark): string => {
    if (mark.type.name === "strong") return "**";
    if (mark.type.name === "em") return "*";
    if (mark.type.name === "strike") return "~~";
    return "";
  };
  const regularMarks = (child: PMNode): Mark[] => {
    const marks = child.marks.filter(
      (mark) => mark.type.name !== "code" && mark.type.name !== "link",
    );
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
    active = active.slice(0, common);
    for (let index = common; index < target.length; index += 1) {
      output += delimiter(target[index]!);
      active.push(target[index]!);
    }
  };
  for (const child of children) {
    if (child.isText) {
      const targetMarks = regularMarks(child);
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
        output += escapeMarkdownText(leadingBreaks, table);
        value = value.slice(leadingBreaks.length);
      }
      if (!value) {
        closeTo([]);
        continue;
      }
      closeTo(targetMarks);
      const code = child.marks.some((mark) => mark.type.name === "code");
      let text = code
        ? serializeCodeSpan(value, table)
        : escapeMarkdownText(value, table);
      const link = child.marks.find((mark) => mark.type.name === "link");
      if (link) {
        const title = link.attrs.title
          ? ` "${String(link.attrs.title).replace(/"/g, '\\"')}"`
          : "";
        text = `[${text}](${escapeLinkDestination(link.attrs.href, table)}${title})`;
      }
      output += text;
    } else {
      closeTo([]);
      if (child.type.name === "hard_break") output += "<br>";
      else if (child.type.name === "image") {
        const alt = String(child.attrs.alt ?? "")
          .replace("[", "\\[")
          .replace("]", "\\]");
        const title = child.attrs.title
          ? ` "${String(child.attrs.title).replace(/"/g, '\\"')}"`
          : "";
        output += `![${alt}](${escapeLinkDestination(child.attrs.src, table)}${title})`;
      } else if (child.type.name === "raw_inline") output += child.attrs.source;
      else output += serializeInlineMarked(child, table);
    }
  }
  closeTo([]);
  return output;
}

function serializeInline(node: PMNode, table = false): string {
  return serializeInlineMarked(node, table);
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
  value = value.replace(/\r?\n/g, "<br>").trim();
  return value || " ";
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
    case "raw_block":
      return String(node.attrs.source ?? "").replace(/(?:\r\n|\n|\r)+$/, "");
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

function serializeListItem(item: PMNode, marker: string): string {
  const task = item.attrs.checked;
  const content = childrenOf(item)
    .map((child) => serializeBlock(child))
    .join("\n\n");
  const taskPrefix = task == null ? "" : task ? "[x] " : "[ ] ";
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

function referenceDefinitions(value: string): ReferenceDefinitionSnapshot[] {
  const result: ReferenceDefinitionSnapshot[] = [];
  const pattern = /^[ \t]{0,3}\[([^\]\r\n]+)\]:[^\r\n]*(?:\r\n|\n|\r|$)/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) != null) {
    const source = match[0].replace(/(?:\r\n|\n|\r)$/, "");
    const label = referenceLabel(match[1] ?? "");
    if (label && !result.some((entry) => entry.label === label))
      result.push({ label, source });
  }
  return result;
}

function previousReferenceDefinitions(
  previous: MarkdownSnapshot,
): ReferenceDefinitionSnapshot[] {
  const sources = [previous.leading ?? ""];
  for (const block of previous.blocks ?? []) {
    // Definitions embedded in code and opaque atoms are literal content, not
    // reference definitions.  Everything else can contain a valid definition
    // in its source slice, including the separator after a paragraph.
    if (
      block.node.type.name !== "code_block" &&
      block.node.type.name !== "raw_block"
    )
      sources.push(block.source);
  }
  sources.push(previous.trailing ?? "");
  const result: ReferenceDefinitionSnapshot[] = [];
  for (const source of sources) {
    for (const definition of referenceDefinitions(source)) {
      if (!result.some((entry) => entry.label === definition.label))
        result.push(definition);
    }
  }
  return result;
}

function preserveReferenceDefinitions(
  output: string,
  previous: MarkdownSnapshot,
  ending: "\n" | "\r\n",
): string {
  const definitions = previousReferenceDefinitions(previous);
  if (definitions.length === 0) return output;
  const existing = new Set(
    referenceDefinitions(output).map((definition) => definition.label),
  );
  const missing = definitions.filter(
    (definition) => !existing.has(definition.label),
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
  for (let index = 0; index < previous.length; index += 1) {
    const key = nodeFingerprint(previous[index]!.node);
    const list = candidates.get(key);
    if (list) list.push(index);
    else candidates.set(key, [index]);
  }
  const matches = new Map<number, number>();
  let previousCursor = -1;
  const cursors = new Map<string, number>();
  for (let index = 0; index < current.length; index += 1) {
    const key = nodeFingerprint(current[index]!);
    const list = candidates.get(key);
    if (!list) continue;
    let cursor = cursors.get(key) ?? 0;
    while (cursor < list.length && list[cursor]! <= previousCursor) cursor += 1;
    if (cursor >= list.length) {
      cursors.set(key, cursor);
      continue;
    }
    const candidate = list[cursor]!;
    cursors.set(key, cursor + 1);
    matches.set(index, candidate);
    previousCursor = candidate;
  }
  return matches;
}

function normalisedRaw(node: PMNode): string {
  if (node.type.name === "raw_block" || node.type.name === "raw_inline")
    return String(node.attrs.source ?? "");
  return "";
}

/**
 * Serialize a ProseMirror document. If a snapshot is supplied, exact source
 * slices are reused for unchanged top-level nodes, including their line
 * endings and surrounding blank lines.
 */
export function serializeMarkdown(
  doc: PMNode,
  previous?: MarkdownSnapshot,
): string {
  if (previous?.doc && doc.eq(previous.doc)) return previous.source;
  const children = childrenOf(doc);
  const blocks = previous?.blocks ?? [];
  if (blocks.length === 0) {
    const serialized = children
      .map((node) => serializeBlock(node))
      .join("\n\n");
    const last = children[children.length - 1];
    if (last?.type.name === "raw_block") {
      const rawEnding = lineBreakSuffix(String(last.attrs.source ?? ""));
      if (rawEnding) {
        const ending = rawEnding.includes("\r\n")
          ? "\r\n"
          : rawEnding.includes("\r")
            ? "\r"
            : "\n";
        return serialized + ending;
      }
    }
    return serialized;
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
  let output = leading;
  for (let index = 0; index < children.length; index += 1) {
    const node = children[index]!;
    const matched = matches.get(index);
    if (matched != null) {
      output += blocks[matched]!.source;
      continue;
    }

    const samePosition = blocks[index];
    const insertion = !samePosition || nextMatchedPrevious[index] === index;
    if (index > 0 && !output.endsWith(`${ending}${ending}`)) {
      output += output.endsWith(ending) ? ending : `${ending}${ending}`;
    }
    const generated = toLineEnding(serializeBlock(node), ending);
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
  }
  if (children.length === 0 && previous?.trailing) output += previous.trailing;
  return previous
    ? preserveReferenceDefinitions(output, previous, ending)
    : output;
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

function renderInline(node: PMNode): string {
  let output = "";
  node.forEach((child) => {
    if (child.isText) {
      let value = escapeHtml(child.text ?? "");
      for (const mark of child.marks) {
        if (mark.type.name === "code") value = `<code>${value}</code>`;
        else if (mark.type.name === "strong")
          value = `<strong>${value}</strong>`;
        else if (mark.type.name === "em") value = `<em>${value}</em>`;
        else if (mark.type.name === "strike") value = `<del>${value}</del>`;
        else if (mark.type.name === "link") {
          const href = safeUrl(mark.attrs.href);
          if (href)
            value = `<a href="${escapeHtml(href)}"${mark.attrs.title ? ` title="${escapeHtml(mark.attrs.title)}"` : ""}>${value}</a>`;
        }
      }
      output += value;
    } else if (child.type.name === "hard_break") output += "<br>\n";
    else if (child.type.name === "image") {
      const src = safeUrl(child.attrs.src, true);
      if (src) {
        output += `<img src="${escapeHtml(src)}" alt="${escapeHtml(child.attrs.alt ?? "")}"${child.attrs.title ? ` title="${escapeHtml(child.attrs.title)}"` : ""}>`;
      } else output += escapeHtml(child.attrs.alt ?? "");
    } else if (child.type.name === "raw_inline") {
      output += `<span data-markdown-raw="true" data-kind="${escapeHtml(child.attrs.kind)}">${escapeHtml(child.attrs.source)}</span>`;
    } else output += renderInline(child);
  });
  return output;
}

function renderNode(node: PMNode): string {
  switch (node.type.name) {
    case "paragraph":
      return `<p>${renderInline(node)}</p>`;
    case "heading":
      return `<h${node.attrs.level}>${renderInline(node)}</h${node.attrs.level}>`;
    case "blockquote":
      return `<blockquote>${childrenOf(node).map(renderNode).join("\n")}</blockquote>`;
    case "horizontal_rule":
      return "<hr>";
    case "code_block": {
      const params =
        String(node.attrs.params ?? "")
          .trim()
          .split(/\s+/, 1)[0] ?? "";
      const className = /^[A-Za-z0-9_+.-]+$/.test(params)
        ? ` class="language-${escapeHtml(params)}"`
        : "";
      return `<pre><code${className}>${escapeHtml(node.textContent)}</code></pre>`;
    }
    case "raw_block":
      return `<pre data-markdown-raw="true" data-kind="${escapeHtml(node.attrs.kind)}">${escapeHtml(node.attrs.source)}</pre>`;
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
      return `<${ordered ? "ol" : "ul"}${start}${className}>${childrenOf(node).map(renderNode).join("")}</${ordered ? "ol" : "ul"}>`;
    }
    case "list_item": {
      const task = node.attrs.checked;
      const checkbox =
        task == null
          ? ""
          : `<input type="checkbox" disabled${task ? " checked" : ""}> `;
      const className = task == null ? "" : ` class="task-list-item"`;
      return `<li${className}>${checkbox}${childrenOf(node).map(renderNode).join("")}</li>`;
    }
    case "table": {
      const rows = childrenOf(node);
      const head = rows[0]!;
      const body = rows.slice(1);
      const renderRow = (row: PMNode): string =>
        `<tr>${childrenOf(row)
          .map((cell) => {
            const tag = cell.type.name === "table_header" ? "th" : "td";
            const alignment = cell.attrs.alignment;
            const style = alignment
              ? ` style="text-align:${escapeHtml(alignment)}"`
              : "";
            return `<${tag}${style}>${childrenOf(cell).map(renderNode).join("")}</${tag}>`;
          })
          .join("")}</tr>`;
      return `<table><thead>${renderRow(head)}</thead>${body.length ? `<tbody>${body.map(renderRow).join("")}</tbody>` : ""}</table>`;
    }
    case "table_row":
      return `<tr>${childrenOf(node).map(renderNode).join("")}</tr>`;
    case "table_cell":
      return `<td>${childrenOf(node).map(renderNode).join("")}</td>`;
    case "table_header":
      return `<th>${childrenOf(node).map(renderNode).join("")}</th>`;
    default:
      return escapeHtml(node.textContent);
  }
}

/** Render a ProseMirror document using the same safe renderer as renderMarkdown. */
export function renderMarkdownDocument(doc: PMNode): string {
  return childrenOf(doc).map(renderNode).join("\n");
}

/** Parse and render Markdown without allowing raw HTML or unsafe URLs to execute. */
export function renderMarkdown(
  source: string,
  profile: Profile = "github",
): string {
  return renderMarkdownDocument(parseMarkdown(source, profile).doc);
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
  for (const block of snapshot.blocks ?? []) {
    if (
      block.kind === "html" ||
      (block.node.type.name === "raw_block" && block.node.attrs.kind === "html")
    ) {
      diagnostics.push({
        message: "Raw HTML is preserved as source and escaped in preview.",
        severity: "warning",
        code: "raw-html",
        kind: "html",
        line: (block.startLine ?? 0) + 1,
      });
    } else if (block.node.type.name === "raw_block") {
      diagnostics.push({
        message: "This block is preserved as an opaque source atom.",
        severity: "warning",
        code: "raw-block",
        kind: String(block.node.attrs.kind),
        line: (block.startLine ?? 0) + 1,
      });
    }
  }
  walk(snapshot.doc, (node) => {
    if (node.type.name === "raw_inline" && node.attrs.kind === "html") {
      diagnostics.push({
        message: "Inline HTML is preserved as source and escaped in preview.",
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

function semanticDocument(source: string, profile: Profile): string {
  const snapshot = parseMarkdown(source, profile);
  return JSON.stringify(semanticNode(snapshot.doc));
}

function protectedSources(snapshot: MarkdownSnapshot): string[] {
  const result: string[] = [];
  walk(snapshot.doc, (node) => {
    const raw = normalisedRaw(node);
    if (raw) result.push(raw);
  });
  return result;
}

/**
 * Format Markdown with Prettier when available. If Prettier fails or changes
 * the PM structure/protected atoms, the original source is returned safely.
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
      semanticDocument(source, profile) !==
      JSON.stringify(semanticNode(after.doc))
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
