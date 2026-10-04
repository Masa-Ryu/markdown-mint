import { Fragment, Slice, type Node as PMNode } from "prosemirror-model";
import type { Profile } from "./index";

export interface MarkdownPositionMap {
  pmPositionToSourceOffset(position: number): number | undefined;
  sourceOffsetToPmPosition(offset: number): number | undefined;
}
export interface MarkdownPositionMapBridge {
  parseMarkdown(source: string, profile: Profile): { doc: PMNode };
  serializeMarkdown(doc: PMNode, previousSnapshot?: unknown): string;
}

/**
 * Build exact anchors for one synchronized Markdown/ProseMirror snapshot.
 * A unique plain-text anchor is inserted into a cloned PM document or source,
 * then removed again. The mapping is accepted only when removing the anchor
 * restores the exact opposite representation. This rejects syntax positions
 * the editor cannot prove rather than guessing from rendered text lengths.
 */
export function buildMarkdownPositionMap(
  source: string,
  doc: PMNode,
  profile: Profile,
  bridge: MarkdownPositionMapBridge,
  previousSnapshot?: unknown,
): MarkdownPositionMap {
  const marker = `MMPosition${Math.random().toString(36).slice(2)}Anchor`;
  const sourceToPm = new Map<number, number>();
  const pmToSource = new Map<number, number>();

  const sourceOffsetToPmPosition = (offset: number): number | undefined => {
    const cached = sourceToPm.get(offset);
    if (cached !== undefined) return cached;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > source.length ||
      (offset > 0 && isLowSurrogate(source.charCodeAt(offset))) ||
      (source.charCodeAt(offset - 1) === 0x0d &&
        source.charCodeAt(offset) === 0x0a)
    )
      return undefined;
    const inserted = `${source.slice(0, offset)}${marker}${source.slice(offset)}`;
    try {
      const parsed = bridge.parseMarkdown(inserted, profile).doc;
      const range = locateText(parsed, marker);
      if (!range) return undefined;
      const withoutMarker = parsed.replace(range.from, range.to, Slice.empty);
      if (!withoutMarker.eq(doc)) return undefined;
      sourceToPm.set(offset, range.from);
      pmToSource.set(range.from, offset);
      return range.from;
    } catch {
      return undefined;
    }
  };

  const pmPositionToSourceOffset = (position: number): number | undefined => {
    const cached = pmToSource.get(position);
    if (cached !== undefined) return cached;
    if (
      !Number.isSafeInteger(position) ||
      position < 0 ||
      position > doc.content.size
    )
      return undefined;
    let augmented: PMNode;
    try {
      const resolved = doc.resolve(position);
      if (!resolved.parent.inlineContent) return undefined;
      const marked = doc.type.schema.text(marker, resolved.marks());
      augmented = doc.replace(
        position,
        position,
        new Slice(Fragment.from(marked), 0, 0),
      );
    } catch {
      return undefined;
    }
    try {
      const serialized = bridge.serializeMarkdown(augmented, previousSnapshot);
      const first = serialized.indexOf(marker);
      if (first < 0 || serialized.indexOf(marker, first + marker.length) >= 0)
        return undefined;
      const unmarked = `${serialized.slice(0, first)}${serialized.slice(first + marker.length)}`;
      const sourceOffset =
        unmarked === source
          ? first
          : mapOffsetAcrossCanonicalization(source, unmarked, first);
      if (sourceOffset === undefined) return undefined;
      const verified = sourceOffsetToPmPosition(sourceOffset);
      return verified === position ? sourceOffset : undefined;
    } catch {
      return undefined;
    }
  };

  return { pmPositionToSourceOffset, sourceOffsetToPmPosition };
}

/**
 * Source-aware serialization may normalize syntax outside an inserted anchor
 * (for example, a blank line before a nested list item). Map only when the
 * anchor itself remains in an unchanged prefix or suffix. Offsets inside the
 * changed region are intentionally ambiguous and are rejected.
 */
function mapOffsetAcrossCanonicalization(
  source: string,
  serialized: string,
  serializedOffset: number,
): number | undefined {
  let prefix = 0;
  const prefixLimit = Math.min(source.length, serialized.length);
  while (
    prefix < prefixLimit &&
    source.charCodeAt(prefix) === serialized.charCodeAt(prefix)
  )
    prefix += 1;
  if (serializedOffset <= prefix) return serializedOffset;

  let suffix = 0;
  while (
    suffix < source.length - prefix &&
    suffix < serialized.length - prefix &&
    source.charCodeAt(source.length - suffix - 1) ===
      serialized.charCodeAt(serialized.length - suffix - 1)
  )
    suffix += 1;
  const serializedSuffixStart = serialized.length - suffix;
  if (serializedOffset >= serializedSuffixStart)
    return source.length - (serialized.length - serializedOffset);
  return undefined;
}

function locateText(
  doc: PMNode,
  text: string,
): { from: number; to: number } | undefined {
  let found: { from: number; to: number } | undefined;
  let duplicate = false;
  doc.descendants((node, position) => {
    if (!node.isText || !node.text) return;
    const index = node.text.indexOf(text);
    if (index < 0) return;
    if (found || node.text.indexOf(text, index + text.length) >= 0) {
      duplicate = true;
      return;
    }
    found = { from: position + index, to: position + index + text.length };
  });
  return duplicate ? undefined : found;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
