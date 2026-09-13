import { NodeSelection } from "prosemirror-state";
import type { EditorState, Selection } from "prosemirror-state";

import { activeListKind, type ListKind } from "./listCommands";

/** Marks represented by the formatting controls in both toolbars. */
export type ToolbarMarkName = "strong" | "em" | "strike" | "code" | "link";

/** Semantic state keys used by the main toolbar's stateful controls. */
export type ToolbarActiveKey =
  | ToolbarMarkName
  | "blockquote"
  | "code_block"
  | "table"
  | "image"
  | "horizontal_rule";

export type ToolbarActiveState = Record<ToolbarActiveKey, boolean> & {
  listKind: ListKind | null;
};

/**
 * Use the same ProseMirror mark semantics for the floating and main toolbars.
 * Empty selections read stored marks first, while ranges use ProseMirror's
 * rangeHasMark behavior so both toolbars describe the same selection.
 */
export function isToolbarMarkActive(
  state: EditorState,
  selection: Selection,
  markName: string,
): boolean {
  const mark = state.schema.marks[markName];
  if (!mark) return false;
  return selection.empty
    ? Boolean(mark.isInSet(state.storedMarks ?? selection.$from.marks()))
    : state.doc.rangeHasMark(selection.from, selection.to, mark);
}

function hasAncestor(selection: Selection, nodeName: string): boolean {
  const hasAncestorAt = (resolved: Selection["$from"]): boolean => {
    for (let depth = resolved.depth; depth > 0; depth -= 1)
      if (resolved.node(depth).type.name === nodeName) return true;
    return false;
  };

  return (
    hasAncestorAt(selection.$from) &&
    (selection.empty || hasAncestorAt(selection.$to))
  );
}

function isSelectedNode(selection: Selection, nodeName: string): boolean {
  return (
    selection instanceof NodeSelection && selection.node.type.name === nodeName
  );
}

/**
 * Resolve all persistent main-toolbar state from one EditorState/Selection.
 * Table membership is supplied by the editor's existing tableContext helper,
 * which also handles CellSelection and cross-cell text selections.
 */
export function getToolbarActiveState(
  state: EditorState,
  selection: Selection,
  tableActive: boolean,
): ToolbarActiveState {
  let listKind: ListKind | null = null;
  try {
    listKind = activeListKind(state, selection);
  } catch {
    // A transient selection during document replacement must not leave a
    // stale pressed state in the toolbar.
    listKind = null;
  }

  return {
    strong: isToolbarMarkActive(state, selection, "strong"),
    em: isToolbarMarkActive(state, selection, "em"),
    strike: isToolbarMarkActive(state, selection, "strike"),
    code: isToolbarMarkActive(state, selection, "code"),
    link: isToolbarMarkActive(state, selection, "link"),
    blockquote: hasAncestor(selection, "blockquote"),
    code_block: hasAncestor(selection, "code_block"),
    table: tableActive,
    image: isSelectedNode(selection, "image"),
    horizontal_rule: isSelectedNode(selection, "horizontal_rule"),
    listKind,
  };
}
