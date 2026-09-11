import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CellSelection, TableMap } from "prosemirror-tables";
import {
  parseMarkdown,
  renderMarkdown,
  schema,
  serializeMarkdown,
} from "../../src/core";
import { PROTOCOL_VERSION } from "../../src/shared/protocol";
import { TextSelection } from "prosemirror-state";
import {
  createEditorApp,
  type CoreBridge,
  type DocumentMessage,
  type DocumentProfile,
  type EditorMode,
  type MarkdownEditorApp,
  type VSCodeApiLike,
} from "../../src/webview/editor";

interface AppOptions {
  markdown?: string;
  profile?: DocumentProfile;
  mode?: "editor" | "preview";
  withHost?: boolean;
  core?: Partial<CoreBridge>;
}

const apps: MarkdownEditorApp[] = [];

function makeApp(options: AppOptions = {}): {
  app: MarkdownEditorApp;
  root: HTMLElement;
  messages: unknown[];
  persisted: { value: unknown };
} {
  const root = document.createElement("div");
  document.body.append(root);
  const messages: unknown[] = [];
  const persisted = { value: undefined as unknown };
  const withHost = options.withHost ?? true;
  const vscode: VSCodeApiLike = {
    postMessage: (message) => messages.push(message),
    getState: () => persisted.value,
    setState: (state) => {
      persisted.value = state;
    },
  };
  const core: CoreBridge = {
    schema,
    parseMarkdown,
    serializeMarkdown,
    renderMarkdown,
    ...options.core,
  };
  const appOptions = {
    root,
    core,
    initialDocument: {
      markdown: options.markdown ?? "base",
      version: 1,
      profile: options.profile ?? "github",
      ...(options.mode ? { mode: options.mode } : {}),
    },
    ...(withHost ? { vscode } : {}),
  };
  const app = createEditorApp(appOptions);
  apps.push(app);
  return { app, root, messages, persisted };
}

function hostDocument(
  markdown: string,
  version: number,
  options: Partial<DocumentMessage> = {},
): DocumentMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "document",
    markdown,
    version,
    profile: options.profile ?? "github",
    ...options,
  };
}

function edits(messages: unknown[]): Array<Record<string, unknown>> {
  return messages.filter(
    (message): message is Record<string, unknown> =>
      typeof message === "object" &&
      message !== null &&
      (message as { type?: unknown }).type === "edit",
  );
}

function hasMessageType(type: string): (message: unknown) => boolean {
  return (message): boolean =>
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === type;
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function selectWholeTable(app: MarkdownEditorApp): CellSelection {
  const table = app.view.state.doc.child(0);
  const map = TableMap.get(table);
  const firstCell = map.map[0]! + 1;
  const lastCell = map.map[map.map.length - 1]! + 1;
  const selection = CellSelection.create(
    app.view.state.doc,
    firstCell,
    lastCell,
  );
  app.view.dispatch(app.view.state.tr.setSelection(selection));
  return selection;
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

describe("reviewed webview synchronization races", () => {
  it("keeps an external conflict and never sends a queued edit after an old ack", () => {
    const { app, root, messages, persisted } = makeApp({ markdown: "base" });

    app.view.dispatch(app.view.state.tr.insertText(" one"));
    app.view.dispatch(app.view.state.tr.insertText(" two"));
    const pendingEdits = edits(messages);
    expect(pendingEdits).toHaveLength(1);
    const first = pendingEdits[0]!;
    expect(app.sync.queuedEdit?.markdown).toContain("two");

    app.receiveDocument(hostDocument("external", 3, { reason: "external" }));
    expect(root.querySelector(".mm-recover")?.hasAttribute("hidden")).toBe(
      false,
    );

    app.receiveDocument(
      hostDocument(String(first.markdown), 2, {
        reason: "ack",
        operationId: String(first.operationId),
      }),
    );

    expect(edits(messages)).toHaveLength(1);
    expect(root.querySelector<HTMLElement>(".mm-status")?.dataset.state).toBe(
      "conflict",
    );
    expect(app.view.state.doc.textContent).toContain("one");
    expect(
      (persisted.value as { recoveryDraft?: string } | undefined)
        ?.recoveryDraft,
    ).toContain("two");

    app.view.dispatch(app.view.state.tr.insertText(" later"));
    expect(edits(messages)).toHaveLength(1);
    expect(
      (persisted.value as { recoveryDraft?: string } | undefined)
        ?.recoveryDraft,
    ).toContain("later");
  });

  it("does not let a profile change disappear when an older edit is acknowledged", () => {
    const { app, root, messages } = makeApp({
      markdown: "base",
      profile: "github",
    });

    app.view.dispatch(app.view.state.tr.insertText(" changed"));
    const first = edits(messages)[0]!;
    app.receiveDocument(
      hostDocument("base", 1, {
        profile: "gitlab",
        reason: "external",
      }),
    );
    app.receiveDocument(
      hostDocument(String(first.markdown), 2, {
        profile: "gitlab",
        reason: "ack",
        operationId: String(first.operationId),
      }),
    );

    expect(app.profile).toBe("gitlab");
    expect(app.view.state.doc.textContent).toContain("changed");
    expect(edits(messages)).toHaveLength(1);

    app.view.dispatch(app.view.state.tr.insertText(" again"));
    const status = root.querySelector<HTMLElement>(".mm-status");
    const continuedSync = edits(messages).length > 1;
    const explicitConflict =
      status?.dataset.state === "conflict" &&
      root.querySelector(".mm-recover")?.hasAttribute("hidden") === false;
    expect(continuedSync || explicitConflict).toBe(true);
  });

  it("does not request preview recursively when a dedicated preview is initialized or applied", () => {
    const { app, messages } = makeApp({
      markdown: "# Preview",
      mode: "preview",
    });

    expect(messages.filter(hasMessageType("preview"))).toHaveLength(0);
    app.receiveDocument(
      hostDocument("# Preview", 1, {
        mode: "preview",
        reason: "external",
      }),
    );
    expect(messages.filter(hasMessageType("preview"))).toHaveLength(0);
  });

  it("keeps a valid text cursor when an external snapshot changes block structure", () => {
    const { app } = makeApp({ markdown: "A longer paragraph" });
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, 8),
      ),
    );

    app.receiveDocument(
      hostDocument("- One\n- Two", 2, { reason: "external" }),
    );

    expect(app.view.state.selection.$from.parent.isTextblock).toBe(true);
    expect(() =>
      app.view.dom.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      ),
    ).not.toThrow();
  });

  it("keeps a CellSelection and rich mode after equivalent formatting", async () => {
    const source = "| A | B |\n| --- | --- |\n| C | D |";
    const { app, root } = makeApp({
      markdown: source,
      withHost: false,
      core: {
        formatMarkdown: async (current) => `${current}\n`,
      },
    });
    const originalSelection = selectWholeTable(app);
    expect(app.mode).toBe<EditorMode>("rich");

    root
      .querySelector<HTMLButtonElement>('[aria-label="Format Markdown"]')!
      .click();
    await flush();

    expect(app.mode).toBe("rich");
    expect(app.view.state.selection).toBeInstanceOf(CellSelection);
    const selection = app.view.state.selection as CellSelection;
    expect(selection.$anchorCell.pos).toBe(originalSelection.$anchorCell.pos);
    expect(selection.$headCell.pos).toBe(originalSelection.$headCell.pos);
  });

  it("keeps Preview selected while a host format result preserves the CellSelection", () => {
    const source = "| A | B |\n| --- | --- |\n| C | D |";
    const { app } = makeApp({ markdown: source });
    const originalSelection = selectWholeTable(app);
    app.receiveDocument(
      hostDocument(source, 2, {
        mode: "preview",
        reason: "external",
      }),
    );
    expect(app.mode).toBe("preview");

    app.receiveDocument(
      hostDocument(`${source}\n`, 2, {
        reason: "format",
        mode: "editor",
      }),
    );

    expect(app.mode).toBe("preview");
    expect(app.view.state.selection).toBeInstanceOf(CellSelection);
    const selection = app.view.state.selection as CellSelection;
    expect(selection.$anchorCell.pos).toBe(originalSelection.$anchorCell.pos);
    expect(selection.$headCell.pos).toBe(originalSelection.$headCell.pos);

    (
      app as unknown as {
        setMode: (mode: "rich", requestHost?: boolean) => void;
      }
    ).setMode("rich", false);
    expect(app.mode).toBe("rich");
    expect(app.view.state.selection).toBeInstanceOf(CellSelection);
    const richSelection = app.view.state.selection as CellSelection;
    expect(richSelection.$anchorCell.pos).toBe(
      originalSelection.$anchorCell.pos,
    );
    expect(richSelection.$headCell.pos).toBe(originalSelection.$headCell.pos);
  });

  it("defers Cmd-S until both the inflight and queued edits are acknowledged", () => {
    const { app, messages } = makeApp({ markdown: "base" });
    const editor = app.view.dom;

    app.view.dispatch(app.view.state.tr.insertText(" one"));
    app.view.dispatch(app.view.state.tr.insertText(" two"));
    const pendingEdits = edits(messages);
    expect(pendingEdits).toHaveLength(1);
    const first = pendingEdits[0]!;
    expect(app.sync.queuedEdit?.markdown).toContain("two");

    const saveEvent = new KeyboardEvent("keydown", {
      key: "s",
      metaKey: true,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    editor.dispatchEvent(saveEvent);
    expect(saveEvent.defaultPrevented).toBe(true);
    expect(messages.filter(hasMessageType("save"))).toHaveLength(0);

    app.receiveDocument(
      hostDocument(String(first.markdown), 2, {
        reason: "ack",
        operationId: String(first.operationId),
      }),
    );
    expect(messages.filter(hasMessageType("save"))).toHaveLength(0);

    const second = edits(messages)[1]!;
    expect(second).toBeDefined();

    app.receiveDocument(
      hostDocument(String(second.markdown), 3, {
        reason: "ack",
        operationId: String(second.operationId),
      }),
    );
    const saveMessages = messages.filter(hasMessageType("save"));
    expect(saveMessages).toHaveLength(1);
    expect(saveMessages[0]).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      type: "save",
      baseVersion: 3,
    });
  });
});
