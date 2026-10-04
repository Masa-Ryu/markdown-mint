import { describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import {
  AiSuggestionsHost,
  type AiPanelSession,
  type AiSuggestionsEnvironment,
} from "../../src/extension/aiSuggestions";
import { offsetToLspPosition } from "../../src/extension/copilotLanguageServer";
import type { CopilotLanguageServer } from "../../src/extension/copilotLanguageServer";
import { normalizeCompletionToInsertion } from "../../src/core/inlineCompletion";
import type {
  AiHostMessage,
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
  let version = 1;
  let text = "Hello";
  let canStart = true;
  let active = true;
  let ready = true;
  let tokenCancelled = false;
  const messages: AiHostMessage[] = [];
  const response = deferred<{ items: Array<{ insertText: string }> }>();
  const server = {
    currentStatus: {
      kind: "Normal",
      busy: false,
      message: "Copilot signed in",
    },
    isRunning: true,
    start: vi.fn(async () => undefined),
    synchronizeDocument: vi.fn(async () => undefined),
    focusDocument: vi.fn(async () => undefined),
    requestInlineCompletion: vi.fn(() => response.promise),
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
    settings: () => ({ autoTrigger }),
    notify: vi.fn(),
    tokenSource: () =>
      ({
        token: {
          get isCancellationRequested() {
            return tokenCancelled;
          },
          onCancellationRequested: () => ({ dispose: vi.fn() }),
        },
        cancel: () => {
          tokenCancelled = true;
        },
        dispose: vi.fn(),
      }) as unknown as vscode.CancellationTokenSource,
  };
  const host = new AiSuggestionsHost(environment);
  const panel: AiPanelSession = {
    id: "s1",
    documentId: () => "file:///prose.md",
    uri: () => "file:///prose.md",
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
      documentId: "file:///prose.md",
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
    setQueueBusy: (value: boolean) => {
      canStart = !value;
    },
    changeVersion: (value: number, next = text) => {
      version = value;
      text = next;
    },
    setActive: (value: boolean) => {
      active = value;
    },
    setReady: (value: boolean) => {
      ready = value;
    },
    cancelToken: () => tokenCancelled,
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
});
