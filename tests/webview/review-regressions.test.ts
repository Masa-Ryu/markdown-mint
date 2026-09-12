import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CellSelection, TableMap } from "prosemirror-tables";
import * as visualRendering from "../../src/core/visualRendering";
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
  it("reuses the edit snapshot when Preview is opened immediately", () => {
    const serialize = vi.fn(serializeMarkdown);
    const render = vi.fn(
      (source: string, profile: DocumentProfile) =>
        `<p data-profile="${profile}">${source}</p>`,
    );
    const { app, root, messages, persisted } = makeApp({
      core: {
        serializeMarkdown: serialize,
        renderMarkdown: render,
      },
    });
    serialize.mockClear();
    render.mockClear();

    app.view.dispatch(app.view.state.tr.insertText("!"));

    const edit = edits(messages)[0];
    expect(edit).toBeDefined();
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(persisted.value).toMatchObject({
      recoveryDraft: edit?.markdown,
    });
    expect(render).not.toHaveBeenCalled();

    const setMode = (mode: EditorMode): void => {
      (
        app as unknown as {
          setMode: (nextMode: EditorMode, requestHost?: boolean) => void;
        }
      ).setMode(mode, false);
    };
    setMode("preview");

    expect(serialize).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledWith(edit?.markdown, "github");
    expect(
      root.querySelector("[data-testid=preview-content]")?.textContent,
    ).toBe(edit?.markdown);

    // Leaving Preview disposes its enhancer. Returning to it must recreate
    // the display even though the Markdown/profile/resource key is unchanged.
    setMode("rich");
    setMode("preview");
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("uses the latest profile and resource when a hidden preview is shown", () => {
    const render = vi.fn(
      (source: string, profile: DocumentProfile) =>
        `<p data-profile="${profile}">${source}</p><img src="image.png">`,
    );
    const { app, root } = makeApp({
      core: { renderMarkdown: render },
    });
    render.mockClear();

    app.receiveDocument(
      hostDocument("latest", 2, {
        profile: "gitlab",
        resourceBaseUrl: "https://example.test/docs/",
        reason: "external",
      }),
    );
    expect(render).not.toHaveBeenCalled();

    (
      app as unknown as {
        setMode: (mode: EditorMode, requestHost?: boolean) => void;
      }
    ).setMode("preview", false);

    expect(render).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledWith("latest", "gitlab");
    expect(
      root.querySelector("[data-testid=preview-content]")?.textContent,
    ).toBe("latest");
    expect(
      root
        .querySelector<HTMLImageElement>("[data-testid=preview-content] img")
        ?.getAttribute("src"),
    ).toBe("https://example.test/docs/image.png");
  });

  it("serializes an edit once and defers hidden preview work until after sync", async () => {
    const serialize = vi.fn(serializeMarkdown);
    const render = vi.fn(renderMarkdown);
    const inspectCompatibility = vi.fn(() => []);
    const { app, messages } = makeApp({
      core: {
        serializeMarkdown: serialize,
        renderMarkdown: render,
        inspectCompatibility,
      },
    });
    serialize.mockClear();
    render.mockClear();
    inspectCompatibility.mockClear();

    app.view.dispatch(app.view.state.tr.insertText("!"));

    expect(serialize).toHaveBeenCalledTimes(1);
    expect(edits(messages)).toHaveLength(1);
    expect(render).not.toHaveBeenCalled();
    expect(inspectCompatibility).not.toHaveBeenCalled();

    await flush();
    expect(inspectCompatibility).toHaveBeenCalledTimes(1);
  });

  it("cancels deferred derived work when the editor is destroyed", async () => {
    const inspectCompatibility = vi.fn(() => []);
    const { app } = makeApp({ core: { inspectCompatibility } });
    inspectCompatibility.mockClear();
    app.view.dispatch(app.view.state.tr.insertText("!"));
    const index = apps.indexOf(app);
    if (index >= 0) apps.splice(index, 1);
    app.destroy();

    await flush();
    expect(inspectCompatibility).not.toHaveBeenCalled();
  });

  it("renders a preview snapshot once when document and preview notifications agree", () => {
    const render = vi.fn((source: string) => `<h1>${source}</h1>`);
    const { app, root } = makeApp({
      core: { renderMarkdown: render },
    });
    render.mockClear();

    app.receiveDocument(
      hostDocument("latest", 2, {
        mode: "preview",
        reason: "external",
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          protocolVersion: PROTOCOL_VERSION,
          type: "preview",
          markdown: "latest",
          html: "<h1>host snapshot</h1>",
          version: 2,
          profile: "github",
        },
      }),
    );

    expect(render).toHaveBeenCalledTimes(1);
    expect(
      root.querySelector("[data-testid=preview-content] h1")?.textContent,
    ).toBe("latest");
  });

  it("ignores a same-version preview from an older profile after document metadata advanced", () => {
    const stale = makeApp({ markdown: "x", profile: "commonmark" });
    stale.app.receiveDocument(
      hostDocument("x", 5, {
        profile: "commonmark",
        reason: "external",
      }),
    );

    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          protocolVersion: PROTOCOL_VERSION,
          type: "preview",
          markdown: "x",
          html: "<h1>stale github</h1>",
          version: 5,
          profile: "github",
        },
      }),
    );

    expect(stale.app.profile).toBe("commonmark");
    expect(stale.app.mode).toBe("rich");
    expect(
      stale.root.querySelector("[data-testid=preview-content]")?.innerHTML,
    ).toBe("");
  });

  it("accepts a same-profile preview paired with its document", () => {
    const paired = makeApp({ markdown: "x", profile: "commonmark" });
    paired.app.receiveDocument(
      hostDocument("x", 5, {
        profile: "github",
        mode: "preview",
        reason: "external",
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          protocolVersion: PROTOCOL_VERSION,
          type: "preview",
          markdown: "x",
          html: "<h1>paired github</h1>",
          version: 5,
          profile: "github",
        },
      }),
    );
    expect(paired.app.profile).toBe("github");
    expect(paired.app.mode).toBe("preview");
  });

  it("accepts a newer preview snapshot", () => {
    const newer = makeApp({
      markdown: "x",
      profile: "commonmark",
      core: {
        renderMarkdown: (source) => `<h1>${source}</h1>`,
      },
    });
    newer.app.receiveDocument(
      hostDocument("x", 5, {
        profile: "commonmark",
        reason: "external",
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          protocolVersion: PROTOCOL_VERSION,
          type: "preview",
          markdown: "new x",
          html: "<h1>new preview</h1>",
          version: 6,
          profile: "github",
        },
      }),
    );
    expect(newer.app.profile).toBe("github");
    expect(newer.app.mode).toBe("preview");
    expect(
      newer.root.querySelector("[data-testid=preview-content] h1")?.textContent,
    ).toBe("new x");
  });

  it("reuses syntax highlighting when an edit only moves an unchanged code block", () => {
    const highlight = vi.spyOn(visualRendering, "highlightCodeSpans");
    try {
      const { app, root } = makeApp({
        markdown: "before\n\n```ts\nconst value = 1;\n```",
      });
      highlight.mockClear();

      app.view.dispatch(app.view.state.tr.insertText("prefix ", 1));

      expect(highlight).not.toHaveBeenCalled();
      expect(root.querySelector(".mm-code-block-pre")?.textContent).toContain(
        "const value = 1;",
      );
    } finally {
      highlight.mockRestore();
    }
  });

  it("applies a later host HTML fallback after a local preview render fails", () => {
    const render = vi.fn(() => {
      throw new Error("local renderer unavailable");
    });
    const { app, root } = makeApp({ core: { renderMarkdown: render } });

    app.receiveDocument(
      hostDocument("latest", 2, {
        mode: "preview",
        reason: "external",
      }),
    );
    const preview = root.querySelector<HTMLElement>(
      "[data-testid=preview-content]",
    )!;
    expect(preview.textContent).toBe("latest");

    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          protocolVersion: PROTOCOL_VERSION,
          type: "preview",
          markdown: "latest",
          html: "<h1>host snapshot</h1>",
          version: 2,
          profile: "github",
        },
      }),
    );

    expect(render).toHaveBeenCalledTimes(1);
    expect(preview.innerHTML).toBe("<h1>host snapshot</h1>");
  });

  it("keeps an external conflict and never sends a queued edit after an old ack", () => {
    const { app, root, messages, persisted } = makeApp({ markdown: "base" });

    app.view.dispatch(app.view.state.tr.insertText(" one"));
    app.view.dispatch(app.view.state.tr.insertText(" two"));
    const pendingEdits = edits(messages);
    expect(pendingEdits).toHaveLength(1);
    const first = pendingEdits[0]!;
    expect(app.sync.queuedEdit?.markdown).toContain("two");

    app.receiveDocument(hostDocument("external", 3, { reason: "external" }));
    expect(root.querySelector(".mm-statusbar")).toBeNull();
    expect(root.querySelector(".mm-recover")).toBeNull();

    app.receiveDocument(
      hostDocument(String(first.markdown), 2, {
        reason: "ack",
        operationId: String(first.operationId),
      }),
    );

    expect(edits(messages)).toHaveLength(1);
    expect(root.querySelector(".mm-status")).toBeNull();
    expect(messages.some((message: any) => message.type === "notify")).toBe(
      true,
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
    const { app, messages } = makeApp({
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
    const continuedSync = edits(messages).length > 1;
    expect(continuedSync).toBe(true);
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

  it("keeps input made during a successful save as a separate unsaved edit", () => {
    const { app, root, messages, persisted } = makeApp({ markdown: "base" });
    const saveEvent = new KeyboardEvent("keydown", {
      key: "s",
      metaKey: true,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    app.view.dom.dispatchEvent(saveEvent);
    const firstSave = messages.find(hasMessageType("save")) as any;
    expect(firstSave).toBeDefined();

    app.view.dispatch(app.view.state.tr.insertText(" after"));
    const localEdit = edits(messages).at(-1)! as any;
    const secondSaveEvent = new KeyboardEvent("keydown", {
      key: "s",
      metaKey: true,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    app.view.dom.dispatchEvent(secondSaveEvent);
    expect(messages.filter(hasMessageType("save"))).toHaveLength(1);

    app.receiveDocument(
      hostDocument("base", 2, {
        operationId: firstSave.operationId,
        reason: "save",
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          protocolVersion: PROTOCOL_VERSION,
          type: "save-result",
          operationId: firstSave.operationId,
          saved: true,
          requestedVersion: firstSave.baseVersion,
          version: 2,
          isDirty: true,
        },
      }),
    );

    expect(app.view.state.doc.textContent).toContain("after");
    expect(root.querySelector(".mm-statusbar")).toBeNull();
    expect(root.querySelector(".mm-status")).toBeNull();
    expect(
      (persisted.value as { recoveryDraft?: string } | undefined)
        ?.recoveryDraft,
    ).toContain("after");

    app.receiveDocument(
      hostDocument(String(localEdit.markdown), 3, {
        operationId: String(localEdit.operationId),
        reason: "ack",
      }),
    );
    expect(messages.filter(hasMessageType("save"))).toHaveLength(2);
    expect(messages.filter(hasMessageType("save")).at(-1)).toMatchObject({
      baseVersion: 3,
    });
  });
});
