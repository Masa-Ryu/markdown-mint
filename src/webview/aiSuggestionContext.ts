import type { Node as PMNode, ResolvedPos } from "prosemirror-model";
import { TextSelection, type EditorState } from "prosemirror-state";
import type { AiTargetKind } from "../shared/aiSuggestions";

const allowedContainers = new Set([
  "doc",
  "bullet_list",
  "ordered_list",
  "list_item",
]);

export interface AiSuggestionTarget {
  readonly position: number;
  readonly kind: AiTargetKind;
  readonly node: PMNode;
  readonly doc: PMNode;
}

/** Only ordinary prose and headings are eligible; links remain editable labels. */
export function getSuggestionTarget(
  state: EditorState,
): AiSuggestionTarget | undefined {
  const selection = state.selection;
  if (!(selection instanceof TextSelection) || !selection.empty)
    return undefined;
  const { $from } = selection;
  const kind = $from.parent.type.name;
  if (kind !== "paragraph" && kind !== "heading") return undefined;
  if (
    !$from.parent.textContent.trim() &&
    (kind !== "paragraph" || !hasAdjacentProse($from))
  )
    return undefined;
  for (let depth = 0; depth < $from.depth; depth += 1)
    if (!allowedContainers.has($from.node(depth).type.name)) return undefined;
  const activeMarks = state.storedMarks ?? $from.marks();
  if (activeMarks.some((mark) => mark.type.name === "code")) return undefined;
  if (
    $from.nodeBefore?.marks.some((mark) => mark.type.name === "code") ||
    $from.nodeAfter?.marks.some((mark) => mark.type.name === "code")
  )
    return undefined;
  return { position: selection.from, kind, node: $from.parent, doc: state.doc };
}

function hasAdjacentProse(position: ResolvedPos): boolean {
  for (let depth = position.depth; depth > 0; depth -= 1) {
    const container = position.node(depth - 1);
    const index = position.index(depth - 1);
    if (
      (index > 0 && containsProse(container.child(index - 1))) ||
      (index + 1 < container.childCount &&
        containsProse(container.child(index + 1)))
    )
      return true;
  }
  return false;
}

function containsProse(node: PMNode): boolean {
  if (node.type.name === "paragraph" || node.type.name === "heading") {
    let found = false;
    node.descendants((child) => {
      if (
        child.isText &&
        child.text?.trim() &&
        !child.marks.some((mark) => mark.type.name === "code")
      ) {
        found = true;
        return false;
      }
    });
    return found;
  }
  if (
    node.type.name !== "bullet_list" &&
    node.type.name !== "ordered_list" &&
    node.type.name !== "list_item"
  )
    return false;
  for (let index = 0; index < node.childCount; index += 1)
    if (containsProse(node.child(index))) return true;
  return false;
}

export function isSuggestionSnapshotCurrent(
  state: EditorState,
  target: AiSuggestionTarget,
): boolean {
  const current = getSuggestionTarget(state);
  return (
    current !== undefined &&
    current.doc === target.doc &&
    current.node === target.node &&
    current.position === target.position &&
    current.kind === target.kind
  );
}

/** Host callbacks implement this only for a synchronized document snapshot. */
export type MarkdownOffsetForPosition = (
  state: EditorState,
  position: number,
) => number | undefined;
