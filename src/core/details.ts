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

function isBackslashEscaped(source: string, index: number): boolean {
  let count = 0;
  while (index > 0 && source[--index] === "\\") count += 1;
  return count % 2 === 1;
}

/** Scan only one inline/header context supplied by the Markdown block parser. */
function tagsInContext(source: string, offset = 0): DetailsTagRange[] {
  const candidates = /`+|<!--|<\/?details\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi;
  const ranges: DetailsTagRange[] = [];
  let match: RegExpExecArray | null;
  while ((match = candidates.exec(source))) {
    if (isBackslashEscaped(source, match.index)) {
      // Only the first character is escaped; the remaining delimiter run may
      // still begin code. Backslashes inside accepted code/comments are literal.
      candidates.lastIndex = match.index + 1;
      continue;
    }
    if (match[0] === "<!--") {
      const end = source.indexOf("-->", candidates.lastIndex);
      candidates.lastIndex = end >= 0 ? end + 3 : source.length;
      continue;
    }
    if (match[0].startsWith("`")) {
      const closers = /`+/g;
      closers.lastIndex = candidates.lastIndex;
      let closer: RegExpExecArray | null;
      while ((closer = closers.exec(source))) {
        if (closer[0] === match[0]) {
          candidates.lastIndex = closers.lastIndex;
          break;
        }
      }
      continue;
    }
    ranges.push({
      start: offset + match.index,
      end: offset + candidates.lastIndex,
      closing: /^<\//.test(match[0]),
    });
  }
  return ranges;
}

const scannerContext = Symbol("markdown-mint-details-blocks");
interface ScannerEnvironment {
  [scannerContext]?: { depth: number };
}
const configuredParsers = new WeakSet<MarkdownIt>();
const defaultParser = new MarkdownIt("commonmark");

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
  for (const tag of tagsInContext(token.content))
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
  parser.block.parse(
    normalized,
    parser,
    { [scannerContext]: { depth: 0 } },
    tokens,
  );
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
    ranges.push(...tagsInContext(source.slice(start, end), start));
  }
  return ranges;
}

/** Unsupported/malformed headers remain source-preserving raw nodes. */
export function parseDetailsSource(
  source: string,
  tags: readonly DetailsTagRange[] = detailsTagRanges(source),
): DetailsSourceParts | null {
  const first = tags[0];
  if (!first || first.closing || source.slice(0, first.start).trim())
    return null;
  let depth = 0;
  let closing: DetailsTagRange | undefined;
  for (const tag of tags) {
    depth += tag.closing ? -1 : 1;
    if (depth === 0) {
      closing = tag;
      break;
    }
  }
  if (!closing || source.slice(closing.end).trim()) return null;
  const interior = source.slice(first.end, closing.start);
  const summary = interior.match(
    /^(?:\s|<!--[\s\S]*?-->)*<summary\b(?:"[^"]*"|'[^']*'|[^'">])*>([\s\S]*?)<\/summary\s*>/i,
  );
  if (!summary) return null;
  // Locate using the closing tag, so an empty or repeated summary is exact.
  const summaryClose = summary[0].match(/<\/summary\s*>$/i)!;
  const summaryEnd = first.end + summary[0].length - summaryClose[0].length;
  const summaryStart = summaryEnd - summary[1]!.length;
  if (/<\/?(?:details|summary)\b/i.test(summary[1]!)) return null;
  const bodyStart = first.end + summary[0].length;
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
