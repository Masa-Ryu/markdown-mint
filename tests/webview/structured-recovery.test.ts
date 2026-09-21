import { afterEach, describe, expect, it } from "vitest";
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
  type CoreBridge,
  type DocumentMessage,
  type DocumentProfile,
  type MarkdownEditorApp,
  type VSCodeApiLike,
} from "../../src/webview/editor";

const apps: MarkdownEditorApp[] = [];

afterEach(() => {
  for (const app of apps.splice(0)) app.destroy();
  document.body.replaceChildren();
});

function createCore(
  serialize: CoreBridge["serializeMarkdown"] = serializeMarkdown,
): CoreBridge {
  return {
    schema,
    parseMarkdown,
    serializeMarkdown: serialize,
    renderMarkdown,
  };
}

function createApp(
  state: { value: unknown },
  core: CoreBridge,
  messages: unknown[],
  options: {
    markdown?: string;
    profile?: DocumentProfile;
    documentId?: string;
    version?: number;
  } = {},
): MarkdownEditorApp {
  const root = document.createElement("div");
  document.body.append(root);
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
    core,
    initialDocument: {
      markdown: options.markdown ?? "old",
      version: options.version ?? 1,
      profile: options.profile ?? "github",
      documentId: options.documentId ?? "file:///workspace/doc.md",
    },
  });
  apps.push(app);
  return app;
}

function editMessages(messages: unknown[]): Array<Record<string, unknown>> {
  return messages.filter(
    (message): message is Record<string, unknown> =>
      typeof message === "object" &&
      message !== null &&
      (message as { type?: unknown }).type === "edit",
  );
}

function appendText(app: MarkdownEditorApp, text: string): void {
  const end = TextSelection.atEnd(app.view.state.doc);
  app.view.dispatch(app.view.state.tr.setSelection(end).insertText(text));
}

function acknowledge(
  app: MarkdownEditorApp,
  edit: Record<string, unknown>,
): void {
  app.receiveDocument({
    protocolVersion: PROTOCOL_VERSION,
    type: "document",
    markdown: String(edit.markdown),
    version: 2,
    profile: "github",
    documentId: "file:///workspace/doc.md",
    operationId: String(edit.operationId),
    reason: "ack",
  } satisfies DocumentMessage);
}

describe("structured serializer recovery", () => {
  it.each([
    ["same as the host source", "old"],
    ["different from the host source", "stale recovery source"],
  ])(
    "restores the structured draft when recoveryDraft is %s",
    (_description, recoveryDraft) => {
      const state = { value: undefined as unknown };
      const messages: unknown[] = [];
      const failing = createApp(
        state,
        createCore(() => {
          throw new Error("serializer failure");
        }),
        messages,
      );
      appendText(failing, " NEW INPUT");

      expect(state.value).toMatchObject({
        recoveryDraft: "old",
        recoveryDocument: expect.any(Object),
        recoveryDocumentPending: true,
      });
      state.value = {
        ...(state.value as Record<string, unknown>),
        recoveryDraft,
      };
      failing.destroy();
      apps.splice(apps.indexOf(failing), 1);

      const restoredMessages: unknown[] = [];
      const restored = createApp(state, createCore(), restoredMessages);

      expect(restored.view.state.doc.textContent).toContain("NEW INPUT");
      const edits = editMessages(restoredMessages);
      expect(edits).toHaveLength(1);
      expect(edits[0]?.markdown).toContain("NEW INPUT");
      expect(edits[0]?.markdown).not.toBe("old");

      acknowledge(restored, edits[0]!);
      expect(state.value).toEqual({});
    },
  );

  it("restores source-only footnote definitions with the structured draft", () => {
    const source = "Text[^n].\n\n[^n]: KEEP FOOTNOTE";
    const state = { value: undefined as unknown };
    const failing = createApp(
      state,
      createCore(() => {
        throw new Error("serializer failure");
      }),
      [],
      { markdown: source },
    );
    appendText(failing, " NEW INPUT");
    expect(state.value).toMatchObject({
      recoveryDraft: source,
      recoveryDocument: expect.any(Object),
      recoveryDocumentPending: true,
    });
    state.value = {
      ...(state.value as Record<string, unknown>),
      recoveryDraft: "stale recovery source",
    };
    failing.destroy();
    apps.splice(apps.indexOf(failing), 1);

    const messages: unknown[] = [];
    const restored = createApp(state, createCore(), messages, {
      markdown: source,
    });
    const edits = editMessages(messages);
    expect(edits).toHaveLength(1);
    const recovered = String(edits[0]?.markdown);
    expect(recovered).toContain("NEW INPUT");
    expect(recovered).toContain("[^n]: KEEP FOOTNOTE");
    expect(recovered.match(/\[\^n\]:/g)).toHaveLength(1);

    const reparsed = parseMarkdown(recovered, "github");
    expect(reparsed.footnotes?.map((definition) => definition.content)).toEqual(
      ["KEEP FOOTNOTE"],
    );
    expect(renderMarkdown(recovered, "github")).toContain("KEEP FOOTNOTE");
    restored.destroy();
    apps.splice(apps.indexOf(restored), 1);
  });

  it("restores a source-only footnote after structured recovery", () => {
    const source = "[^n]: KEEP FOOTNOTE";
    const state = { value: undefined as unknown };
    const failing = createApp(
      state,
      createCore(() => {
        throw new Error("serializer failure");
      }),
      [],
      { markdown: source },
    );
    appendText(failing, "NEW INPUT");
    expect(state.value).toMatchObject({
      recoveryDraft: source,
      recoveryDocument: expect.any(Object),
      recoveryDocumentPending: true,
    });
    state.value = {
      ...(state.value as Record<string, unknown>),
      recoveryDraft: "stale recovery source",
    };
    failing.destroy();
    apps.splice(apps.indexOf(failing), 1);

    const messages: unknown[] = [];
    const restored = createApp(state, createCore(), messages, {
      markdown: source,
    });
    const firstEdit = editMessages(messages)[0]!;
    const recovered = String(firstEdit.markdown);
    expect(recovered).toContain("NEW INPUT");
    expect(recovered).toContain("[^n]: KEEP FOOTNOTE");
    expect(recovered.match(/\[\^n\]:/g)).toHaveLength(1);

    const reparsed = parseMarkdown(recovered, "github");
    expect(reparsed.doc.textContent).toContain("NEW INPUT");
    expect(reparsed.footnotes?.map((definition) => definition.content)).toEqual(
      ["KEEP FOOTNOTE"],
    );

    acknowledge(restored, firstEdit);
    appendText(restored, " MORE INPUT");
    const secondEdit = editMessages(messages).at(-1)!;
    expect(secondEdit.markdown).toContain("NEW INPUT");
    expect(secondEdit.markdown).toContain("MORE INPUT");
    expect(secondEdit.markdown).toContain("[^n]: KEEP FOOTNOTE");
    expect(String(secondEdit.markdown).match(/\[\^n\]:/g)).toHaveLength(1);
    restored.destroy();
    apps.splice(apps.indexOf(restored), 1);
  });

  it.each(["\n", "\r\n"])(
    "preserves multiple footnotes and multiline reference definitions with %s line endings",
    (ending) => {
      const source = [
        "Text[^n] and [link][guide].",
        "",
        "Unchanged block.",
        "",
        "[guide]: https://example.com/docs",
        '  "Guide title"',
        "",
        "[^n]: KEEP FOOTNOTE",
        "    continuation line",
        "",
        "[^m]: SECOND FOOTNOTE",
      ].join(ending);
      const state = { value: undefined as unknown };
      const failing = createApp(
        state,
        createCore(() => {
          throw new Error("serializer failure");
        }),
        [],
        { markdown: source },
      );
      appendText(failing, " NEW INPUT");
      failing.destroy();
      apps.splice(apps.indexOf(failing), 1);

      const messages: unknown[] = [];
      const restored = createApp(state, createCore(), messages, {
        markdown: source,
      });
      const firstEdit = editMessages(messages)[0]!;
      const recovered = String(firstEdit.markdown);
      expect(recovered).toContain("NEW INPUT");
      expect(recovered).toContain("Unchanged block");
      expect(recovered).toContain("[^n]: KEEP FOOTNOTE");
      expect(recovered).toContain("    continuation line");
      expect(recovered).toContain("[^m]: SECOND FOOTNOTE");
      expect(recovered).toContain(
        ["[guide]: https://example.com/docs", '  "Guide title"'].join(ending),
      );
      expect(recovered.match(/\[\^n\]:/g)).toHaveLength(1);
      expect(recovered.match(/\[\^m\]:/g)).toHaveLength(1);
      expect(recovered.match(/\[guide\]:/g)).toHaveLength(1);
      if (ending === "\r\n")
        expect(recovered.replace(/\r\n/g, "")).not.toContain("\n");
      else expect(recovered).not.toContain("\r");

      const reparsed = parseMarkdown(recovered, "github");
      expect(
        reparsed.footnotes?.map((definition) => definition.content),
      ).toEqual(["KEEP FOOTNOTE\ncontinuation line", "SECOND FOOTNOTE"]);
      let linkHref: unknown;
      reparsed.doc.descendants((node) => {
        const link = node.marks.find((mark) => mark.type.name === "link");
        if (link) linkHref = link.attrs.href;
      });
      expect(linkHref).toBe("https://example.com/docs");
      expect(renderMarkdown(recovered, "github")).toContain("KEEP FOOTNOTE");

      acknowledge(restored, firstEdit);
      appendText(restored, " MORE INPUT");
      const secondEdit = editMessages(messages).at(-1)!;
      expect(secondEdit.markdown).toContain("NEW INPUT");
      expect(secondEdit.markdown).toContain("MORE INPUT");
      expect(secondEdit.markdown).toContain("[^n]: KEEP FOOTNOTE");
      expect(secondEdit.markdown).toContain("[^m]: SECOND FOOTNOTE");
      expect(secondEdit.markdown).toContain(
        "[guide]: https://example.com/docs",
      );
      restored.destroy();
      apps.splice(apps.indexOf(restored), 1);
    },
  );

  it("keeps structured recovery pending when its source provenance is incomplete", () => {
    const source = "Text[^n].\n\n[^n]: KEEP FOOTNOTE";
    const state = { value: undefined as unknown };
    const failing = createApp(
      state,
      createCore(() => {
        throw new Error("serializer failure");
      }),
      [],
      { markdown: source },
    );
    appendText(failing, " NEW INPUT");
    const legacyState = { ...(state.value as Record<string, unknown>) };
    delete legacyState.recoveryBaseMarkdown;
    delete legacyState.recoveryBaseVersion;
    state.value = legacyState;
    failing.destroy();
    apps.splice(apps.indexOf(failing), 1);

    const messages: unknown[] = [];
    const restored = createApp(state, createCore(), messages, {
      markdown: source,
    });
    expect(restored.view.state.doc.textContent).not.toContain("NEW INPUT");
    expect(editMessages(messages)).toHaveLength(0);
    expect(state.value).toMatchObject({
      recoveryDraft: source,
      recoveryDocument: expect.any(Object),
      recoveryDocumentPending: true,
    });
    restored.destroy();
    apps.splice(apps.indexOf(restored), 1);
  });

  it.each([
    ["same as the host source", "old"],
    ["different from the host source", "stale recovery source"],
  ])(
    "retains structured recovery when recoveryDocument is invalid and recoveryDraft is %s",
    (_description, recoveryDraft) => {
      const state = { value: undefined as unknown };
      const failing = createApp(
        state,
        createCore(() => {
          throw new Error("serializer failure");
        }),
        [],
      );
      appendText(failing, " NEW INPUT");
      const invalidRecoveryDocument = {
        type: "invalid-recovery-document",
      };
      state.value = {
        ...(state.value as Record<string, unknown>),
        recoveryDraft,
        recoveryDocument: invalidRecoveryDocument,
        recoveryDocumentPending: true,
      };
      failing.destroy();
      apps.splice(apps.indexOf(failing), 1);

      const messages: unknown[] = [];
      const restored = createApp(state, createCore(), messages);

      expect(restored.view.state.doc.textContent).toBe("old");
      expect(editMessages(messages)).toHaveLength(0);
      expect(state.value).toMatchObject({
        recoveryDraft,
        recoveryDocument: invalidRecoveryDocument,
        recoveryDocumentPending: true,
      });
    },
  );

  it.each([
    ["same as the host source", "host source"],
    ["different from the host source", "stale recovery source"],
  ])(
    "does not auto-restore ambiguous legacy recovery when recoveryDraft is %s",
    (_description, recoveryDraft) => {
      const legacyDocument = parseMarkdown(
        "OLD PM CONTENT",
        "github",
      ).doc.toJSON();
      const legacyState = {
        recoveryDraft,
        recoveryBaseMarkdown: "host source",
        recoveryBaseVersion: 1,
        recoveryVersion: 1,
        recoveryProfile: "github" as const,
        recoveryDocument: legacyDocument,
        documentId: "file:///workspace/doc.md",
      };
      const state = { value: legacyState as unknown };
      const messages: unknown[] = [];
      const restored = createApp(state, createCore(), messages, {
        markdown: "host source",
      });

      expect(restored.view.state.doc.textContent).toContain("host source");
      expect(restored.view.state.doc.textContent).not.toContain(
        "OLD PM CONTENT",
      );
      expect(editMessages(messages)).toHaveLength(0);
      expect(state.value).toEqual(legacyState);

      restored.receiveDocument({
        protocolVersion: PROTOCOL_VERSION,
        type: "document",
        markdown: "host source",
        version: 2,
        profile: "github",
        documentId: "file:///workspace/doc.md",
        reason: "external",
      });
      expect(state.value).toEqual(legacyState);
    },
  );

  it("uses recoveryDraft for non-structured recovery when pending is false", () => {
    const legacyDocument = parseMarkdown(
      "OLD PM CONTENT",
      "github",
    ).doc.toJSON();
    const state = {
      value: {
        recoveryDraft: "recovered source",
        recoveryBaseMarkdown: "host source",
        recoveryBaseVersion: 1,
        recoveryVersion: 1,
        recoveryProfile: "github" as const,
        recoveryDocument: legacyDocument,
        recoveryDocumentPending: false,
        documentId: "file:///workspace/doc.md",
      } as unknown,
    };
    const messages: unknown[] = [];
    const restored = createApp(state, createCore(), messages, {
      markdown: "host source",
    });

    expect(restored.view.state.doc.textContent).toContain("recovered source");
    expect(restored.view.state.doc.textContent).not.toContain("OLD PM CONTENT");
    const edits = editMessages(messages);
    expect(edits).toHaveLength(1);
    expect(edits[0]?.markdown).toContain("recovered source");
  });

  it("keeps the structured draft after a second serializer failure", () => {
    const state = { value: undefined as unknown };
    const initialMessages: unknown[] = [];
    const failing = createApp(
      state,
      createCore(() => {
        throw new Error("serializer failure");
      }),
      initialMessages,
    );
    appendText(failing, " NEW INPUT");
    failing.destroy();
    apps.splice(apps.indexOf(failing), 1);

    const restoreMessages: unknown[] = [];
    const restored = createApp(
      state,
      createCore(() => {
        throw new Error("serializer failure again");
      }),
      restoreMessages,
    );

    expect(restored.view.state.doc.textContent).toContain("NEW INPUT");
    expect(editMessages(restoreMessages)).toHaveLength(0);
    expect(state.value).toMatchObject({
      recoveryDraft: "old",
      recoveryDocument: expect.any(Object),
      recoveryDocumentPending: true,
    });
    restored.receiveDocument({
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      markdown: "old",
      version: 2,
      profile: "github",
      documentId: "file:///workspace/doc.md",
      operationId: "stale-ack",
      reason: "ack",
    });
    expect(state.value).toMatchObject({
      recoveryDraft: "old",
      recoveryDocument: expect.any(Object),
      recoveryDocumentPending: true,
    });
    restored.destroy();
    apps.splice(apps.indexOf(restored), 1);
    const repeated = createApp(
      state,
      createCore(() => {
        throw new Error("serializer failure a third time");
      }),
      [],
    );
    expect(repeated.view.state.doc.textContent).toContain("NEW INPUT");
    expect(state.value).toMatchObject({
      recoveryDocument: expect.any(Object),
      recoveryDocumentPending: true,
    });
  });

  it.each([
    ["another document", { documentId: "file:///workspace/other.md" }],
    ["a changed base", { markdown: "new host source" }],
    ["another profile", { profile: "gitlab" as const }],
  ])(
    "does not auto-restore structured recovery for %s",
    (_description, options) => {
      const state = { value: undefined as unknown };
      const failing = createApp(
        state,
        createCore(() => {
          throw new Error("serializer failure");
        }),
        [],
      );
      appendText(failing, " NEW INPUT");
      failing.destroy();
      apps.splice(apps.indexOf(failing), 1);

      const messages: unknown[] = [];
      const unchanged = createApp(state, createCore(), messages, options);

      expect(unchanged.view.state.doc.textContent).not.toContain("NEW INPUT");
      expect(editMessages(messages)).toHaveLength(0);
      expect(state.value).toMatchObject({
        recoveryDocument: expect.any(Object),
      });
    },
  );
});
