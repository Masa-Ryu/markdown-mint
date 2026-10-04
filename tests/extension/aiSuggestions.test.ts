import { describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import {
  AiSuggestionsHost,
  type AiPanelSession,
  type AiSuggestionsEnvironment,
} from "../../src/extension/aiSuggestions";
import { offsetToLspPosition } from "../../src/extension/copilotLanguageServer";
import type {
  CopilotLanguageServer,
  CopilotServerStatus,
} from "../../src/extension/copilotLanguageServer";
import { normalizeCompletionToInsertion } from "../../src/core/inlineCompletion";
import type {
  AiAvailability,
  AiHostMessage,
  AiSuggestionFeedback,
  AiSuggestionRequest,
} from "../../src/shared/aiSuggestions";

vi.mock("vscode", () => ({
  window: { showInformationMessage: vi.fn(async () => undefined) },
  env: { clipboard: { writeText: vi.fn() }, openExternal: vi.fn() },
  Uri: {
    parse: (value: string) => ({
      scheme: "https",
      authority: "github.com",
      toString: () => value,
    }),
  },
  workspace: { isTrusted: true },
  CancellationTokenSource: class {
    private cancelled = false;
    token = {
      get isCancellationRequested() {
        return false;
      },
      onCancellationRequested: () => ({ dispose: vi.fn() }),
    };
    cancel = () => {
      this.cancelled = true;
    };
    dispose = vi.fn();
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(autoTrigger = false) {
  let automatic = autoTrigger;
  let version = 1;
  let text = "Hello";
  let documentUri = "file:///prose.md";
  let canStart = true;
  let active = true;
  let ready = true;
  const tokenStates: Array<{ cancelled: boolean }> = [];
  let statusListener:
    | ((
        availability: AiAvailability,
        message: string,
        documentUri?: string,
      ) => void)
    | undefined;
  let currentStatus: CopilotServerStatus = {
    kind: "Normal",
    busy: false,
    message: "Copilot signed in",
  };
  const messages: AiHostMessage[] = [];
  const response = deferred<{ items: Array<{ insertText: string }> }>();
  const responses = [response];
  const server = {
    get currentStatus() {
      return currentStatus;
    },
    isRunning: true,
    start: vi.fn(async () => undefined),
    synchronizeDocument: vi.fn(async () => undefined),
    focusDocument: vi.fn(async () => undefined),
    requestInlineCompletion: vi.fn(
      () => responses.shift()?.promise ?? Promise.resolve({ items: [] }),
    ),
    reportShown: vi.fn(),
    reportPartiallyAccepted: vi.fn(),
    reportAccepted: vi.fn(async () => undefined),
    closeDocument: vi.fn(async () => undefined),
    signInFromUserAction: vi.fn(async () => false),
    dispose: vi.fn(),
  } as unknown as CopilotLanguageServer;
  const environment: AiSuggestionsEnvironment = {
    server,
    supported: () => true,
    trusted: () => true,
    settings: () => ({ autoTrigger: automatic }),
    notify: vi.fn(),
    tokenSource: () => {
      const tokenState = { cancelled: false };
      tokenStates.push(tokenState);
      return {
        token: {
          get isCancellationRequested() {
            return tokenState.cancelled;
          },
          onCancellationRequested: () => ({ dispose: vi.fn() }),
        },
        cancel: () => {
          tokenState.cancelled = true;
        },
        dispose: vi.fn(),
      } as unknown as vscode.CancellationTokenSource;
    },
    statusChanged: (listener) => {
      statusListener = listener;
      listener("disabled", "Copilot suggestions are off.");
      return { dispose: vi.fn() };
    },
  };
  const host = new AiSuggestionsHost(environment);
  const panel: AiPanelSession = {
    id: "s1",
    documentId: () => documentUri,
    uri: () => documentUri,
    version: () => version,
    markdown: () => text,
    isReady: () => ready,
    isActive: () => active,
    canStartRequest: () => canStart,
    focus: vi.fn(),
    post: (message) => {
      messages.push(message);
    },
  };
  host.registerSession(panel);
  host.publishState(panel.id);
  const request = (
    patch: Partial<AiSuggestionRequest> = {},
  ): AiSuggestionRequest => {
    const state = messages
      .filter((message) => message.type === "ai-suggestion-state")
      .at(-1)!;
    return {
      protocolVersion: 1,
      type: "ai-suggestion-request",
      requestId: "r-" + messages.length,
      sessionId: "s1",
      documentId: documentUri,
      baseVersion: version,
      editorRevision: 1,
      settingsGeneration: state.settingsGeneration,
      position: text.length,
      targetKind: "paragraph",
      trigger: "manual",
      ...patch,
    };
  };
  return {
    host,
    panel,
    server,
    environment,
    response,
    messages,
    request,
    ready: () =>
      messages.filter(
        (message) =>
          message.type === "ai-suggestion-result" && message.reason === "ready",
      ),
    queueResponse: () => {
      const next = deferred<{ items: Array<{ insertText: string }> }>();
      responses.push(next);
      return next;
    },
    setQueueBusy: (value: boolean) => {
      canStart = !value;
    },
    setAutoTrigger: (value: boolean) => {
      automatic = value;
    },
    setServerStatus: (
      availability: AiAvailability,
      patch: Partial<CopilotServerStatus> = {},
      statusDocumentUri = documentUri,
    ) => {
      currentStatus = { ...currentStatus, ...patch };
      statusListener?.(availability, currentStatus.message, statusDocumentUri);
    },
    changeVersion: (value: number, next = text) => {
      version = value;
      text = next;
    },
    setMarkdown: (value: string) => {
      text = value;
    },
    changeDocument: (uri: string, value: string, nextVersion = 1) => {
      documentUri = uri;
      text = value;
      version = nextVersion;
    },
    setActive: (value: boolean) => {
      active = value;
    },
    setReady: (value: boolean) => {
      ready = value;
    },
    cancelToken: () => Boolean(tokenStates.at(-1)?.cancelled),
  };
}

describe("Copilot Language Server request lifecycle", () => {
  it("keeps an in-flight completion current through a same-version queued save", async () => {
    const f = fixture();
    await f.host.triggerFromUserAction("s1");
    const pending = f.host.requestSuggestion("s1", f.request());
    await vi.waitFor(() =>
      expect(f.server.requestInlineCompletion).toHaveBeenCalledTimes(1),
    );
    f.setQueueBusy(true);
    f.response.resolve({ items: [{ insertText: " world🌿" }] });
    await pending;
    expect(f.ready()).toHaveLength(1);
    expect(f.ready()[0]).toMatchObject({ text: " world🌿", reason: "ready" });
    expect(f.server.synchronizeDocument).toHaveBeenCalledWith(
      "file:///prose.md",
      1,
      "Hello",
    );
    expect(f.cancelToken()).toBe(true);
    f.host.dispose();
  });
  it.each([
    ["needs-sign-in", { kind: "Error", busy: false }],
    ["excluded", { kind: "Inactive", busy: false }],
  ] as const)(
    "cancels a pending request after the document becomes %s",
    async (availability, status) => {
      const f = fixture();
      const request = f.request();
      const pending = f.host.requestSuggestion("s1", request);
      await vi.waitFor(() =>
        expect(f.server.requestInlineCompletion).toHaveBeenCalledTimes(1),
      );

      f.setServerStatus(availability, {
        ...status,
        message: availability,
      });
      expect(f.cancelToken()).toBe(true);
      f.response.resolve({ items: [{ insertText: " stale" }] });
      await pending;

      expect(f.ready()).toHaveLength(0);
      expect(
        f.messages.some(
          (message) =>
            message.type === "ai-suggestion-result" &&
            message.requestId === request.requestId &&
            message.reason !== "ready",
        ),
      ).toBe(true);
      f.host.dispose();
    },
  );
  it("does not revive an old response after availability recovers and allows a fresh request", async () => {
    const f = fixture();
    const oldRequest = f.request();
    const oldPending = f.host.requestSuggestion("s1", oldRequest);
    await vi.waitFor(() =>
      expect(f.server.requestInlineCompletion).toHaveBeenCalledTimes(1),
    );

    f.setServerStatus("needs-sign-in", {
      kind: "Error",
      busy: false,
      message: "Sign in required",
    });
    f.setServerStatus("ready", {
      kind: "Normal",
      busy: false,
      message: "Signed in",
    });
    f.response.resolve({ items: [{ insertText: " old" }] });
    await oldPending;
    await Promise.resolve();
    await Promise.resolve();
    expect(f.ready()).toHaveLength(0);

    const nextResponse = f.queueResponse();
    const newRequest = f.request({ requestId: "fresh-after-sign-in" });
    const newPending = f.host.requestSuggestion("s1", newRequest);
    await vi.waitFor(() =>
      expect(f.server.requestInlineCompletion).toHaveBeenCalledTimes(2),
    );
    nextResponse.resolve({ items: [{ insertText: " fresh" }] });
    await newPending;
    expect(f.ready()).toHaveLength(1);
    expect(f.ready()[0]).toMatchObject({
      requestId: "fresh-after-sign-in",
      text: " fresh",
      reason: "ready",
    });
    f.host.dispose();
  });
  it("does not cancel an allowed document when a different document is excluded", async () => {
    const f = fixture();
    const pending = f.host.requestSuggestion("s1", f.request());
    await vi.waitFor(() =>
      expect(f.server.requestInlineCompletion).toHaveBeenCalledTimes(1),
    );
    f.setServerStatus(
      "excluded",
      {
        kind: "Inactive",
        busy: false,
        message: "Another document is excluded",
      },
      "file:///other.md",
    );
    expect(f.cancelToken()).toBe(false);
    f.response.resolve({ items: [{ insertText: " allowed" }] });
    await pending;
    expect(f.ready()).toHaveLength(1);
    f.host.dispose();
  });
  it("keeps connection authentication loss global after a per-document exclusion", async () => {
    const f = fixture();
    f.setServerStatus("needs-sign-in", {
      kind: "Error",
      busy: false,
      message: "Sign in required",
    });
    f.setServerStatus(
      "excluded",
      {
        kind: "Inactive",
        busy: false,
        message: "Another document is excluded",
      },
      "file:///other.md",
    );

    await f.host.requestSuggestion("s1", f.request());

    expect(f.server.requestInlineCompletion).not.toHaveBeenCalled();
    expect(f.messages.at(-1)).toMatchObject({
      type: "ai-suggestion-result",
      reason: "needs-sign-in",
    });
    f.host.dispose();
  });
  it("cancels and settles the webview request when the actual document version changes", async () => {
    const f = fixture();
    await f.host.triggerFromUserAction("s1");
    const pending = f.host.requestSuggestion("s1", f.request());
    await vi.waitFor(() =>
      expect(f.server.requestInlineCompletion).toHaveBeenCalledTimes(1),
    );
    f.changeVersion(2, "Changed");
    f.host.cancelSession("s1");
    await pending;
    expect(
      f.messages.some(
        (message) =>
          message.type === "ai-suggestion-result" &&
          message.reason === "cancelled",
      ),
    ).toBe(true);
    expect(f.ready()).toHaveLength(0);
    expect(f.cancelToken()).toBe(true);
    f.host.dispose();
  });
  it("does not start a request when a panel is inactive", async () => {
    const f = fixture(true);
    f.setActive(false);
    await f.host.requestSuggestion("s1", f.request({ trigger: "auto" }));
    expect(f.server.requestInlineCompletion).not.toHaveBeenCalled();
    expect(f.messages.at(-1)).toMatchObject({
      type: "ai-suggestion-result",
      reason: "stale",
    });
    f.host.dispose();
  });
  it("continues to allow manual completion while automatic suggestions are off", async () => {
    const f = fixture(false);
    await f.host.triggerFromUserAction("s1");
    const pending = f.host.requestSuggestion("s1", f.request());
    await vi.waitFor(() =>
      expect(f.server.requestInlineCompletion).toHaveBeenCalledTimes(1),
    );
    f.response.resolve({ items: [{ insertText: " next" }] });
    await pending;
    expect(f.ready()).toHaveLength(1);
    f.host.dispose();
  });
  it("normalizes LSP ranges to inserted text without replacing source or trimming spaces", () => {
    const text = "Hello world";
    const cursor = 6;
    const position = (source: string, offset: number) =>
      offsetToLspPosition(source, offset);
    const toOffset = (
      source: string,
      value: { line: number; character: number },
    ) =>
      value.line === 0 && value.character <= source.length
        ? value.character
        : undefined;
    expect(
      normalizeCompletionToInsertion(
        text,
        cursor,
        {
          insertText: "Hello wonderful world",
          range: { start: position(text, 0), end: position(text, text.length) },
        },
        toOffset,
        position,
      ),
    ).toBe("wonderful ");
    expect(
      normalizeCompletionToInsertion(
        "Hello",
        5,
        { insertText: " " },
        toOffset,
        position,
      ),
    ).toBe(" ");
    expect(
      normalizeCompletionToInsertion(
        text,
        cursor,
        {
          insertText: "Goodbye world",
          range: { start: position(text, 0), end: position(text, text.length) },
        },
        toOffset,
        position,
      ),
    ).toBeUndefined();
    expect(
      normalizeCompletionToInsertion(
        text,
        cursor,
        {
          insertText: "x" + String.fromCharCode(36) + "{1}",
          insertTextFormat: 2,
        },
        toOffset,
        position,
      ),
    ).toBeUndefined();
  });

  it("keeps the Normal status received before the sign-in RPC reply", async () => {
    const f = fixture(true);
    const rpc = deferred<boolean>();
    vi.spyOn(f.server, "signInFromUserAction").mockReturnValue(rpc.promise);
    const signingIn = f.host.signInFromUserAction();
    f.setServerStatus("ready", {
      kind: "Normal",
      busy: false,
      message: "Signed in",
    });
    rpc.resolve(true);
    await signingIn;

    expect(f.messages.at(-1)).toMatchObject({
      type: "ai-suggestion-state",
      availability: "ready",
      statusText: "Signed in",
    });
    f.host.dispose();
  });

  it("retains the Normal status received after the sign-in RPC reply", async () => {
    const f = fixture(true);
    const rpc = deferred<boolean>();
    vi.spyOn(f.server, "signInFromUserAction").mockReturnValue(rpc.promise);
    f.setServerStatus("needs-sign-in", {
      kind: "Error",
      busy: false,
      message: "Sign in required",
    });
    const signingIn = f.host.signInFromUserAction();
    rpc.resolve(true);
    await signingIn;
    f.setServerStatus("ready", {
      kind: "Normal",
      busy: false,
      message: "Signed in",
    });

    expect(f.messages.at(-1)).toMatchObject({
      type: "ai-suggestion-state",
      availability: "ready",
      statusText: "Signed in",
    });
    f.host.dispose();
  });

  it("treats a Normal server status as ready while a completion is busy", async () => {
    const f = fixture(true);
    f.setServerStatus("ready", {
      kind: "Normal",
      busy: true,
      message: "Copilot is processing a request",
    });
    await f.host.triggerFromUserAction("s1");

    expect(f.messages.at(-1)).toMatchObject({
      type: "ai-suggestion-trigger",
      sessionId: "s1",
    });
    expect(
      f.messages
        .filter((message) => message.type === "ai-suggestion-state")
        .at(-1),
    ).toMatchObject({ availability: "ready" });
    f.host.dispose();
  });

  it("restores automatic requests from an existing sign-in after startup", async () => {
    const f = fixture(true);
    await vi.waitFor(() =>
      expect(
        f.messages
          .filter((message) => message.type === "ai-suggestion-state")
          .at(-1),
      ).toMatchObject({ availability: "ready" }),
    );
    const pending = f.host.requestSuggestion(
      "s1",
      f.request({ trigger: "auto" }),
    );
    await vi.waitFor(() =>
      expect(f.server.requestInlineCompletion).toHaveBeenCalledTimes(1),
    );
    f.response.resolve({ items: [{ insertText: " next" }] });
    await pending;

    expect(f.ready()).toHaveLength(1);
    expect(f.server.start).toHaveBeenCalled();
    f.host.dispose();
  });

  it("does not invalidate an in-flight manual request when auto-trigger is turned off", async () => {
    const f = fixture(true);
    const pending = f.host.requestSuggestion("s1", f.request());
    await vi.waitFor(() =>
      expect(f.server.requestInlineCompletion).toHaveBeenCalledTimes(1),
    );
    const generation = f.messages
      .filter((message) => message.type === "ai-suggestion-state")
      .at(-1)!.settingsGeneration;
    f.setAutoTrigger(false);
    f.host.refreshSettings();
    f.response.resolve({ items: [{ insertText: " next" }] });
    await pending;

    expect(f.ready()).toHaveLength(1);
    expect(
      f.messages
        .filter((message) => message.type === "ai-suggestion-state")
        .at(-1)?.settingsGeneration,
    ).toBe(generation);
    f.host.dispose();
  });

  it("returns multiple normalized SDK alternatives for Webview safety validation", async () => {
    const f = fixture();
    f.setMarkdown("hello world**");
    const request = f.request({ position: 6 });
    const pending = f.host.requestSuggestion("s1", request);
    await vi.waitFor(() =>
      expect(f.server.requestInlineCompletion).toHaveBeenCalledTimes(1),
    );
    f.response.resolve({
      items: [{ insertText: "**" }, { insertText: "nice " }],
    });
    await pending;

    expect(f.ready()[0]).toMatchObject({
      candidates: [{ text: "**" }, { text: "nice " }],
    });
    f.host.dispose();
  });

  it("does not report a stale-version candidate as shown", async () => {
    const f = fixture();
    const request = f.request();
    const pending = f.host.requestSuggestion("s1", request);
    await vi.waitFor(() =>
      expect(f.server.requestInlineCompletion).toHaveBeenCalledTimes(1),
    );
    f.response.resolve({ items: [{ insertText: " next" }] });
    await pending;
    const result = f.ready()[0];
    if (
      !result ||
      result.type !== "ai-suggestion-result" ||
      !result.candidateId
    )
      throw new Error("Expected a ready candidate result.");

    f.changeVersion(2, "Edited while the candidate was pending");
    f.host.feedback({
      protocolVersion: 1,
      type: "ai-suggestion-feedback",
      requestId: request.requestId,
      sessionId: request.sessionId,
      candidateId: result.candidateId,
      action: "shown",
    } satisfies AiSuggestionFeedback);

    expect(f.server.reportShown).not.toHaveBeenCalled();
    f.host.dispose();
  });
  it("invalidates candidate feedback records on authentication loss", async () => {
    const f = fixture();
    const request = f.request();
    const pending = f.host.requestSuggestion("s1", request);
    await vi.waitFor(() =>
      expect(f.server.requestInlineCompletion).toHaveBeenCalledTimes(1),
    );
    f.response.resolve({ items: [{ insertText: " next" }] });
    await pending;
    const result = f.ready()[0];
    if (
      !result ||
      result.type !== "ai-suggestion-result" ||
      !result.candidateId
    )
      throw new Error("Expected a ready candidate.");

    f.host.feedback({
      protocolVersion: 1,
      type: "ai-suggestion-feedback",
      requestId: request.requestId,
      sessionId: request.sessionId,
      candidateId: result.candidateId,
      action: "shown",
    });
    expect(f.server.reportShown).toHaveBeenCalledTimes(1);
    f.setServerStatus("needs-sign-in", {
      kind: "Error",
      busy: false,
      message: "Sign in required",
    });
    f.host.feedback({
      protocolVersion: 1,
      type: "ai-suggestion-feedback",
      requestId: request.requestId,
      sessionId: request.sessionId,
      candidateId: result.candidateId,
      action: "accepted",
    });

    expect(f.server.reportAccepted).not.toHaveBeenCalled();
    f.host.dispose();
  });

  it("opens and focuses the new document after the previous document was excluded", async () => {
    const f = fixture(true);
    f.changeDocument("file:///workspace/A.md", "excluded text");
    f.setServerStatus("excluded", {
      kind: "Inactive",
      busy: false,
      message: "This file is excluded",
    });
    await f.host.sessionActivated("s1");
    expect(f.server.synchronizeDocument).toHaveBeenCalledWith(
      "file:///workspace/A.md",
      1,
      "excluded text",
    );
    expect(f.server.focusDocument).toHaveBeenCalledWith(
      "file:///workspace/A.md",
    );

    f.changeDocument("file:///workspace/B.md", "allowed text", 2);
    await f.host.sessionActivated("s1");
    expect(f.server.synchronizeDocument).toHaveBeenCalledWith(
      "file:///workspace/B.md",
      2,
      "allowed text",
    );
    expect(f.server.focusDocument).toHaveBeenLastCalledWith(
      "file:///workspace/B.md",
    );

    f.setServerStatus("ready", {
      kind: "Normal",
      busy: false,
      message: "Ready for this document",
    });
    const pending = f.host.requestSuggestion(
      "s1",
      f.request({ trigger: "auto" }),
    );
    await vi.waitFor(() =>
      expect(f.server.requestInlineCompletion).toHaveBeenCalledWith(
        "file:///workspace/B.md",
        2,
        expect.anything(),
        "auto",
        expect.anything(),
      ),
    );
    f.response.resolve({ items: [{ insertText: " with a continuation" }] });
    await pending;
    expect(f.ready()).toHaveLength(1);
    expect(
      vi
        .mocked(f.server.requestInlineCompletion)
        .mock.calls.map(([uri]) => uri),
    ).toEqual(["file:///workspace/B.md"]);
    f.host.dispose();
  });

  it("clears LSP focus when leaving the last active panel for a native editor", async () => {
    const f = fixture(false);
    await f.host.sessionActivated("s1");
    f.setActive(false);
    await f.host.sessionDeactivated("s1");

    expect(f.server.focusDocument).toHaveBeenCalledWith(undefined);
    f.host.dispose();
  });

  it("keeps a shared document open until its last active Mint panel deactivates", async () => {
    const f = fixture(false);
    await f.host.sessionActivated("s1");
    const secondPanel: AiPanelSession = {
      ...f.panel,
      id: "s2",
      focus: vi.fn(),
      post: vi.fn(),
    };
    f.host.registerSession(secondPanel);
    f.host.unregisterSession("s1");

    expect(f.server.focusDocument).not.toHaveBeenCalledWith(undefined);
    expect(f.server.closeDocument).not.toHaveBeenCalled();
    await f.host.sessionDeactivated("s2");
    expect(f.server.focusDocument).toHaveBeenLastCalledWith(undefined);
    f.host.dispose();
  });
});
