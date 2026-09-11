import {
  Fragment,
  type Node as PMNode,
  type NodeType,
  type Schema,
} from "prosemirror-model";
import {
  AllSelection,
  Selection,
  TextSelection,
  type Command,
  type EditorState,
  type Selection as PMSelection,
  type Transaction,
} from "prosemirror-state";
import { lift } from "prosemirror-commands";
import { liftListItem, wrapRangeInList } from "prosemirror-schema-list";

/** The list controls exposed by the webview toolbar. */
export type ListKind = "bullet" | "ordered" | "task";

/** The value used by the shared list-item schema for task state. */
export type TaskState = boolean | "mixed" | null;

interface ListContext {
  list: PMNode;
  listPos: number;
  fromIndex: number;
  toIndex: number;
}

interface BlockInRange {
  node: PMNode;
  pos: number;
}

function isListNode(node: PMNode): boolean {
  return node.type.name === "bullet_list" || node.type.name === "ordered_list";
}

function isListItem(node: PMNode): boolean {
  return node.type.name === "list_item";
}

function isTaskItem(node: PMNode): boolean {
  return isListItem(node) && node.attrs.checked != null;
}

function textSelectionForAll(doc: PMNode): TextSelection | null {
  const atStart = Selection.atStart(doc);
  const atEnd = Selection.atEnd(doc);
  if (atStart instanceof TextSelection && atEnd instanceof TextSelection) {
    const selection = TextSelection.between(atStart.$from, atEnd.$to);
    return selection instanceof TextSelection ? selection : null;
  }

  // Documents containing only leaf atoms may not have text positions at both
  // ends. Retain a text-descendant fallback for a later editable block.
  let first: number | undefined;
  let last: number | undefined;
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    if (first === undefined) first = pos;
    last = pos + node.nodeSize;
  });
  if (first !== undefined && last !== undefined) {
    const selection = TextSelection.between(
      doc.resolve(first),
      doc.resolve(last),
    );
    return selection instanceof TextSelection ? selection : null;
  }

  const position = Math.max(
    1,
    Math.min(doc.content.size - 1, doc.content.size),
  );
  const nearby = Selection.near(doc.resolve(position), 1);
  return nearby instanceof TextSelection ? nearby : null;
}

function stateWithCommandSelection(state: EditorState): EditorState {
  if (!(state.selection instanceof AllSelection)) return state;
  const selection = textSelectionForAll(state.doc);
  return selection ? state.apply(state.tr.setSelection(selection)) : state;
}

/** Resolve the schema node used to represent a toolbar list kind. */
export function listNodeTypeForKind(
  schema: Schema,
  kind: ListKind,
): NodeType | null {
  const name = kind === "ordered" ? "ordered_list" : "bullet_list";
  return schema.nodes[name] ?? null;
}

function selectedListItems(context: ListContext): PMNode[] {
  const items: PMNode[] = [];
  for (let index = context.fromIndex; index < context.toIndex; index += 1) {
    const item = context.list.child(index);
    if (isListItem(item)) items.push(item);
  }
  return items;
}

function listContextForSelection(selection: Selection): ListContext | null {
  const { $from, $to } = selection;

  // Start at the deepest shared list. This keeps a selection in a nested list
  // local to that list and avoids changing an enclosing list by accident.
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const list = $from.node(depth);
    if (!isListNode(list)) continue;
    if ($to.depth < depth || $to.node(depth) !== list) continue;

    const range = $from.blockRange($to);
    let fromIndex = $from.index(depth);
    let toIndex = $to.indexAfter(depth);
    if (range?.parent === list) {
      fromIndex = range.startIndex;
      toIndex = range.endIndex;
    }

    fromIndex = Math.max(0, Math.min(fromIndex, list.childCount));
    toIndex = Math.max(fromIndex + 1, Math.min(toIndex, list.childCount));
    if (fromIndex >= list.childCount || toIndex > list.childCount) continue;

    if (toIndex <= fromIndex) continue;
    let allItems = true;
    for (let index = fromIndex; index < toIndex; index += 1) {
      if (!isListItem(list.child(index))) allItems = false;
    }
    if (!allItems) continue;

    return {
      list,
      listPos: $from.before(depth),
      fromIndex,
      toIndex,
    };
  }

  return null;
}

function selectedBlockNodes(
  doc: PMNode,
  selection: PMSelection,
): BlockInRange[] | null {
  const { $from, $to } = selection;
  const range = $from.blockRange($to);
  if (!range) return null;

  // A cursor or text selection inside one textblock produces a range whose
  // parent is that textblock. Its position is still the position before the
  // block, which is exactly what setNodeMarkup needs.
  if (range.parent.isTextblock) {
    return [{ node: range.parent, pos: $from.before(range.depth) }];
  }

  // Any direct block container may be wrapped when every selected child is a
  // paragraph or heading. This includes blockquotes, while mixed containers
  // containing code, tables, or raw blocks remain safely rejected below.
  const blocks: BlockInRange[] = [];
  let pos = range.start;
  for (let index = range.startIndex; index < range.endIndex; index += 1) {
    const node = range.parent.child(index);
    blocks.push({ node, pos });
    pos += node.nodeSize;
  }
  return blocks;
}

function canWrapBlocks(blocks: BlockInRange[]): boolean {
  return (
    blocks.length > 0 &&
    blocks.every(
      ({ node }) =>
        node.type.name === "paragraph" || node.type.name === "heading",
    )
  );
}

function listKindForContext(context: ListContext): ListKind | null {
  const items = selectedListItems(context);
  if (items.length === 0) return null;

  const allTask = items.every((item) => isTaskItem(item));
  const allPlain = items.every((item) => item.attrs.checked == null);
  if (!allTask && !allPlain) return null;

  if (context.list.type.name === "ordered_list") {
    return allPlain ? "ordered" : null;
  }
  return allTask ? "task" : "bullet";
}

/** Return the active semantic list kind at the current selection. */
export function activeListKind(state: EditorState): ListKind | null {
  const commandState = stateWithCommandSelection(state);
  const context = listContextForSelection(commandState.selection);
  return context ? listKindForContext(context) : null;
}

/** Whether the selection is wholly inside the requested semantic list kind. */
export function isListActive(state: EditorState, kind: ListKind): boolean {
  return activeListKind(state) === kind;
}

/** Compatibility alias for toolbar integrations that use a getter name. */
export const getActiveListKind = activeListKind;

function taskStateForTarget(item: PMNode, kind: ListKind): TaskState {
  if (kind !== "task") return null;
  // Preserve an already checked or mixed item when a mixed selection is
  // converted to a task list. Plain list items become unchecked tasks.
  return item.attrs.checked == null ? false : (item.attrs.checked as TaskState);
}

function itemWithTaskState(item: PMNode, kind: ListKind): PMNode {
  const checked = taskStateForTarget(item, kind);
  if (item.attrs.checked === checked) return item;
  return item.type.create({ ...item.attrs, checked }, item.content, item.marks);
}

function listAttrs(
  type: NodeType,
  source: PMNode,
  itemOffset: number,
): Record<string, number> | null {
  if (type.name !== "ordered_list") return null;
  const sourceOrder =
    typeof source.attrs.order === "number" &&
    Number.isFinite(source.attrs.order)
      ? source.attrs.order
      : 1;
  const order =
    source.type.name === "ordered_list" ? sourceOrder + itemOffset : 1;
  return { order };
}

function makeList(
  type: NodeType,
  source: PMNode,
  items: PMNode[],
  itemOffset: number,
): PMNode {
  return type.create(
    listAttrs(type, source, itemOffset),
    Fragment.fromArray(items),
  );
}

function itemPositions(listPos: number, list: PMNode): number[] {
  const positions: number[] = [];
  let pos = listPos + 1;
  for (let index = 0; index < list.childCount; index += 1) {
    positions.push(pos);
    pos += list.child(index).nodeSize;
  }
  return positions;
}

function selectionInsideConvertedList(
  state: EditorState,
  tr: Transaction,
  context: ListContext,
  beforeItemSize: number,
  selectedListPos: number,
  selectedList: PMNode,
): void {
  if (!(state.selection instanceof TextSelection)) return;

  // Replacing one list with before/selected/after siblings makes the normal
  // transaction mapping land on a sibling boundary in some browsers. Restore
  // both ends from their offset inside the selected list so the next toolbar
  // click keeps operating on the same item(s).
  const oldContentStart = context.listPos + 1 + beforeItemSize;
  const newContentStart = selectedListPos + 1;
  const maxOffset = selectedList.content.size;
  const offset = (position: number): number =>
    Math.max(0, Math.min(maxOffset, position - oldContentStart));
  const anchor = newContentStart + offset(state.selection.anchor);
  const head = newContentStart + offset(state.selection.head);
  try {
    tr.setSelection(
      TextSelection.between(
        tr.doc.resolve(anchor),
        tr.doc.resolve(head),
        anchor <= head ? 1 : -1,
      ),
    );
  } catch {
    // The mapped selection remains the safest fallback for unusual custom
    // selections or a schema with a non-text list-item first child.
  }
}

function convertSelectedListItems(
  state: EditorState,
  context: ListContext,
  kind: ListKind,
  dispatch: ((tr: Transaction) => void) | undefined,
): boolean {
  const listType = listNodeTypeForKind(state.schema, kind);
  if (!listType) return false;

  const sourceItems: PMNode[] = [];
  context.list.forEach((item) => sourceItems.push(item));
  const selected = sourceItems.slice(context.fromIndex, context.toIndex);
  if (selected.length === 0 || selected.some((item) => !isListItem(item))) {
    return false;
  }

  // Task and bullet lists deliberately share the same node type. Changing
  // only checked attrs keeps one contiguous list node, which is important for
  // both Markdown serialization and selection mapping.
  if (context.list.type === listType) {
    const positions = itemPositions(context.listPos, context.list);
    const tr = state.tr;
    let changed = false;
    for (
      let index = context.toIndex - 1;
      index >= context.fromIndex;
      index -= 1
    ) {
      const item = context.list.child(index);
      const position = positions[index];
      if (!isListItem(item) || position === undefined) continue;
      const replacement = itemWithTaskState(item, kind);
      if (replacement.eq(item)) continue;
      tr.setNodeMarkup(
        position,
        undefined,
        replacement.attrs,
        replacement.marks,
      );
      changed = true;
    }
    if (!changed) return false;
    if (!dispatch) return true;
    dispatch(tr.scrollIntoView());
    return true;
  }

  const selectedItems = selected.map((item) => itemWithTaskState(item, kind));
  const before = sourceItems.slice(0, context.fromIndex);
  const after = sourceItems.slice(context.toIndex);
  const replacement: PMNode[] = [];
  const beforeList =
    before.length > 0
      ? makeList(context.list.type, context.list, before, 0)
      : null;
  const selectedList = makeList(
    listType,
    context.list,
    selectedItems,
    context.fromIndex,
  );
  const afterList =
    after.length > 0
      ? makeList(
          context.list.type,
          context.list,
          after,
          context.fromIndex + selected.length,
        )
      : null;

  if (beforeList) replacement.push(beforeList);
  replacement.push(selectedList);
  if (afterList) replacement.push(afterList);

  if (!dispatch) return true;
  const tr = state.tr.replaceWith(
    context.listPos,
    context.listPos + context.list.nodeSize,
    Fragment.fromArray(replacement),
  );
  const beforeItemSize = before.reduce((size, item) => size + item.nodeSize, 0);
  const selectedListPos = context.listPos + (beforeList?.nodeSize ?? 0);
  selectionInsideConvertedList(
    state,
    tr,
    context,
    beforeItemSize,
    selectedListPos,
    selectedList,
  );
  dispatch(tr.scrollIntoView());
  return true;
}

function liftSelectedListItems(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
): boolean {
  const itemType = state.schema.nodes.list_item;
  if (!itemType) return false;
  const command = liftListItem(itemType);
  const lifted = dispatch
    ? command(state, (tr) => dispatch(tr.scrollIntoView()))
    : command(state);
  if (lifted) return true;

  // schema-list's specialized lift rejects a nested item when the containing
  // item has a following nested sibling list. The generic block lift handles
  // that valid shape by lifting the selected paragraph into the parent item,
  // preserving the sibling list and all inline marks.
  return dispatch
    ? lift(state, (tr) => dispatch(tr.scrollIntoView()))
    : lift(state);
}

function prepareHeadingBlocks(
  tr: Transaction,
  blocks: BlockInRange[],
): boolean {
  const paragraph = tr.doc.type.schema.nodes.paragraph;
  if (!paragraph) return false;
  for (const { node, pos } of blocks) {
    if (node.type.name !== "heading") continue;
    tr.setNodeMarkup(pos, paragraph, null, node.marks);
  }
  return true;
}

function wrapParagraphBlocks(
  state: EditorState,
  kind: ListKind,
  dispatch: ((tr: Transaction) => void) | undefined,
): boolean {
  const listType = listNodeTypeForKind(state.schema, kind);
  if (!listType) return false;

  const tr = state.tr;
  let blocks = selectedBlockNodes(tr.doc, tr.selection);
  if (!blocks || !canWrapBlocks(blocks)) return false;
  if (blocks.some(({ node }) => node.type.name === "heading")) {
    if (!prepareHeadingBlocks(tr, blocks)) return false;
    blocks = selectedBlockNodes(tr.doc, tr.selection);
    if (!blocks || !canWrapBlocks(blocks)) return false;
  }

  const range = tr.selection.$from.blockRange(tr.selection.$to);
  if (!range || !wrapRangeInList(tr, range, listType)) return false;

  if (kind === "task") {
    const context = listContextForSelection(tr.selection);
    if (!context) return false;
    const positions = itemPositions(context.listPos, context.list);
    const start = context.fromIndex;
    const end = context.toIndex;
    for (let index = end - 1; index >= start; index -= 1) {
      const item = context.list.child(index);
      if (!isListItem(item)) continue;
      if (item.attrs.checked != null) continue;
      const position = positions[index];
      if (position === undefined) continue;
      tr.setNodeMarkup(position, undefined, { ...item.attrs, checked: false });
    }
  }

  if (!dispatch) return true;
  dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Build a toggle command for the Markdown Mint list toolbar.
 *
 * Task lists share the bullet-list node type and use `list_item.checked`.
 * Callers decide whether the active profile permits task syntax; this module
 * keeps the document transformation profile-independent.
 */
export function createListCommand(kind: ListKind, schema: Schema): Command {
  return (state, dispatch) => {
    const commandState = stateWithCommandSelection(state);
    const listType = listNodeTypeForKind(schema, kind);
    if (!listType || commandState.schema !== schema) return false;

    const context = listContextForSelection(commandState.selection);
    if (context) {
      const active = listKindForContext(context);
      if (active === kind) {
        return liftSelectedListItems(commandState, dispatch);
      }
      return convertSelectedListItems(commandState, context, kind, dispatch);
    }

    return wrapParagraphBlocks(commandState, kind, dispatch);
  };
}

/** Short alias used by integrations that call the command a toggle. */
export const toggleList = createListCommand;

/** Explicit alias for callers that prefer a command-oriented name. */
export const listCommand = createListCommand;

/** Classify one list node when all of its direct items have one task state. */
export function listKindForNode(node: PMNode): ListKind | null {
  if (!isListNode(node)) return null;
  const items: PMNode[] = [];
  node.forEach((item) => items.push(item));
  if (items.length === 0 || items.some((item) => !isListItem(item)))
    return null;
  const allTask = items.every((item) => isTaskItem(item));
  const allPlain = items.every((item) => item.attrs.checked == null);
  if (!allTask && !allPlain) return null;
  if (node.type.name === "ordered_list") return allPlain ? "ordered" : null;
  return allTask ? "task" : "bullet";
}
