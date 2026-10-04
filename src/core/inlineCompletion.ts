import { type Slice, type Node as PMNode } from "prosemirror-model";
import type { Profile } from "./index";

export interface CompletionInputMatch {
  readonly acceptedLength: number;
  readonly remaining: string;
}
export interface CompletionInsertionPlan {
  readonly insertion: string;
  readonly slice: Slice;
  readonly markdown: string;
  readonly start: number;
  readonly end: number;
}
export interface CompletionParser {
  parseMarkdown(source: string, profile: Profile): { doc: PMNode };
}

/** Return the remaining completion only when ordinary input matches its prefix. */
export function matchCompletionInput(
  remaining: string,
  typed: string,
): CompletionInputMatch | undefined {
  if (!typed || !remaining.startsWith(typed)) return undefined;
  return {
    acceptedLength: typed.length,
    remaining: remaining.slice(typed.length),
  };
}

/**
 * Parse both marker-anchored alternatives and prove that existing source on
 * each side keeps the same PM structure, marks, and text. The returned slice
 * is ordinary editor content and goes through the existing transaction path.
 */
export function planCompletionInsertion(
  markdown: string,
  doc: PMNode,
  markdownOffset: number,
  pmPosition: number,
  insertion: string,
  profile: Profile,
  parser: CompletionParser,
): CompletionInsertionPlan | undefined {
  if (
    markdownOffset < 0 ||
    markdownOffset > markdown.length ||
    pmPosition < 0 ||
    pmPosition > doc.content.size ||
    !insertion ||
    !isBoundedMarkdownText(insertion)
  )
    return undefined;
  const startMarker = uniqueMarker("Start");
  const endMarker = uniqueMarker("End");
  try {
    const parsedOriginal = parser.parseMarkdown(markdown, profile).doc;
    if (!parsedOriginal.eq(doc)) return undefined;
    const markedSource =
      markdown.slice(0, markdownOffset) +
      startMarker +
      insertion +
      endMarker +
      markdown.slice(markdownOffset);
    const parsed = parser.parseMarkdown(markedSource, profile).doc;
    const start = findTextRange(parsed, startMarker);
    const end = findTextRange(parsed, endMarker);
    if (!start || !end || start.to > end.from) return undefined;
    const prefix = parsed.slice(0, start.from);
    const suffix = parsed.slice(end.to, parsed.content.size);
    const expectedPrefix = doc.slice(0, pmPosition);
    const expectedSuffix = doc.slice(pmPosition, doc.content.size);
    if (
      !sameSlice(prefix, expectedPrefix) ||
      !sameSlice(suffix, expectedSuffix)
    )
      return undefined;
    const slice = parsed.slice(start.to, end.from);
    if (slice.content.size === 0) return undefined;
    if (insertion.includes("\n") && !isSafeMultiline(slice, doc, pmPosition))
      return undefined;
    return {
      insertion,
      slice,
      markdown: markedSource,
      start: start.to,
      end: end.from,
    };
  } catch {
    return undefined;
  }
}

export function validateCompletionPreservation(
  markdown: string,
  doc: PMNode,
  markdownOffset: number,
  pmPosition: number,
  insertion: string,
  profile: Profile,
  parser: CompletionParser,
): boolean {
  return Boolean(
    planCompletionInsertion(
      markdown,
      doc,
      markdownOffset,
      pmPosition,
      insertion,
      profile,
      parser,
    ),
  );
}

function sameSlice(left: Slice, right: Slice): boolean {
  return (
    left.openStart === right.openStart &&
    left.openEnd === right.openEnd &&
    JSON.stringify(left.content.toJSON()) ===
      JSON.stringify(right.content.toJSON())
  );
}
function findTextRange(
  doc: PMNode,
  value: string,
): { from: number; to: number } | undefined {
  let found: { from: number; to: number } | undefined;
  let invalid = false;
  doc.descendants((node, position) => {
    if (!node.isText || !node.text) return;
    const offset = node.text.indexOf(value);
    if (offset < 0) return;
    if (found || node.text.indexOf(value, offset + value.length) >= 0) {
      invalid = true;
      return;
    }
    found = { from: position + offset, to: position + offset + value.length };
  });
  return invalid ? undefined : found;
}
function isSafeMultiline(
  slice: Slice,
  original: PMNode,
  position: number,
): boolean {
  const resolved = original.resolve(position);
  if (
    !resolved.parent.inlineContent ||
    resolved.parentOffset !== resolved.parent.content.size
  )
    return false;
  // Multiline insertions are accepted only when Markdown parsing represents
  // them as prose/list blocks; raw, table, code, heading, and embedded nodes
  // remain outside this first safe structural-edit path.
  let safe = true;
  slice.content.descendants((node) => {
    if (
      node.type.name === "raw_block" ||
      node.type.name === "code_block" ||
      node.type.name === "table" ||
      node.type.name === "heading" ||
      node.type.name === "math_block" ||
      node.type.name === "mermaid"
    )
      safe = false;
  });
  return safe;
}
function isBoundedMarkdownText(text: string): boolean {
  if (text.length > 32_768) return false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      code === 0x7f
    )
      return false;
  }
  return true;
}
function uniqueMarker(kind: string): string {
  return `MM${kind}Position${Math.random().toString(36).slice(2)}Boundary`;
}
