import { Slice } from "prosemirror-model";
import type { Node as PMNode, ResolvedPos } from "prosemirror-model";
import {
  Plugin,
  Selection,
  type SelectionBookmark,
  type EditorState,
} from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { Mappable } from "prosemirror-transform";

/**
 * A selection that lives between top-level document blocks.
 *
 * ProseMirror's regular text selections always belong to a textblock. A
 * gap-cursor is therefore useful for leaf blocks, but the stock
 * `prosemirror-gapcursor` validity rules deliberately reject the space
 * between two ordinary paragraphs. Markdown Mint needs that space to be a
 * keyboard-only insertion point, so this small selection keeps the same
 * Selection contract while limiting it to the document's direct children.
 */
export class BlockBoundarySelection extends Selection {
  constructor($pos: ResolvedPos) {
    if (!isBlockBoundary($pos.doc, $pos.pos))
      throw new RangeError("Block boundary must be at the document top level");
    super($pos, $pos);
    this.visible = false;
  }

  map(doc: PMNode, mapping: Mappable): Selection {
    const mapped = mapping.map(this.head, 1);
    if (isBlockBoundary(doc, mapped))
      return new BlockBoundarySelection(doc.resolve(mapped));
    return Selection.near(
      doc.resolve(Math.max(0, Math.min(mapped, doc.content.size))),
      1,
    );
  }

  override content(): Slice {
    return Slice.empty;
  }

  eq(other: Selection): boolean {
    return other instanceof BlockBoundarySelection && other.head === this.head;
  }

  toJSON(): { type: string; pos: number } {
    return { type: "markdown-mint-block-boundary", pos: this.head };
  }

  override getBookmark(): SelectionBookmark {
    return new BlockBoundaryBookmark(this.head);
  }

  static override fromJSON(
    doc: PMNode,
    json: { pos?: unknown },
  ): BlockBoundarySelection {
    if (typeof json.pos !== "number")
      throw new RangeError("Invalid block boundary selection");
    return new BlockBoundarySelection(doc.resolve(json.pos));
  }
}

BlockBoundarySelection.prototype.visible = false;
Selection.jsonID("markdown-mint-block-boundary", BlockBoundarySelection);

class BlockBoundaryBookmark implements SelectionBookmark {
  constructor(private readonly pos: number) {}

  map(mapping: Mappable): SelectionBookmark {
    return new BlockBoundaryBookmark(mapping.map(this.pos, 1));
  }

  resolve(doc: PMNode): Selection {
    const pos = Math.max(0, Math.min(this.pos, doc.content.size));
    return isBlockBoundary(doc, pos)
      ? new BlockBoundarySelection(doc.resolve(pos))
      : Selection.near(doc.resolve(pos), 1);
  }
}

/** Return true only for a position between direct children of the document. */
export function isBlockBoundary(doc: PMNode, position: number): boolean {
  if (position < 0 || position > doc.content.size) return false;
  try {
    return doc.resolve(position).depth === 0;
  } catch {
    return false;
  }
}

/** Draw the virtual caret without inserting a paragraph or changing layout. */
export function createBlockBoundaryPlugin(): Plugin {
  return new Plugin({
    props: {
      decorations: (state: EditorState) => {
        if (!(state.selection instanceof BlockBoundarySelection)) return null;
        const cursor = document.createElement("span");
        cursor.className = "mm-block-boundary-cursor";
        cursor.setAttribute("aria-hidden", "true");
        return DecorationSet.create(state.doc, [
          Decoration.widget(state.selection.head, cursor, {
            key: "markdown-mint-block-boundary",
            side: 0,
          }),
        ]);
      },
    },
  });
}
