import type { Node as PMNode } from "prosemirror-model";
import { Decoration } from "prosemirror-view";

const colorLiteralPattern = /#[0-9A-Fa-f]{6}/g;
const validatedColorLiteralPattern = /^#[0-9A-Fa-f]{6}$/;
const asciiTokenCharacterPattern = /^[0-9A-Za-z_]$/;
const excludedMarkNames = new Set(["code", "link"]);
const excludedParentNames = new Set(["code_block", "raw_block", "raw_inline"]);

function isAsciiTokenCharacter(value: string | undefined): boolean {
  return value !== undefined && asciiTokenCharacterPattern.test(value);
}

function adjacentTextCharacter(
  parent: PMNode,
  index: number,
  direction: -1 | 1,
): string | undefined {
  const siblingIndex = index + direction;
  if (siblingIndex < 0 || siblingIndex >= parent.childCount) return undefined;
  const sibling = parent.child(siblingIndex);
  if (!sibling.isText || !sibling.text) return undefined;
  return direction === -1 ? sibling.text.at(-1) : sibling.text[0];
}

function hasExcludedMark(node: PMNode): boolean {
  return node.marks.some(
    (mark) =>
      excludedMarkNames.has(mark.type.name) || mark.type.spec.code === true,
  );
}

/**
 * Builds display-only color decorations for validated six-digit RGB literals.
 * The ProseMirror document and Markdown serializer remain untouched.
 */
export function colorLiteralDecorations(doc: PMNode): Decoration[] {
  const decorations: Decoration[] = [];

  doc.descendants((node, position, parent, index) => {
    if (!node.isText || !node.text || !parent) return true;
    if (!node.text.includes("#")) return false;
    if (
      excludedParentNames.has(parent.type.name) ||
      parent.type.spec.code === true ||
      hasExcludedMark(node)
    )
      return false;

    for (const match of node.text.matchAll(colorLiteralPattern)) {
      const literal = match[0];
      const start = match.index;
      const end = start + literal.length;
      const before =
        start > 0
          ? node.text[start - 1]
          : adjacentTextCharacter(parent, index, -1);
      const after =
        end < node.text.length
          ? node.text[end]
          : adjacentTextCharacter(parent, index, 1);

      if (
        !validatedColorLiteralPattern.test(literal) ||
        isAsciiTokenCharacter(before) ||
        isAsciiTokenCharacter(after)
      )
        continue;

      decorations.push(
        Decoration.inline(
          position + start,
          position + end,
          {
            class: "mm-color-literal",
            style: `color: ${literal}`,
            "data-mm-color-literal": literal,
          },
          { "data-mm-color-literal": literal },
        ),
      );
    }

    return false;
  });

  return decorations;
}
