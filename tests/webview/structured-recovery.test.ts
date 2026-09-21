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
    setState?: (next: unknown) => void;
  } = {},
): MarkdownEditorApp {
  const root = document.createElement("div");
  document.body.append(root);
  const vscode: VSCodeApiLike = {
    postMessage: (message) => messages.push(message),
    getState: () => state.value,
    setState: (next) => {
      options.setState?.(next);
      if (!options.setState) state.value = next;
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
  version = 2,
): void {
  app.receiveDocument({
    protocolVersion: PROTOCOL_VERSION,
    type: "document",
    markdown: String(edit.markdown),
    version,
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

  it("keeps a withheld structured draft beside later input and acknowledgements", () => {
    const state = { value: undefined as unknown };
    const failing = createApp(
      state,
      createCore(() => {
        throw new Error("serializer failure");
      }),
      [],
    );
    appendText(failing, " NEW INPUT");
    const withheld = state.value;
    expect(withheld).toMatchObject({
      recoveryDraft: "old",
      recoveryDocument: expect.any(Object),
      recoveryDocumentPending: true,
    });
    failing.destroy();
    apps.splice(apps.indexOf(failing), 1);

    const messages: unknown[] = [];
    const current = createApp(state, createCore(), messages, {
      markdown: "external",
      version: 2,
    });
    appendText(current, " NEXT");
    const currentEdit = editMessages(messages).at(-1)!;

    expect(state.value).toMatchObject({
      recoveryDraft: "external NEXT",
      pendingRecovery: {
        recoveryDraft: "old",
        recoveryDocument: (withheld as { recoveryDocument: unknown })
          .recoveryDocument,
        recoveryDocumentPending: true,
      },
    });

    acknowledge(current, currentEdit, 3);
    expect(state.value).toMatchObject({
      pendingRecovery: {
        recoveryDraft: "old",
        recoveryDocumentPending: true,
      },
    });
    expect((state.value as { recoveryDraft?: string }).recoveryDraft).toBe(
      undefined,
    );
    current.destroy();
    apps.splice(apps.indexOf(current), 1);

    const recreatedMessages: unknown[] = [];
    const recreated = createApp(state, createCore(), recreatedMessages, {
      markdown: "external NEXT",
      version: 3,
    });
    expect(recreated.view.state.doc.textContent).toBe("external NEXT");
    expect(state.value).toMatchObject({
      pendingRecovery: {
        recoveryDraft: "old",
        recoveryDocument: expect.any(Object),
        recoveryDocumentPending: true,
      },
    });
    expect(editMessages(recreatedMessages)).toHaveLength(0);
    recreated.destroy();
    apps.splice(apps.indexOf(recreated), 1);
  });

  it("retains a withheld draft through implicit ACK and an external update", () => {
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
    const current = createApp(state, createCore(), messages, {
      markdown: "external",
      version: 2,
    });
    appendText(current, " NEXT");
    const edit = editMessages(messages).at(-1)!;

    current.receiveDocument({
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      markdown: String(edit.markdown),
      version: 3,
      profile: "github",
      documentId: "file:///workspace/doc.md",
      reason: "ack",
    });
    expect(state.value).toMatchObject({
      pendingRecovery: {
        recoveryDraft: "old",
        recoveryDocument: expect.any(Object),
        recoveryDocumentPending: true,
      },
    });

    current.receiveDocument({
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      markdown: "external NEXT from another panel",
      version: 4,
      profile: "github",
      documentId: "file:///workspace/doc.md",
      reason: "external",
    });
    expect(state.value).toMatchObject({
      pendingRecovery: {
        recoveryDraft: "old",
        recoveryDocumentPending: true,
      },
    });
  });

  it("retains a withheld draft while a queued edit is acknowledged", () => {
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
    const current = createApp(state, createCore(), messages, {
      markdown: "external",
      version: 2,
    });
    appendText(current, " FIRST");
    const first = editMessages(messages)[0]!;
    appendText(current, " SECOND");
    expect(editMessages(messages)).toHaveLength(1);

    acknowledge(current, first, 3);
    const second = editMessages(messages)[1]!;
    expect(second?.markdown).toBe("external FIRST SECOND");
    expect(state.value).toMatchObject({
      pendingRecovery: {
        recoveryDraft: "old",
        recoveryDocument: expect.any(Object),
        recoveryDocumentPending: true,
      },
    });

    acknowledge(current, second, 4);
    expect(state.value).toMatchObject({
      pendingRecovery: {
        recoveryDraft: "old",
        recoveryDocumentPending: true,
      },
    });
  });

  it("keeps the pending draft when recovery storage rejects a write", () => {
    const pending = {
      documentId: "file:///workspace/doc.md",
      recoveryDraft: "old pending draft",
      recoveryBaseMarkdown: "old",
      recoveryBaseVersion: 1,
      recoveryProfile: "github" as const,
      recoveryDocument: parseMarkdown(
        "old pending draft",
        "github",
      ).doc.toJSON(),
      recoveryDocumentPending: true,
    };
    const state = {
      value: {
        documentId: "file:///workspace/doc.md",
        pendingRecovery: pending,
      },
    } as { value: unknown };
    const messages: unknown[] = [];
    const app = createApp(state, createCore(), messages, {
      setState: () => {
        throw new Error("storage quota exceeded");
      },
    });

    appendText(app, " NEXT");

    expect(state.value).toEqual({
      documentId: "file:///workspace/doc.md",
      pendingRecovery: pending,
    });
    expect(editMessages(messages)).toHaveLength(1);
    expect(
      messages.some(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          (message as { type?: unknown }).type === "notify",
      ),
    ).toBe(true);
  });

  it("does not discard a pending draft on cancel and consumes it only after explicit discard", () => {
    const state = {
      value: {
        documentId: "file:///workspace/doc.md",
        pendingRecovery: {
          documentId: "file:///workspace/doc.md",
          recoveryDraft: "old pending draft",
          recoveryBaseMarkdown: "old",
          recoveryBaseVersion: 1,
          recoveryProfile: "github" as const,
          recoveryDocument: parseMarkdown(
            "old pending draft",
            "github",
          ).doc.toJSON(),
          recoveryDocumentPending: true,
        },
      } as unknown,
    };
    const app = createApp(state, createCore(), [], {
      markdown: "external",
      version: 2,
    });
    const button = app.root.querySelector<HTMLButtonElement>(
      "[data-testid='pending-recovery-button']",
    );
    expect(button).not.toBeNull();
    button!.click();
    const dialog = app.root.querySelector<HTMLDialogElement>(
      ".mm-pending-recovery-dialog",
    );
    expect(dialog).not.toBeNull();
    expect(
      dialog?.querySelector<HTMLTextAreaElement>(".mm-pending-recovery-text")
        ?.value,
    ).toBe("old pending draft");
    dialog
      ?.querySelector<HTMLButtonElement>(
        "[data-testid='pending-recovery-keep']",
      )
      ?.click();
    expect(state.value).toMatchObject({
      pendingRecovery: { recoveryDraft: "old pending draft" },
    });

    button!.click();
    app.root
      .querySelector<HTMLButtonElement>(
        "[data-testid='pending-recovery-discard']",
      )
      ?.click();
    expect(state.value).toEqual({ documentId: "file:///workspace/doc.md" });
    expect(
      app.root.querySelector("[data-testid='pending-recovery-button']"),
    ).toBeNull();
    app.destroy();
    apps.splice(apps.indexOf(app), 1);
  });

  it("opens a pending draft separately and clears it only after host confirmation", () => {
    const state = {
      value: {
        documentId: "file:///workspace/doc.md",
        pendingRecovery: {
          documentId: "file:///workspace/doc.md",
          recoveryDraft: "old pending draft",
          recoveryBaseMarkdown: "old",
          recoveryBaseVersion: 1,
          recoveryProfile: "github" as const,
          recoveryDocument: parseMarkdown(
            "old pending draft",
            "github",
          ).doc.toJSON(),
          recoveryDocumentPending: true,
        },
      } as unknown,
    };
    const messages: unknown[] = [];
    const app = createApp(state, createCore(), messages, {
      markdown: "external",
      version: 2,
    });
    app.root
      .querySelector<HTMLButtonElement>(
        "[data-testid='pending-recovery-button']",
      )
      ?.click();
    app.root
      .querySelector<HTMLButtonElement>("[data-testid='pending-recovery-open']")
      ?.click();
    const recover = messages.find(
      (message): message is Record<string, unknown> =>
        typeof message === "object" &&
        message !== null &&
        (message as { type?: unknown }).type === "recoverDraft",
    );
    expect(recover).toMatchObject({
      markdown: "old pending draft",
      baseVersion: 2,
    });
    expect(state.value).toMatchObject({
      pendingRecovery: { recoveryDraft: "old pending draft" },
    });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          protocolVersion: PROTOCOL_VERSION,
          type: "recovery-opened",
          operationId: recover?.operationId,
          currentMarkdown: "external",
          currentVersion: 2,
          profile: "github",
        },
      }),
    );
    expect(state.value).toEqual({ documentId: "file:///workspace/doc.md" });
    app.destroy();
    apps.splice(apps.indexOf(app), 1);
  });

  it("does not replace malformed recovery storage while current input continues", () => {
    const malformed = { pendingRecovery: "not-a-recovery-object" };
    const state = { value: malformed as unknown };
    const messages: unknown[] = [];
    const app = createApp(state, createCore(), messages);

    appendText(app, " NEXT");

    expect(state.value).toMatchObject({
      recoveryDraft: "old NEXT",
      pendingRecovery: "not-a-recovery-object",
    });
    expect(editMessages(messages)).toHaveLength(1);
    app.destroy();
    apps.splice(apps.indexOf(app), 1);
  });

  it("keeps a pending marker without PM JSON until it is explicitly resolved", () => {
    const state = {
      value: {
        documentId: "file:///workspace/doc.md",
        recoveryDraft: "old",
        recoveryBaseMarkdown: "old",
        recoveryBaseVersion: 1,
        recoveryVersion: 1,
        recoveryProfile: "github" as const,
        recoveryDocumentPending: true,
      } as unknown,
    };
    const app = createApp(state, createCore(), [], {
      markdown: "old",
      version: 1,
    });
    expect(app.view.state.doc.textContent).toBe("old");
    appendText(app, " NEXT");
    expect(state.value).toMatchObject({
      recoveryDraft: "old NEXT",
      pendingRecovery: {
        recoveryDraft: "old",
        recoveryDocumentPending: true,
      },
    });
    app.destroy();
    apps.splice(apps.indexOf(app), 1);
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
      appendText(restored, " NEXT");
      expect(state.value).toMatchObject({
        pendingRecovery: {
          recoveryDraft,
          recoveryDocument: invalidRecoveryDocument,
          recoveryDocumentPending: true,
        },
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

      appendText(restored, " NEXT");
      expect(state.value).toMatchObject({
        pendingRecovery: {
          recoveryDraft,
          recoveryDocument: legacyDocument,
        },
      });

      restored.receiveDocument({
        protocolVersion: PROTOCOL_VERSION,
        type: "document",
        markdown: "host source",
        version: 2,
        profile: "github",
        documentId: "file:///workspace/doc.md",
        reason: "external",
      });
      expect(state.value).toMatchObject({
        pendingRecovery: {
          recoveryDraft,
          recoveryDocument: legacyDocument,
        },
      });
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
      appendText(unchanged, " NEXT");
      expect(editMessages(messages)).toHaveLength(1);
      expect(state.value).toMatchObject({
        pendingRecovery: {
          recoveryDocument: expect.any(Object),
          recoveryDocumentPending: true,
        },
      });
    },
  );
});
