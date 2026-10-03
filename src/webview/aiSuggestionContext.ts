import type { Node as PMNode } from "prosemirror-model";
import { TextSelection, type EditorState } from "prosemirror-state";
import {
  AI_LIMITS,
  aiContextHead,
  aiContextTail,
  type AiSuggestionContext,
  type AiTargetKind,
} from "../shared/aiSuggestions";

const containers = new Set(["doc", "bullet_list", "ordered_list", "list_item"]);
export interface AiSuggestionTarget {
  readonly position: number;
  readonly kind: AiTargetKind;
  readonly node: PMNode;
  readonly doc: PMNode;
}
export function getSuggestionTarget(
  state: EditorState,
): AiSuggestionTarget | undefined {
  const selection = state.selection;
  if (!(selection instanceof TextSelection) || !selection.empty)
    return undefined;
  const { $from } = selection;
  const kind = $from.parent.type.name;
  if (
    (kind !== "paragraph" && kind !== "heading") ||
    $from.parentOffset !== $from.parent.content.size
  )
    return undefined;
  for (let depth = 0; depth < $from.depth; depth += 1) {
    if (!containers.has($from.node(depth).type.name)) return undefined;
  }
  const marks = state.storedMarks ?? $from.marks();
  if (
    marks.some(
      (mark) => mark.type.name === "link" || mark.type.name === "code",
    ) ||
    $from.nodeBefore?.marks.some(
      (mark) => mark.type.name === "link" || mark.type.name === "code",
    )
  )
    return undefined;
  return { position: selection.from, kind, node: $from.parent, doc: state.doc };
}

/** Read only bounded inline text; never render/serialize or descend into raw nodes. */
function text(node: PMNode, limit: number, reverse: boolean): string {
  let result = "";
  for (
    let step = 0;
    step < Math.min(node.childCount, AI_LIMITS.blocks) && result.length < limit;
    step += 1
  ) {
    const child = node.child(reverse ? node.childCount - 1 - step : step);
    const value = child.isText
      ? (child.text ?? "")
      : child.type.name === "hard_break"
        ? " "
        : "";
    result = reverse
      ? aiContextTail(value, limit - result.length) + result
      : result + aiContextHead(value, limit - result.length);
  }
  return result;
}

export function buildSuggestionContext(
  state: EditorState,
  target: AiSuggestionTarget,
): AiSuggestionContext | undefined {
  if (!isSuggestionSnapshotCurrent(state, target)) return undefined;
  let before = text(target.node, AI_LIMITS.before, true);
  let after = "";
  let heading =
    target.kind === "heading" ? text(target.node, AI_LIMITS.heading, true) : "";
  let visited = 0;
  const visit = (node: PMNode, reverse: boolean): void => {
    if (visited >= AI_LIMITS.blocks) return;
    visited += 1;
    const kind = node.type.name;
    if (kind === "paragraph" || kind === "heading") {
      if (reverse) {
        if (!heading && kind === "heading")
          heading = text(node, AI_LIMITS.heading, true);
        if (before.length < AI_LIMITS.before) {
          const remaining = AI_LIMITS.before - before.length;
          const value = text(
            node,
            Math.max(0, remaining - (before ? 1 : 0)),
            true,
          );
          before = value + (value && before ? "\n" : "") + before;
        }
      } else if (after.length < AI_LIMITS.after) {
        const remaining = AI_LIMITS.after - after.length;
        const value = text(
          node,
          Math.max(0, remaining - (after ? 1 : 0)),
          false,
        );
        after += (value && after ? "\n" : "") + value;
      }
    } else if (containers.has(kind)) {
      for (
        let step = 0;
        step < node.childCount && visited < AI_LIMITS.blocks;
        step += 1
      ) {
        visit(node.child(reverse ? node.childCount - 1 - step : step), reverse);
      }
    }
  };
  const $position = state.selection.$from;
  // Share the visit budget between directions, reserving a portion for following prose.
  for (const reverse of [true, false]) {
    const ceiling = reverse ? AI_LIMITS.blocks - 16 : AI_LIMITS.blocks;
    for (
      let depth = $position.depth - 1;
      depth >= 0 && visited < ceiling;
      depth -= 1
    ) {
      const parent = $position.node(depth);
      const start = $position.index(depth) + (reverse ? -1 : 1);
      for (
        let index = start;
        index >= 0 && index < parent.childCount && visited < ceiling;
        index += reverse ? -1 : 1
      ) {
        visit(parent.child(index), reverse);
        if (
          reverse
            ? before.length >= AI_LIMITS.before && Boolean(heading)
            : after.length >= AI_LIMITS.after
        )
          break;
      }
    }
  }
  return before.trim() ? { before, after, heading } : undefined;
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
