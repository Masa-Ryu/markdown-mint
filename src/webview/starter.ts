import { Plugin, PluginKey } from "prosemirror-state";
import type { EditorState, Transaction } from "prosemirror-state";
import { Fragment } from "prosemirror-model";
import type { Node as PMNode, Schema } from "prosemirror-model";
import { Decoration, DecorationSet } from "prosemirror-view";

/** The label displayed by the CSS-only starter decoration. */
export const STARTER_PLACEHOLDER = "Title";

/**
 * State for the virtual blank-document title.
 *
 * `active` controls the placeholder decoration. `untouched` is a latched
 * source-preservation flag: it remains true for blank structural changes such
 * as choosing Text, and becomes false after meaningful content is entered or
 * another non-empty block shape is selected.
 */
export interface StarterPluginState {
  readonly active: boolean;
  readonly untouched: boolean;
}

export interface StarterDocument {
  readonly doc: PMNode;
  readonly state: StarterPluginState;
}

export interface StarterTransactionMeta {
  /** Explicitly show or hide the starter decoration. */
  readonly active?: boolean;
  /** Explicitly preserve or consume the original blank source. */
  readonly untouched?: boolean;
  /** Keep the source preservation flag across a structural transaction. */
  readonly preserveSource?: boolean;
}

/** Shared key so the editor can inspect or annotate starter transactions. */
export const starterPluginKey = new PluginKey<StarterPluginState>(
  "markdown-mint-starter",
);

/** True for an empty source containing only Unicode whitespace. */
export function isBlankSource(source: string): boolean {
  return /^\s*$/u.test(source);
}

/** True only for a document whose sole node is an empty paragraph. */
export function isBlankParagraphDocument(doc: PMNode): boolean {
  const first = doc.firstChild;
  return (
    doc.childCount === 1 &&
    first?.type.name === "paragraph" &&
    first.content.size === 0
  );
}

/** True only for the virtual H1 shown for an untouched blank source. */
export function isStarterHeadingDocument(doc: PMNode): boolean {
  const first = doc.firstChild;
  return (
    doc.childCount === 1 &&
    first?.type.name === "heading" &&
    first.attrs.level === 1 &&
    first.content.size === 0
  );
}

function isBlankStarterShape(doc: PMNode): boolean {
  return isBlankParagraphDocument(doc) || isStarterHeadingDocument(doc);
}

/**
 * Return the initial starter state for a parsed source document.
 *
 * Unsupported whitespace-only source is deliberately left alone unless the
 * parser represented it as one empty paragraph. This prevents the helper from
 * hiding a raw source-preserving atom.
 */
export function starterStateFor(
  source: string,
  parsedDoc: PMNode,
): StarterPluginState {
  const heading = parsedDoc.type.schema.nodes.heading;
  const active =
    Boolean(heading) &&
    isBlankSource(source) &&
    isBlankParagraphDocument(parsedDoc);
  return { active, untouched: active };
}

/**
 * Replace a parsed blank paragraph with a virtual empty H1 for rich editing.
 * The original source remains outside the PM document and can be returned by
 * `serializeStarterSource` until the user changes its meaning.
 */
export function prepareStarterDocument(
  source: string,
  parsedDoc: PMNode,
  schema: Schema = parsedDoc.type.schema,
): StarterDocument {
  const state = starterStateFor(source, parsedDoc);
  if (!state.active) return { doc: parsedDoc, state };
  const heading = schema.nodes.heading;
  if (!heading)
    return { doc: parsedDoc, state: { active: false, untouched: false } };
  const virtualHeading = heading.create({ level: 1 });
  return {
    doc: parsedDoc.copy(Fragment.from(virtualHeading)),
    state,
  };
}

/**
 * Create the plugin that decorates an untouched virtual H1 without inserting
 * placeholder text into the document.
 */
export function createStarterPlugin(
  initial: StarterPluginState = { active: false, untouched: false },
): Plugin<StarterPluginState> {
  return new Plugin<StarterPluginState>({
    key: starterPluginKey,
    state: {
      init: () => ({ ...initial }),
      apply: (transaction, previous, _oldState, nextState) => {
        const meta = transaction.getMeta(starterPluginKey) as
          StarterTransactionMeta | undefined;
        let active = previous.active;
        let untouched = previous.untouched;

        if (transaction.docChanged) {
          const blankShape = isBlankStarterShape(nextState.doc);
          if (!blankShape && meta?.preserveSource !== true) untouched = false;

          // Once the user explicitly leaves the virtual H1, do not recreate
          // it automatically if a later transaction happens to yield an
          // empty heading again. A fresh source load gets a fresh plugin
          // state through `prepareStarterDocument`.
          if (!previous.active || !isStarterHeadingDocument(nextState.doc))
            active = false;
        }

        // A host reload can reuse an existing plugin array. Let the caller
        // reseed the plugin state explicitly after preparing the new source.
        if (meta?.active !== undefined) active = meta.active;
        if (meta?.untouched !== undefined) untouched = meta.untouched;

        return { active, untouched };
      },
    },
    props: {
      decorations: (state) => {
        const value = starterPluginKey.getState(state);
        if (!value?.active || !value.untouched) return DecorationSet.empty;
        const first = state.doc.firstChild;
        if (!first || !isStarterHeadingDocument(state.doc))
          return DecorationSet.empty;
        return DecorationSet.create(state.doc, [
          Decoration.node(0, first.nodeSize, {
            class: "mm-starter-title",
            "data-placeholder": STARTER_PLACEHOLDER,
          }),
        ]);
      },
    },
  });
}

/** Read the starter state from an editor state that has the plugin installed. */
export function getStarterState(
  state: EditorState,
): StarterPluginState | undefined {
  return starterPluginKey.getState(state);
}

/** True while the original blank source can still be emitted verbatim. */
export function isStarterUntouched(state: EditorState): boolean {
  return getStarterState(state)?.untouched === true;
}

/**
 * Preserve exact blank source spelling until the virtual starter is changed.
 * `serialized` should be the normal core serialization fallback.
 */
export function serializeStarterSource(
  state: EditorState,
  originalSource: string | undefined,
  serialized: string | (() => string),
): string {
  if (
    originalSource !== undefined &&
    isBlankSource(originalSource) &&
    isStarterUntouched(state)
  )
    return originalSource;
  return typeof serialized === "function" ? serialized() : serialized;
}

/** Annotate a transaction when a toolbar command intentionally controls starter state. */
export function setStarterMeta(
  transaction: Transaction,
  meta: StarterTransactionMeta,
): Transaction {
  return transaction.setMeta(starterPluginKey, meta);
}
