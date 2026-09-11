import { InputRule, inputRules } from "prosemirror-inputrules";
import { Plugin } from "prosemirror-state";
import type { EditorState, Transaction } from "prosemirror-state";
import type {
  Attrs,
  Node as PMNode,
  NodeType,
  Schema,
} from "prosemirror-model";
import { canJoin, findWrapping } from "prosemirror-transform";

type RuleHandler = (
  state: EditorState,
  match: RegExpMatchArray,
  start: number,
  end: number,
) => Transaction | null;

const TABLE_ROLES = new Set(["table", "row", "cell", "header_cell"]);

function isCodeMark(mark: {
  type: { name: string; spec: { code?: boolean } };
}): boolean {
  return mark.type.name === "code" || mark.type.spec.code === true;
}

/**
 * Writing rules deliberately only operate on ordinary paragraphs.
 *
 * `prosemirror-inputrules` already avoids code blocks, but this check also
 * covers table cells and the editor's code mark. The latter is named `code`
 * in the shared schema and therefore does not set the optional ProseMirror
 * `MarkSpec.code` flag.
 */
function isEligibleParagraph(
  state: EditorState,
  start: number,
  end: number,
  paragraph: NodeType,
): boolean {
  const resolved = state.doc.resolve(start);
  if (resolved.parent.type !== paragraph) return false;

  for (let depth = resolved.depth; depth > 0; depth -= 1) {
    const node = resolved.node(depth);
    if (
      node.type.name === "heading" ||
      node.type.name === "code_block" ||
      TABLE_ROLES.has(node.type.spec.tableRole ?? "")
    )
      return false;
  }

  if (
    resolved.marks().some(isCodeMark) ||
    resolved.nodeBefore?.marks.some(isCodeMark) ||
    resolved.nodeAfter?.marks.some(isCodeMark) ||
    state.storedMarks?.some(isCodeMark)
  )
    return false;

  let hasCodeMark = false;
  if (end > start) {
    state.doc.nodesBetween(start, end, (node) => {
      if (node.isInline && node.marks.some(isCodeMark)) hasCodeMark = true;
    });
  }
  return !hasCodeMark;
}

/**
 * The standard input-rule builders do not expose a context predicate, so the
 * small guarded builders below mirror their transaction shape. The actual
 * dispatch and composition behavior still comes from `inputRules`.
 */
function guardedTextblockTypeRule(
  regexp: RegExp,
  nodeType: NodeType,
  paragraph: NodeType,
  getAttrs: (match: RegExpMatchArray) => Attrs | null,
  validate: (match: RegExpMatchArray) => boolean = () => true,
): InputRule {
  const handler: RuleHandler = (state, match, start, end) => {
    if (!isEligibleParagraph(state, start, end, paragraph)) return null;
    if (!validate(match)) return null;
    const resolved = state.doc.resolve(start);
    if (
      !resolved
        .node(-1)
        .canReplaceWith(resolved.index(-1), resolved.indexAfter(-1), nodeType)
    )
      return null;
    const attrs = getAttrs(match);
    if (attrs === null) return null;
    return state.tr
      .delete(start, end)
      .setBlockType(start, start, nodeType, attrs);
  };

  return new InputRule(regexp, handler, {
    undoable: false,
    inCode: false,
    inCodeMark: false,
  });
}

function guardedWrappingRule(
  regexp: RegExp,
  nodeType: NodeType,
  paragraph: NodeType,
  getAttrs: (match: RegExpMatchArray) => Attrs | null = () => null,
  joinPredicate: (match: RegExpMatchArray, before: PMNode) => boolean = () =>
    true,
  rejectNonMatchingJoin = false,
  validate: (match: RegExpMatchArray) => boolean = () => true,
): InputRule {
  const handler: RuleHandler = (state, match, start, end) => {
    if (!isEligibleParagraph(state, start, end, paragraph)) return null;
    if (!validate(match)) return null;
    const attrs = getAttrs(match);

    const transaction = state.tr.delete(start, end);
    const previous = transaction.doc.resolve(start - 1).nodeBefore;
    if (
      rejectNonMatchingJoin &&
      previous?.type === nodeType &&
      !joinPredicate(match, previous)
    )
      return null;
    const resolved = transaction.doc.resolve(start);
    const range = resolved.blockRange();
    const wrapping = range && findWrapping(range, nodeType, attrs);
    if (!range || !wrapping) return null;

    transaction.wrap(range, wrapping);
    const before = transaction.doc.resolve(start - 1).nodeBefore;
    if (
      before &&
      before.type === nodeType &&
      canJoin(transaction.doc, start - 1) &&
      joinPredicate(match, before)
    )
      transaction.join(start - 1);
    return transaction;
  };

  return new InputRule(regexp, handler, {
    undoable: false,
    inCode: false,
    inCodeMark: false,
  });
}

function orderedListAttrs(match: RegExpMatchArray): Attrs {
  const rawOrder = match[1];
  if (!rawOrder) return { order: 1 };
  const order = Number(rawOrder);
  return { order };
}

function validOrderedListMarker(match: RegExpMatchArray): boolean {
  const order = Number(match[1] ?? 1);
  return Number.isSafeInteger(order) && order > 0;
}

function orderedListJoinPredicate(
  match: RegExpMatchArray,
  before: PMNode,
): boolean {
  const order = Number(match[1] ?? 1);
  const beforeOrder = Number(before.attrs.order ?? 1);
  return (
    Number.isSafeInteger(order) &&
    Number.isSafeInteger(beforeOrder) &&
    beforeOrder + before.childCount === order
  );
}

/**
 * Keep standard input-rule text handling while omitting its compositionend
 * retry. The retry runs asynchronously against the current selection, which
 * can be a restored selection after the host has applied an external source
 * update during composition. Such a retry could then reinterpret external
 * Markdown as if it had just been typed by the user.
 */
function inputRulesWithoutCompositionRetry(
  rules: readonly InputRule[],
): Plugin {
  const standard = inputRules({ rules });
  const standardProps = standard.spec.props ?? {};
  const { handleDOMEvents = {}, ...props } = standardProps;
  const {
    compositionend: _compositionend,
    ...handleDOMEventsWithoutCompositionEnd
  } = handleDOMEvents;

  return new Plugin({
    ...standard.spec,
    props: {
      ...props,
      handleDOMEvents: handleDOMEventsWithoutCompositionEnd,
    },
  });
}

/**
 * Create the Markdown-shaped writing shortcuts used by the rich editor.
 *
 * This returns only the standard ProseMirror input-rules plugin. It does not
 * install a history plugin, keymap, or input-rule undo command; the host
 * TextDocument remains the source of truth for undo and synchronization.
 */
export function createWritingInputRules(schema: Schema): Plugin {
  const paragraph = schema.nodes.paragraph;
  if (!paragraph) return inputRulesWithoutCompositionRetry([]);

  const rules: InputRule[] = [];
  const heading = schema.nodes.heading;
  if (heading) {
    rules.push(
      guardedTextblockTypeRule(
        /^(#{1,6})[ \u00a0]$/u,
        heading,
        paragraph,
        (match) => ({
          level: match[1]?.length ?? 1,
        }),
      ),
    );
  }

  const blockquote = schema.nodes.blockquote;
  if (blockquote)
    rules.push(guardedWrappingRule(/^>[ \u00a0]$/u, blockquote, paragraph));

  const bulletList = schema.nodes.bullet_list;
  if (bulletList)
    rules.push(guardedWrappingRule(/^[-*+][ \u00a0]$/u, bulletList, paragraph));

  const orderedList = schema.nodes.ordered_list;
  if (orderedList)
    rules.push(
      guardedWrappingRule(
        /^(\d{1,9})\.[ \u00a0]$/u,
        orderedList,
        paragraph,
        orderedListAttrs,
        orderedListJoinPredicate,
        true,
        validOrderedListMarker,
      ),
    );

  return inputRulesWithoutCompositionRetry(rules);
}
