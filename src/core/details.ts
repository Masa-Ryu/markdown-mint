import MarkdownIt from "markdown-it";
import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";
import type Token from "markdown-it/lib/token.mjs";

/** Exact source boundaries of a Details block. No HTML is decoded or rebuilt. */
export interface DetailsSourceParts {
  beforeSummary: string;
  summary: string;
  afterSummary: string;
  body: string;
  closing: string;
  open: boolean;
}

export interface DetailsTagRange {
  start: number;
  end: number;
  closing: boolean;
}

const detailsTagPattern = /^<\/?details\b(?:"[^"]*"|'[^']*'|[^'">])*>$/i;
const boundaryTagPattern =
  /^<\/?(?:details|summary)\b(?:"[^"]*"|'[^']*'|[^'">])*>$/i;

const scannerContext = Symbol("markdown-mint-details-blocks");
interface ScannerEnvironment {
  [scannerContext]?: { depth: number };
}
const configuredParsers = new WeakSet<MarkdownIt>();
const defaultParser = new MarkdownIt("commonmark", { html: true });

/**
 * Return only html_inline tokens which are themselves Details tags. The
 * inline parser already makes code spans, link destinations/titles and image
 * labels opaque, and its HTML rule consumes a complete quoted attribute. A
 * small push wrapper records the source position without re-parsing any tag.
 */
function detailsTagsInInlineContext(
  source: string,
  parser: MarkdownIt,
  offset = 0,
  pattern = detailsTagPattern,
): DetailsTagRange[] {
  const tokens: Token[] = [];
  const ranges: DetailsTagRange[] = [];
  const htmlTokens: Array<{ token: Token; start: number }> = [];
  const state = new parser.inline.State(source, parser, {}, tokens);
  const push = state.push.bind(state);
  state.push = ((type, tag, nesting) => {
    const start = state.pos;
    const token = push(type, tag, nesting);
    if (type === "html_inline") htmlTokens.push({ token, start });
    return token;
  }) as typeof state.push;
  // Post-processing only combines emphasis fragments; it cannot create or
  // remove html_inline tokens, so the first tokenization pass is sufficient.
  const html = parser.options.html;
  parser.options.html = true;
  try {
    parser.inline.tokenize(state);
  } finally {
    parser.options.html = html;
  }
  for (const { token, start } of htmlTokens) {
    if (!pattern.test(token.content)) continue;
    ranges.push({
      start: offset + start,
      end: offset + start + token.content.length,
      closing: /^<\//.test(token.content),
    });
  }
  return ranges;
}

/**
 * Details/summary wrappers are transparent only in this block-analysis pass.
 * All body blocks, including HTML types 1-7, still use markdown-it's rules.
 */
function detailsBoundary(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  const context = (state.env as ScannerEnvironment)[scannerContext];
  if (!context || state.sCount[startLine]! - state.blkIndent >= 4) return false;
  const start = state.bMarks[startLine]! + state.tShift[startLine]!;
  if (state.src.charCodeAt(start) !== 60) return false;
  const opening = /^<\/?(details|summary)\b(?:"[^"]*"|'[^']*'|[^'">])*>/i.exec(
    state.src.slice(start),
  );
  if (
    !opening ||
    (opening[1]!.toLowerCase() === "summary" && context.depth === 0)
  )
    return false;
  let nextLine = startLine + 1;
  const tagEnd = start + opening[0].length;
  while (nextLine < endLine && state.bMarks[nextLine]! < tagEnd) nextLine += 1;
  if (tagEnd > (state.bMarks[nextLine] ?? state.src.length)) return false;
  if (silent) return true;
  const token = state.push("markdown_mint_details_boundary", "", 0);
  token.map = [startLine, nextLine];
  token.content = state.getLines(startLine, nextLine, state.blkIndent, true);
  for (const tag of detailsTagsInInlineContext(token.content, state.md))
    context.depth = Math.max(0, context.depth + (tag.closing ? -1 : 1));
  state.line = nextLine;
  return true;
}

function prepareBlockScanner(parser: MarkdownIt): void {
  if (configuredParsers.has(parser)) return;
  const tokenize = parser.block.tokenize;
  parser.block.tokenize = (state, startLine, endLine): void => {
    const context = (state.env as ScannerEnvironment)[scannerContext];
    if (!context) return tokenize.call(parser.block, state, startLine, endLine);
    // markdown-it recursively tokenizes each quote/list container. Its local
    // Details wrappers cannot make a summary in a later container transparent.
    const enclosingDepth = context.depth;
    context.depth = 0;
    try {
      tokenize.call(parser.block, state, startLine, endLine);
    } finally {
      context.depth = enclosingDepth;
    }
  };
  parser.block.ruler.before(
    "html_block",
    "markdown_mint_details_boundary",
    detailsBoundary,
    {
      alt: ["paragraph", "reference", "blockquote"],
    },
  );
  configuredParsers.add(parser);
}

/**
 * Find candidate tags inside actual inline/header blocks. Opaque code and raw
 * HTML never reach the fine scanner, and code spans cannot escape their block.
 * A supplied parser retains the core profile's table/math block rules; the
 * extra rule is inactive during that parser's ordinary parse/render calls.
 */
export function detailsTagRanges(
  source: string,
  parser: MarkdownIt = defaultParser,
): DetailsTagRange[] {
  if (!/<\/?details\b/i.test(source)) return [];
  prepareBlockScanner(parser);
  const lineStarts = [0];
  const normalized = source
    .replace(/\r\n?|\n/g, (ending, index: number) => {
      lineStarts.push(index + ending.length);
      return "\n";
    })
    .replace(/\0/g, "\uFFFD");
  const tokens: Token[] = [];
  const html = parser.options.html;
  parser.options.html = true;
  try {
    parser.block.parse(
      normalized,
      parser,
      { [scannerContext]: { depth: 0 } },
      tokens,
    );
  } finally {
    parser.options.html = html;
  }
  const ranges: DetailsTagRange[] = [];
  for (const token of tokens) {
    // The fine scanner consumes a whole comment atomically, retaining genuine
    // markup after its terminator on the same line (an existing supported case).
    const comment =
      token.type === "html_block" && /^[\t ]*<!--/.test(token.content);
    if (
      !token.map ||
      (!comment &&
        !["inline", "markdown_mint_details_boundary"].includes(token.type))
    )
      continue;
    const start = lineStarts[token.map[0]] ?? source.length;
    const end = lineStarts[token.map[1]] ?? source.length;
    const contextSource = source.slice(start, end);
    if (!/<\/?details\b/i.test(contextSource)) continue;
    ranges.push(...detailsTagsInInlineContext(contextSource, parser, start));
  }
  return ranges;
}

/** Unsupported/malformed headers remain source-preserving raw nodes. */
export function parseDetailsSource(
  source: string,
  tags?: readonly DetailsTagRange[],
  parser: MarkdownIt = defaultParser,
): DetailsSourceParts | null {
  const ranges = tags ?? detailsTagRanges(source, parser);
  const first = ranges[0];
  if (!first || first.closing || source.slice(0, first.start).trim())
    return null;
  let depth = 0;
  let closing: DetailsTagRange | undefined;
  for (const tag of ranges) {
    depth += tag.closing ? -1 : 1;
    if (depth === 0) {
      closing = tag;
      break;
    }
  }
  if (!closing || source.slice(closing.end).trim()) return null;
  const interior = source.slice(first.end, closing.start);
  const summaryTags = detailsTagsInInlineContext(
    interior,
    parser,
    0,
    boundaryTagPattern,
  );
  const summaryOpen = summaryTags.find((tag) => {
    if (tag.closing || !/^<summary\b/i.test(interior.slice(tag.start, tag.end)))
      return false;
    return /^(?:\s|<!--[\s\S]*?-->)*$/i.test(interior.slice(0, tag.start));
  });
  if (!summaryOpen) return null;
  const summaryClose = summaryTags.find(
    (tag) =>
      tag.closing &&
      tag.start >= summaryOpen.end &&
      /^<\/summary\b/i.test(interior.slice(tag.start, tag.end)),
  );
  if (!summaryClose) return null;
  // A real Details/summary token inside the summary makes the header
  // unsupported. Attribute values, code spans, comments, links and images do
  // not produce such tokens and therefore remain valid source text.
  if (
    summaryTags.some(
      (tag) => tag.start >= summaryOpen.end && tag.start < summaryClose.start,
    )
  )
    return null;
  const summaryStart = first.end + summaryOpen.end;
  const summaryEnd = first.end + summaryClose.start;
  const bodyStart = first.end + summaryClose.end;
  const opening = source.slice(first.start, first.end);
  return {
    beforeSummary: source.slice(0, summaryStart),
    summary: source.slice(summaryStart, summaryEnd),
    afterSummary: source.slice(summaryEnd, bodyStart),
    body: source.slice(bodyStart, closing.start),
    closing: source.slice(closing.start),
    open: /\sopen(?:\s|=|>)/i.test(opening.replace(/"[^"]*"|'[^']*'/g, '""')),
  };
}
