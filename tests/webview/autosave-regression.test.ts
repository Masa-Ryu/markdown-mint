import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TextSelection } from "prosemirror-state";
import {
  parseMarkdown,
  renderMarkdown,
  schema,
  serializeMarkdown,
} from "../../src/core";
import { PROTOCOL_VERSION } from "../../src/shared/protocol";
import {
  createEditorApp,
  type DocumentMessage,
  type DocumentProfile,
  type MarkdownEditorApp,
  type VSCodeApiLike,
} from "../../src/webview/editor";

interface LocalEdit {
  readonly type: "edit";
  readonly baseVersion: number;
  readonly operationId: string;
  readonly markdown: string;
}

interface AppHarness {
  readonly app: MarkdownEditorApp;
  readonly root: HTMLElement;
  readonly messages: unknown[];
}

const apps: MarkdownEditorApp[] = [];

function makeApp(
  markdown: string,
  profile: DocumentProfile = "github",
): AppHarness {
  const root = document.createElement("div");
  document.body.append(root);
  const messages: unknown[] = [];
  const state = { value: undefined as unknown };
  const vscode: VSCodeApiLike = {
    postMessage: (message) => messages.push(message),
    getState: () => state.value,
    setState: (next) => {
      state.value = next;
    },
  };
  const app = createEditorApp({
    root,
    vscode,
    core: { schema, parseMarkdown, serializeMarkdown, renderMarkdown },
    initialDocument: { markdown, version: 1, profile },
  });
  apps.push(app);
  return { app, root, messages };
}

function isEdit(message: unknown): message is LocalEdit {
  if (!message || typeof message !== "object") return false;
  const candidate = message as Record<string, unknown>;
  return (
    candidate.type === "edit" &&
    typeof candidate.baseVersion === "number" &&
    typeof candidate.operationId === "string" &&
    typeof candidate.markdown === "string"
  );
}

function edits(messages: readonly unknown[]): LocalEdit[] {
  return messages.filter(isEdit);
}

function lastEdit(messages: readonly unknown[]): LocalEdit {
  const edit = edits(messages).at(-1);
  if (!edit) throw new Error("expected a webview edit message");
  return edit;
}

function hostDocument(
  markdown: string,
  version: number,
  options: {
    readonly operationId?: string;
    readonly profile?: DocumentProfile;
    readonly reason?: string;
    readonly mode?: "editor" | "preview";
  } = {},
): DocumentMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "document",
    markdown,
    version,
    profile: options.profile ?? "github",
    ...(options.operationId === undefined
      ? {}
      : { operationId: options.operationId }),
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
  };
}

function addTrailingEmptyParagraph(app: MarkdownEditorApp): TextSelection {
  const end = TextSelection.atEnd(app.view.state.doc);
  app.view.dispatch(app.view.state.tr.setSelection(end).split(end.from));
  const position = app.view.state.doc.content.size - 1;
  const selection = TextSelection.create(app.view.state.doc, position);
  app.view.dispatch(app.view.state.tr.setSelection(selection));
  return selection;
}

function expectNoConflict(root: HTMLElement): void {
  expect(root.querySelector(".mm-statusbar")).toBeNull();
  expect(root.querySelector(".mm-status")).toBeNull();
  expect(root.querySelector(".mm-recover")).toBeNull();
}

function expectEmptyParagraphCaret(app: MarkdownEditorApp): void {
  const selection = app.view.state.selection;
  expect(selection).toBeInstanceOf(TextSelection);
  expect(selection.$from.parent.type.name).toBe("paragraph");
  expect(selection.$from.parent.content.size).toBe(0);
}

beforeEach(() => {
  document.body.replaceChildren();
  if (typeof Element.prototype.getClientRects !== "function")
    Object.defineProperty(Element.prototype, "getClientRects", {
      configurable: true,
      value: () => [],
    });
  if (typeof Text !== "undefined" && !("getClientRects" in Text.prototype))
    Object.defineProperty(Text.prototype, "getClientRects", {
      configurable: true,
      value: () => [],
    });
  if (typeof Range !== "undefined" && !Range.prototype.getClientRects)
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [],
    });
  if (typeof Range !== "undefined" && !Range.prototype.getBoundingClientRect)
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        bottom: 0,
        height: 0,
        left: 0,
        right: 0,
        top: 0,
        width: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });
});

afterEach(() => {
  for (const app of apps) app.destroy();
  apps.length = 0;
  document.body.replaceChildren();
});

describe("autosave and authoritative snapshot regressions", () => {
  it("keeps the empty paragraph and caret across an edit ack and equal external snapshot", () => {
    const { app, messages, root } = makeApp("# Autosave\n\nBody");
    const selection = addTrailingEmptyParagraph(app);
    const beforeState = app.view.state;
    const beforeDoc = beforeState.doc;
    const edit = lastEdit(messages);
    expect(edit.markdown).toMatch(/\n\n$/u);

    app.receiveDocument(
      hostDocument(edit.markdown, 2, {
        operationId: edit.operationId,
        reason: "ack",
      }),
    );
    const acknowledgedState = app.view.state;
    expect(acknowledgedState).toBe(beforeState);

    app.receiveDocument(hostDocument(edit.markdown, 2, { reason: "external" }));

    expect(app.view.state).toBe(acknowledgedState);
    expect(app.view.state.doc).toBe(beforeDoc);
    expect(app.view.state.selection.eq(selection)).toBe(true);
    expectEmptyParagraphCaret(app);
    expect(edits(messages)).toHaveLength(1);
    expectNoConflict(root);
  });

  it("preserves the empty paragraph through trimFinalNewlines and permits the next input without a snapshot re-enqueue", () => {
    const { app, messages, root } = makeApp("# Autosave\n\nBody");
    const selection = addTrailingEmptyParagraph(app);
    const edit = lastEdit(messages);
    expect(edit.markdown).toMatch(/\n\n$/u);
    app.receiveDocument(
      hostDocument(edit.markdown, 2, {
        operationId: edit.operationId,
        reason: "ack",
      }),
    );
    const beforeTrimCount = edits(messages).length;
    const stateBeforeTrim = app.view.state;
    const trimmed = edit.markdown.replace(/\n+$/u, "\n");
    expect(trimmed).not.toBe(edit.markdown);

    app.receiveDocument(hostDocument(trimmed, 3, { reason: "external" }));

    expect(app.view.state).toBe(stateBeforeTrim);
    expect(app.view.state.selection.eq(selection)).toBe(true);
    expectEmptyParagraphCaret(app);
    expect(edits(messages)).toHaveLength(beforeTrimCount);
    expectNoConflict(root);

    app.view.dispatch(app.view.state.tr.insertText("Next"));

    const next = edits(messages).at(-1);
    expect(edits(messages)).toHaveLength(beforeTrimCount + 1);
    expect(next?.baseVersion).toBe(3);
    expect(next?.markdown).toContain("Next");
  });

  it("keeps the caret for terminal single-space cleanup while applying semantic hard-break and code whitespace changes", () => {
    const cleanup = makeApp("Body");
    const end = TextSelection.atEnd(cleanup.app.view.state.doc);
    cleanup.app.view.dispatch(
      cleanup.app.view.state.tr.setSelection(end).insertText(" "),
    );
    const localSpaceEdit = lastEdit(cleanup.messages);
    expect(cleanup.app.view.state.doc.textContent).toBe("Body ");
    const caret = cleanup.app.view.state.selection;
    const stateBeforeCleanup = cleanup.app.view.state;
    cleanup.app.receiveDocument(
      hostDocument(localSpaceEdit.markdown, 2, {
        operationId: localSpaceEdit.operationId,
        reason: "ack",
      }),
    );
    cleanup.app.receiveDocument(
      hostDocument("Body", 3, { reason: "external" }),
    );
    expect(cleanup.app.view.state).toBe(stateBeforeCleanup);
    expect(cleanup.app.view.state.selection.eq(caret)).toBe(true);
    expect(cleanup.app.view.state.doc.textContent).toBe("Body ");
    expect(edits(cleanup.messages)).toHaveLength(1);

    const hardBreak = makeApp("Body");
    const hardBreakSource = "Body  \nNext";
    const hardBreakBefore = hardBreak.app.view.state.doc;
    hardBreak.app.receiveDocument(
      hostDocument(hardBreakSource, 2, { reason: "external" }),
    );
    expect(hardBreak.app.view.state.doc.eq(hardBreakBefore)).toBe(false);
    expect(
      hardBreak.app.view.state.doc.eq(
        parseMarkdown(hardBreakSource, "github").doc,
      ),
    ).toBe(true);
    let hasHardBreak = false;
    hardBreak.app.view.state.doc.descendants((node) => {
      if (node.type.name === "hard_break") hasHardBreak = true;
    });
    expect(hasHardBreak).toBe(true);

    const code = makeApp("```\nvalue x\n```");
    const codeSource = "```\nvalue  x\n```";
    const codeBefore = code.app.view.state.doc;
    code.app.receiveDocument(
      hostDocument(codeSource, 2, { reason: "external" }),
    );
    expect(code.app.view.state.doc.eq(codeBefore)).toBe(false);
    expect(
      code.app.view.state.doc.eq(parseMarkdown(codeSource, "github").doc),
    ).toBe(true);
    expect(code.app.view.state.doc.textContent).toContain("value  x");
  });

  it("does not turn an equal authoritative snapshot into a conflict while edits are queued", () => {
    const queued = makeApp("base");
    queued.app.view.dispatch(queued.app.view.state.tr.insertText(" one"));
    queued.app.view.dispatch(queued.app.view.state.tr.insertText(" two"));
    const queuedEdits = edits(queued.messages);
    expect(queuedEdits).toHaveLength(1);
    const first = queuedEdits[0]!;
    const secondMarkdown = queued.app.view.state.doc.textContent;

    queued.app.receiveDocument(hostDocument("base", 2, { reason: "external" }));
    expectNoConflict(queued.root);
    expect(queued.app.view.state.doc.textContent).toBe(secondMarkdown);

    queued.app.receiveDocument(
      hostDocument(first.markdown, 3, {
        operationId: first.operationId,
        reason: "ack",
      }),
    );
    expect(edits(queued.messages)).toHaveLength(2);
    expect(edits(queued.messages)[1]?.baseVersion).toBe(3);
    expect(edits(queued.messages)[1]?.markdown).toContain("two");
    expectNoConflict(queued.root);
  });

  it("does not retain an equal authoritative snapshot as pending external during IME composition", () => {
    const composing = makeApp("local");
    const editor = composing.root.querySelector<HTMLElement>(".ProseMirror")!;
    editor.dispatchEvent(new Event("compositionstart", { bubbles: true }));

    composing.app.receiveDocument(
      hostDocument("local", 2, { reason: "external" }),
    );
    expectNoConflict(composing.root);
    expect(composing.app.sync.hasPending).toBe(false);

    composing.app.view.dispatch(composing.app.view.state.tr.insertText("変換"));
    const imeEdit = lastEdit(composing.messages);
    expect(imeEdit.baseVersion).toBe(2);
    composing.app.receiveDocument(
      hostDocument(imeEdit.markdown, 3, {
        operationId: imeEdit.operationId,
        reason: "ack",
      }),
    );
    editor.dispatchEvent(new Event("compositionend", { bubbles: true }));
    expectNoConflict(composing.root);
    expect(composing.app.sync.hasPending).toBe(false);
    expect(composing.app.view.state.doc.textContent).toContain("変換");

    composing.app.view.dispatch(composing.app.view.state.tr.insertText("後"));
    expect(edits(composing.messages)).toHaveLength(2);
  });

  it("applies real external and history snapshots while retaining an unsafe overlap", () => {
    const { app, messages } = makeApp("one");
    const external = "two";
    app.receiveDocument(hostDocument(external, 2, { reason: "external" }));
    expect(app.view.state.doc.eq(parseMarkdown(external, "github").doc)).toBe(
      true,
    );

    app.receiveDocument(hostDocument("one", 3, { reason: "undo" }));
    expect(app.view.state.doc.eq(parseMarkdown("one", "github").doc)).toBe(
      true,
    );
    app.receiveDocument(hostDocument(external, 4, { reason: "redo" }));
    expect(app.view.state.doc.eq(parseMarkdown(external, "github").doc)).toBe(
      true,
    );

    const reload = makeApp("local");
    reload.app.view.dispatch(reload.app.view.state.tr.insertText(" draft"));
    const reloadEdit = lastEdit(reload.messages);
    reload.app.receiveDocument(
      hostDocument("authoritative", 2, { reason: "external" }),
    );
    expect(reload.app.view.state.doc.textContent).toContain("draft");
    expect(reload.root.querySelector(".mm-statusbar")).toBeNull();
    expect(reload.root.querySelector(".mm-recover")).toBeNull();
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          protocolVersion: PROTOCOL_VERSION,
          type: "edit-rejected",
          operationId: reloadEdit.operationId,
          reason: "stale",
          message: "The document changed.",
          currentMarkdown: "authoritative",
          currentVersion: 2,
          draftMarkdown: reloadEdit.markdown,
        },
      }),
    );
    expect(
      reload.messages.some((message: any) => message.type === "notify"),
    ).toBe(true);
    // The standard source route remains available for a genuinely unsafe
    // overlap; no custom recovery control is required.
    reload.root
      .querySelector<HTMLButtonElement>('[data-mode="source"]')!
      .click();
    expect(
      reload.messages.some((message: any) => message.type === "source"),
    ).toBe(true);
    expect(app.view.state.doc.textContent).toBe("two");
    expect(messages.filter(isEdit)).toHaveLength(0);
  });
});
