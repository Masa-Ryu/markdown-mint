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
