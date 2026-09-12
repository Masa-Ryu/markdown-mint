/** The alert kinds supported by the GitHub/GitLab blockquote syntax. */
export const ALERT_TYPES = [
  "NOTE",
  "TIP",
  "IMPORTANT",
  "WARNING",
  "CAUTION",
] as const;

export type AlertType = (typeof ALERT_TYPES)[number];

export interface AlertSourceParts {
  /** Alert body without blockquote prefixes, using LF internally. */
  readonly body: string;
  /** Source through and including the marker line, using LF internally. */
  readonly header: string;
  /** Prefix used when writing body lines back to the source. */
  readonly bodyPrefix: string;
  /** Line ending selected from the source for edited lines. */
  readonly lineEnding: string;
  /** Terminal line endings after the alert body. */
  readonly trailingLineEnding: string;
  /** Marker line without its blockquote prefix. */
  readonly markerLine: string;
  /** Normalized alert type, or NOTE when the marker is unavailable. */
  readonly marker: string;
  readonly markerIndex: number;
}

function stripAlertPrefix(line: string): string {
  return line.replace(/^\s*>[ \t]?/, "");
}

function alertMarkerIndex(lines: readonly string[]): number {
  const index = lines.findIndex((line) =>
    /^\s*>?[ \t]*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.test(line),
  );
  return index >= 0 ? index : 0;
}

function lineEndingFor(source: string): string {
  const first = source.match(/\r\n|\r|\n/)?.[0];
  return first ?? "\n";
}

function blockquotePrefix(line: string): string | undefined {
  return line.match(/^(\s*>[ \t]?)/)?.[1];
}

/**
 * Split an alert source slice into the marker, editable body, and separator.
 *
 * Markdown blockquotes allow a non-blank paragraph continuation line to omit
 * `>`. The caller supplies the source slice for one parsed top-level block, so
 * a non-blank unquoted line here is a lazy continuation; an unquoted blank line
 * is the first line outside the alert body. Quoted blank lines still match the
 * blockquote prefix and therefore remain editable body lines.
 */
export function parseAlertSource(source: string): AlertSourceParts {
  const lineEnding = lineEndingFor(source);
  const normalized = source.replace(/\r\n|\r/g, "\n");
  const lines = normalized.split("\n");
  const markerIndex = alertMarkerIndex(lines);
  const markerLine = lines[markerIndex] ?? "";
  const markerPrefix = blockquotePrefix(markerLine) ?? "";
  const bodySourceLines: string[] = [];

  for (let index = markerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (blockquotePrefix(line)) {
      bodySourceLines.push(line);
      continue;
    }
    // A non-blank line is a CommonMark lazy continuation of the paragraph
    // containing the alert marker. A blank line separates the blockquote from
    // the next top-level block (or is the source slice's terminal separator).
    if (line.trim() === "") break;
    bodySourceLines.push(line);
  }

  const firstBodyPrefix = bodySourceLines
    .map(blockquotePrefix)
    .find((prefix): prefix is string => prefix !== undefined);
  const bodyPrefix = firstBodyPrefix ?? markerPrefix;
  const body = bodySourceLines
    .map((line) => (blockquotePrefix(line) ? stripAlertPrefix(line) : line))
    .join("\n");
  const trailingMatch = normalized.match(/\n+$/);
  const trailingLineEnding = trailingMatch
    ? trailingMatch[0]!.replace(/\n/g, lineEnding)
    : "";
  const marker =
    stripAlertPrefix(markerLine)
      .match(/^\s*\[!([^\]]+)\]/i)?.[1]
      ?.toLowerCase() ?? "note";

  return {
    body,
    header: lines.slice(0, markerIndex + 1).join("\n"),
    bodyPrefix,
    lineEnding,
    trailingLineEnding,
    markerLine,
    marker,
    markerIndex,
  };
}

/** Rebuild an alert source slice while retaining its marker and line endings. */
export function alertSourceWithBody(source: string, body: string): string {
  const parts = parseAlertSource(source);
  const normalizedBody = body.replace(/\r\n|\r/g, "\n");
  const bodyLines = normalizedBody
    ? normalizedBody
        .split("\n")
        .map((line) => parts.bodyPrefix + line)
        .join(parts.lineEnding)
    : "";
  return (
    parts.header.replace(/\n/g, parts.lineEnding) +
    (bodyLines ? parts.lineEnding + bodyLines : "") +
    parts.trailingLineEnding
  );
}

/** Change only the alert marker while preserving every other source byte. */
export function alertSourceWithType(source: string, type: AlertType): string {
  const parts = parseAlertSource(source);
  const marker = `[!${type}]`;
  const lines = source.split(/(\r\n|\r|\n)/);
  let lineIndex = 0;

  for (let index = 0; index < lines.length; index += 2) {
    if (lineIndex !== parts.markerIndex) {
      lineIndex += 1;
      continue;
    }
    const line = lines[index] ?? "";
    const updated = line.replace(
      /\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i,
      marker,
    );
    if (updated === line) return source;
    lines[index] = updated;
    return lines.join("");
  }

  return source;
}
