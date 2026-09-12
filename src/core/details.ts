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

/** Ignore literal tags in fenced code, inline code, and HTML comments. */
export function detailsTagRanges(source: string): DetailsTagRange[] {
  const excluded: Array<{ start: number; end: number }> = [];
  const lines = /[^\r\n]*(?:\r\n|\r|\n|$)/g;
  let fence: { marker: string; start: number } | undefined;
  let line: RegExpExecArray | null;
  while ((line = lines.exec(source)) && line[0]) {
    const marker = line[0].match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (!marker) continue;
    if (!fence) fence = { marker, start: line.index };
    else if (
      marker[0] === fence.marker[0] &&
      marker.length >= fence.marker.length &&
      /^ {0,3}(?:`+|~+)[\t ]*(?:\r\n|\r|\n)?$/.test(line[0])
    ) {
      excluded.push({ start: fence.start, end: lines.lastIndex });
      fence = undefined;
    }
  }
  if (fence) excluded.push({ start: fence.start, end: source.length });
  for (const comment of source.matchAll(/<!--[\s\S]*?(?:-->|$)/g))
    excluded.push({
      start: comment.index,
      end: comment.index + comment[0].length,
    });
  const insideExcluded = (position: number): boolean =>
    excluded.some(({ start, end }) => position >= start && position < end);
  const tags = /`+|<\/?details\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi;
  const ranges: DetailsTagRange[] = [];
  let match: RegExpExecArray | null;
  while ((match = tags.exec(source))) {
    if (insideExcluded(match.index)) continue;
    if (match[0].startsWith("`")) {
      const marker = match[0];
      let end = source.indexOf(marker, tags.lastIndex);
      while (
        end >= 0 &&
        (source[end - 1] === "`" || source[end + marker.length] === "`")
      )
        end = source.indexOf(marker, end + marker.length);
      if (end >= 0) tags.lastIndex = end + marker.length;
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
