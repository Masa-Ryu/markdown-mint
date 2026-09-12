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

/** Ignore literal tags in fenced code, inline code, and HTML comments. */
export function detailsTagRanges(source: string): DetailsTagRange[] {
  // Consume each code/comment region before scanning the following source.
  // A comment marker inside code is literal, as is a fence inside a comment.
  const tags =
    /(^ {0,3}(?:`{3,}[^`\r\n]*|~{3,}[^\r\n]*)(?:\r\n|\r|\n|$))|`+|<!--|<\/?details\b(?:"[^"]*"|'[^']*'|[^'">])*>/gim;
  const ranges: DetailsTagRange[] = [];
  let match: RegExpExecArray | null;
  while ((match = tags.exec(source))) {
    if (match[1]) {
      const marker = match[1].trimStart().match(/^`+|^~+/)![0];
      const closingFence = new RegExp(
        `^ {0,3}${marker[0]}{${marker.length},}[\\t ]*(?:\\r\\n|\\r|\\n|$)`,
        "gm",
      );
      closingFence.lastIndex = tags.lastIndex;
      tags.lastIndex = closingFence.exec(source)
        ? closingFence.lastIndex
        : source.length;
      continue;
    }
    if (isBackslashEscaped(source, match.index)) {
      // Only the first punctuation character is escaped. Remaining backticks
      // can still open a shorter code span, as in \``code`.
      tags.lastIndex = match.index + 1;
      continue;
    }
    if (match[0] === "<!--") {
      const end = source.indexOf("-->", tags.lastIndex);
      tags.lastIndex = end >= 0 ? end + 3 : source.length;
      continue;
    }
    if (match[0].startsWith("`")) {
      const marker = match[0];
      // A code span cannot cross a blank line into another paragraph. Treat
      // CRLF as one line ending, and backslashes inside code as literal text.
      const codeEnds = /`+|(?:\r\n|\r(?!\n)|\n)[\t ]*(?:\r\n?|\n)/g;
      codeEnds.lastIndex = tags.lastIndex;
      let candidate: RegExpExecArray | null;
      while ((candidate = codeEnds.exec(source))) {
        if (!candidate[0].startsWith("`")) break;
        if (candidate[0] === marker) {
          tags.lastIndex = codeEnds.lastIndex;
          break;
        }
      }
      continue;
    }
    ranges.push({
      start: match.index,
      end: tags.lastIndex,
      closing: /^<\//.test(match[0]),
    });
  }
  return ranges;
}

/** Unsupported/malformed headers remain source-preserving raw nodes. */
export function parseDetailsSource(source: string): DetailsSourceParts | null {
  const tags = detailsTagRanges(source);
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
