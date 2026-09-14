import { Decoration, DecorationSet } from "prosemirror-view";
import type { EditorView } from "prosemirror-view";
import type { Node as PMNode, NodeType, Schema } from "prosemirror-model";
import {
  Plugin,
  PluginKey,
  Selection,
  type Transaction,
} from "prosemirror-state";
import {
  MAX_IMAGE_IMPORT_BYTES,
  PROTOCOL_VERSION,
  type ImageImportMessage,
  type ImageImportResultMessage,
} from "../shared/protocol";

export interface PendingImageImport {
  readonly requestId: string;
  readonly fileName: string;
  readonly position: number;
  /** True when the original point was deleted; position now means its mapped boundary. */
  readonly anchorDeleted: boolean;
}

export interface ImageImportPluginState {
  readonly pending: readonly PendingImageImport[];
  readonly decorations: DecorationSet;
}

export const imageImportPluginKey = new PluginKey<ImageImportPluginState>(
  "markdown-mint-image-import",
);

type ImageImportTransactionMeta =
  | { readonly kind: "add"; readonly request: PendingImageImport }
  | { readonly kind: "finish"; readonly requestId: string }
  | { readonly kind: "clear" };

interface ImageImportFileRequest {
  readonly requestId: string;
  readonly file: File;
}

export interface ImageImportControllerOptions {
  readonly schema: Schema;
  readonly postMessage?: (message: ImageImportMessage) => void;
  readonly canImport: () => boolean;
  readonly notify: (message: string) => void;
  readonly createRequestId?: () => string;
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Keep the pending import positions outside the document and map them with PM. */
export function createImageImportPlugin(): Plugin<ImageImportPluginState> {
  return new Plugin<ImageImportPluginState>({
    key: imageImportPluginKey,
    state: {
      init: () => ({
        pending: [],
        decorations: DecorationSet.empty,
      }),
      apply: (transaction, value) =>
        applyImageImportTransaction(transaction, value),
    },
    props: {
      decorations: (state) =>
        imageImportPluginKey.getState(state)?.decorations ?? null,
    },
  });
}

export class ImageImportController {
  readonly plugin: Plugin<ImageImportPluginState>;
  private readonly options: ImageImportControllerOptions;
  private readonly pendingFiles = new Map<string, File>();
  private readQueue: Promise<void> = Promise.resolve();
  private destroyed = false;

  constructor(options: ImageImportControllerOptions) {
    this.options = options;
    this.plugin = createImageImportPlugin();
  }

  handleDrop(view: EditorView, event: DragEvent): boolean {
    const files = filesFromDrop(event);
    const imageFiles = files.filter(isPotentialImageFile);
    if (imageFiles.length === 0) return false;

    event.preventDefault();
    if (!this.options.canImport() || !this.options.postMessage) {
      this.options.notify(
        "Images can only be imported in the editable Rich editor.",
      );
      return true;
    }

    const position = dropPosition(view, event);
    if (position === null) {
      this.options.notify(
        "The image could not be placed at the dropped position.",
      );
      return true;
    }
    const imageType = this.options.schema.nodes.image;
    const insertionPosition = imageType
      ? imageInsertionPosition(view, position, imageType)
      : null;
    if (insertionPosition === null) {
      this.options.notify(
        "The image cannot be placed at the dropped position.",
      );
      return true;
    }

    const requests: ImageImportFileRequest[] = [];
    for (const file of imageFiles) {
      const requestId = this.newRequestId();
      const request = { requestId, file };
      requests.push(request);
      this.pendingFiles.set(requestId, file);
      view.dispatch(
        view.state.tr.setMeta(imageImportPluginKey, {
          kind: "add",
          request: {
            requestId,
            fileName: file.name,
            position: insertionPosition,
            anchorDeleted: false,
          },
        } satisfies ImageImportTransactionMeta),
      );
    }

    // Read files in drop order. Host requests are therefore sent in the same
    // order, while all positions are already present and can map through the
    // first completed insertion.
    this.readQueue = this.readQueue
      .then(() => this.sendFilesInOrder(view, requests))
      .catch(() => undefined);
    return true;
  }

  handleResult(view: EditorView, result: ImageImportResultMessage): void {
    const pending = imageImportPluginKey
      .getState(view.state)
      ?.pending.find((candidate) => candidate.requestId === result.requestId);
    if (!pending) return;

    this.pendingFiles.delete(result.requestId);
    if (!result.success) {
      this.finishWithoutDocumentChange(view, result.requestId);
      this.options.notify(
        result.message ?? "The dropped image could not be imported.",
      );
      return;
    }
    if (!isSafeRelativeImagePath(result.relativePath)) {
      this.finishWithoutDocumentChange(view, result.requestId);
      this.options.notify("The image import returned an unsafe Markdown path.");
      return;
    }

    const imageType = this.options.schema.nodes.image;
    if (!imageType) {
      this.finishWithoutDocumentChange(view, result.requestId);
      this.options.notify("This editor does not support Markdown images.");
      return;
    }
    const image = imageType.create({
      src: result.relativePath,
      alt: defaultAltText(pending.fileName),
      title: null,
    });
    const transaction = imageTransactionAt(view, pending.position, image);
    if (!transaction) {
      this.finishWithoutDocumentChange(view, result.requestId);
      this.options.notify(
        "The image could not be placed at the dropped position.",
      );
      return;
    }
    transaction.setMeta(imageImportPluginKey, {
      kind: "finish",
      requestId: result.requestId,
    } satisfies ImageImportTransactionMeta);
    try {
      view.dispatch(transaction);
    } catch {
      this.finishWithoutDocumentChange(view, result.requestId);
      this.options.notify("The imported image could not be inserted.");
    }
  }

  cancel(view?: EditorView): void {
    this.pendingFiles.clear();
    if (!view) return;
    const pending = imageImportPluginKey.getState(view.state)?.pending;
    if (!pending?.length) return;
    try {
      view.dispatch(
        view.state.tr.setMeta(imageImportPluginKey, {
          kind: "clear",
        } satisfies ImageImportTransactionMeta),
      );
    } catch {
      // The view may already be in the process of being destroyed.
    }
  }

  dispose(view?: EditorView): void {
    this.cancel(view);
    this.destroyed = true;
  }

  private newRequestId(): string {
    return (
      this.options.createRequestId?.() ??
      (typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `image:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`)
    );
  }

  private async sendFilesInOrder(
    view: EditorView,
    requests: readonly ImageImportFileRequest[],
  ): Promise<void> {
    for (const { requestId, file } of requests) {
      if (this.destroyed) return;
      if (!this.isPending(view, requestId)) continue;
      try {
        const bytes = await readFileBytes(file);
        if (!this.isPending(view, requestId)) continue;
        const message: ImageImportMessage = {
          protocolVersion: PROTOCOL_VERSION,
          type: "image-import",
          requestId,
          fileName: file.name,
          mimeType: imageMimeType(file),
          base64: bytesToBase64(bytes),
        };
        this.options.postMessage?.(message);
      } catch (error) {
        this.pendingFiles.delete(requestId);
        this.finishWithoutDocumentChange(view, requestId);
        this.options.notify(
          errorMessage(error, "The dropped image could not be read."),
        );
      }
    }
  }

  private isPending(view: EditorView, requestId: string): boolean {
    return Boolean(
      !this.destroyed &&
      this.pendingFiles.has(requestId) &&
      imageImportPluginKey
        .getState(view.state)
        ?.pending.some((candidate) => candidate.requestId === requestId),
    );
  }

  private finishWithoutDocumentChange(
    view: EditorView,
    requestId: string,
  ): void {
    if (!imageImportPluginKey.getState(view.state)?.pending.length) return;
    try {
      view.dispatch(
        view.state.tr.setMeta(imageImportPluginKey, {
          kind: "finish",
          requestId,
        } satisfies ImageImportTransactionMeta),
      );
    } catch {
      // The host result may race with view disposal; there is no document edit
      // to recover in that case.
    }
  }
}

function applyImageImportTransaction(
  transaction: Transaction,
  value: ImageImportPluginState,
): ImageImportPluginState {
  const pending: PendingImageImport[] = [];
  for (const candidate of value.pending) {
    const mapped = transaction.mapping.mapResult(candidate.position, 1);
    pending.push({
      ...candidate,
      position: mapped.pos,
      anchorDeleted: candidate.anchorDeleted || mapped.deleted,
    });
  }
  let decorations = value.decorations.map(transaction.mapping, transaction.doc);
  for (const candidate of pending) {
    if (
      decorations.find(
        undefined,
        undefined,
        (spec) => spec.key === candidate.requestId,
      ).length === 0
    )
      decorations = decorations.add(transaction.doc, [
        pendingImageDecoration(candidate),
      ]);
  }
  const meta = transaction.getMeta(imageImportPluginKey) as
    ImageImportTransactionMeta | undefined;
  if (meta?.kind === "add") {
    pending.push(meta.request);
    decorations = decorations.add(transaction.doc, [
      pendingImageDecoration(meta.request),
    ]);
  } else if (meta?.kind === "finish") {
    const target = decorations.find(
      undefined,
      undefined,
      (spec) => spec.key === meta.requestId,
    );
    if (target.length) decorations = decorations.remove(target);
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if (pending[index]?.requestId === meta.requestId)
        pending.splice(index, 1);
    }
  } else if (meta?.kind === "clear") {
    pending.length = 0;
    decorations = DecorationSet.empty;
  }
  return { pending, decorations };
}

function filesFromDrop(event: DragEvent): File[] {
  try {
    return Array.from(event.dataTransfer?.files ?? []);
  } catch {
    return [];
  }
}

function isPotentialImageFile(file: File): boolean {
  const mimeType = String(file.type ?? "")
    .trim()
    .toLowerCase();
  return (
    mimeType.startsWith("image/") ||
    Object.prototype.hasOwnProperty.call(
      MIME_BY_EXTENSION,
      extensionOf(file.name),
    )
  );
}

function dropPosition(view: EditorView, event: DragEvent): number | null {
  try {
    const result = view.posAtCoords({
      left: event.clientX,
      top: event.clientY,
    });
    if (
      !result ||
      !Number.isSafeInteger(result.pos) ||
      result.pos < 0 ||
      result.pos > view.state.doc.content.size
    )
      return null;
    return result.pos;
  } catch {
    return null;
  }
}

function imageTransactionAt(
  view: EditorView,
  position: number,
  image: PMNode,
): Transaction | null {
  const safePosition = imageInsertionPosition(view, position, image.type);
  if (safePosition === null) return null;
  try {
    let transaction = view.state.tr.replaceWith(
      safePosition,
      safePosition,
      image,
    );
    try {
      transaction = transaction.setSelection(
        Selection.near(
          transaction.doc.resolve(
            Math.min(
              safePosition + image.nodeSize,
              transaction.doc.content.size,
            ),
          ),
          1,
        ),
      );
    } catch {
      // Keep the insertion when a custom schema cannot create a follow-up
      // selection at the end of the inserted inline node.
    }
    return transaction;
  } catch {
    return null;
  }
}

function imageInsertionPosition(
  view: EditorView,
  position: number,
  imageType: NodeType,
): number | null {
  if (
    !Number.isSafeInteger(position) ||
    position < 0 ||
    position > view.state.doc.content.size
  )
    return null;
  try {
    const resolved = view.state.doc.resolve(position);
    return resolved.parent.inlineContent &&
      resolved.parent.canReplaceWith(
        resolved.index(),
        resolved.index(),
        imageType,
      )
      ? position
      : null;
  } catch {
    return null;
  }
}

function pendingImageDecoration(request: PendingImageImport): Decoration {
  return Decoration.widget(
    request.position,
    () => {
      const label = document.createElement("span");
      label.className = "mm-image-importing";
      label.dataset.requestId = request.requestId;
      label.textContent = "Importing image…";
      label.setAttribute("aria-live", "polite");
      return label;
    },
    { key: request.requestId, side: 1 },
  );
}

async function readFileBytes(file: File): Promise<Uint8Array> {
  if (Number.isFinite(file.size) && file.size > MAX_IMAGE_IMPORT_BYTES)
    throw new Error("The dropped image exceeds the 10 MB size limit.");
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength > MAX_IMAGE_IMPORT_BYTES)
    throw new Error("The dropped image exceeds the 10 MB size limit.");
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize)
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  return btoa(binary);
}

function imageMimeType(file: File): string {
  const supplied = String(file.type ?? "").trim();
  return (
    supplied ||
    MIME_BY_EXTENSION[extensionOf(file.name)] ||
    "image/octet-stream"
  );
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot < 0 ? "" : fileName.slice(dot).toLowerCase();
}

function defaultAltText(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

function isSafeRelativeImagePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\.\/images\/[^/\\]+$/.test(value) &&
    value.length <= 8_192 &&
    !hasControlCharacter(value)
  );
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
