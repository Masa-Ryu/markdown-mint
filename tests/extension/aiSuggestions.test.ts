import { describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import {
  AiSuggestionsHost,
  type AiPanelSession,
  type AiSuggestionsEnvironment,
} from "../../src/extension/aiSuggestions";
import {
  LanguageModelSuggestions,
  type LanguageModelApi,
  type LanguageModelAccess,
} from "../../src/extension/languageModelSuggestions";
import type {
  AiHostMessage,
  AiSuggestionRequest,
} from "../../src/shared/aiSuggestions";

vi.mock("vscode", () => ({
  LanguageModelChatMessage: {
    User: (content: string) => ({ role: 1, content }),
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function response(...chunks: string[]) {
  return {
    text: (async function* () {
      for (const chunk of chunks) yield chunk;
    })(),
  };
}

function cancellationSource(): vscode.CancellationTokenSource {
  let cancelled = false;
  return {
    token: {
      get isCancellationRequested() {
        return cancelled;
      },
      onCancellationRequested: () => ({ dispose: vi.fn() }),
    },
    cancel: () => {
      cancelled = true;
    },
    dispose: vi.fn(),
  } as unknown as vscode.CancellationTokenSource;
}

function fixture(autoTrigger = false) {
  let automatic = autoTrigger;
  let version = 1;
  let text = "The release helper";
  let uri = "file:///document.md";
  let active = true;
  let ready = true;
  let requestIsQueueBusy = false;
  let allow = true;
  const accessListeners = new Set<() => void>();
  const modelListeners = new Set<() => void>();
  const messages: AiHostMessage[] = [];
  const send = vi.fn(
    () => deferred<Awaited<ReturnType<typeof response>>>().promise,
  );
  const model = {
    id: "copilot-gpt-4o-mini",
    name: "Copilot Mini",
    vendor: "copilot",
    family: "gpt-4o-mini",
    version: "2026-10",
    maxInputTokens: 32_000,
    countTokens: vi.fn(async () => 40),
    sendRequest: send,
  } as unknown as vscode.LanguageModelChat;
  const api: LanguageModelApi = {
    selectChatModels: vi.fn(async () => [model]),
    onDidChangeChatModels: (listener) => {
      modelListeners.add(listener);
      return { dispose: () => modelListeners.delete(listener) };
    },
  };
  const access: LanguageModelAccess = {
    canSendRequest: () => allow,
    onDidChange: (listener) => {
      accessListeners.add(listener);
      return { dispose: () => accessListeners.delete(listener) };
    },
  };
  const languageModel = new LanguageModelSuggestions({ api, access });
  const environment: AiSuggestionsEnvironment = {
    languageModel,
    supported: () => true,
    trusted: () => true,
    settings: () => ({ autoTrigger: automatic }),
    notify: vi.fn(),
    tokenSource: cancellationSource,
  };
  const host = new AiSuggestionsHost(environment);
  const panel: AiPanelSession = {
    id: "s1",
    documentId: () => uri,
    uri: () => uri,
    version: () => version,
    markdown: () => text,
    isReady: () => ready,
    isActive: () => active,
    canStartRequest: () => ready && active && !requestIsQueueBusy,
    focus: vi.fn(),
    post: (message) => messages.push(message),
  };
  host.registerSession(panel);
  const startManual = async () => {
    await host.triggerFromUserAction(panel.id);
    const trigger = [...messages]
      .reverse()
      .find((message) => message.type === "ai-suggestion-trigger");
    if (!trigger || trigger.type !== "ai-suggestion-trigger")
      throw new Error("manual invocation missing");
    const state = [...messages]
      .reverse()
      .find((message) => message.type === "ai-suggestion-state");
    if (!state || state.type !== "ai-suggestion-state")
      throw new Error("AI state missing");
    const request: AiSuggestionRequest = {
      protocolVersion: 1,
      type: "ai-suggestion-request",
      requestId: `r-${messages.length}`,
      sessionId: panel.id,
      documentId: uri,
      baseVersion: version,
      editorRevision: 1,
      settingsGeneration: state.settingsGeneration,
      position: text.length,
      targetKind: "paragraph",
      trigger: "manual",
      invocationId: trigger.invocationId,
    };
    return request;
  };
  return {
    host,
    panel,
    model,
    api,
    access,
    messages,
    send,
    startManual,
    setText: (value: string, nextVersion = version) => {
      text = value;
      version = nextVersion;
    },
    setActive: (value: boolean) => {
      active = value;
    },
    setReady: (value: boolean) => {
      ready = value;
    },
    setQueueBusy: (value: boolean) => {
      requestIsQueueBusy = value;
    },
    setAccess: (value: boolean) => {
      allow = value;
      for (const listener of accessListeners) listener();
    },
    setAutomatic: (value: boolean) => {
      automatic = value;
      host.refreshSettings();
    },
    activate: (id: string) => host.sessionActivated(id),
    addPanel: (id: string, documentUri: string, isActive: () => boolean) => {
      const second: AiPanelSession = {
        id,
        documentId: () => documentUri,
        uri: () => documentUri,
        version: () => 1,
        markdown: () => "Second panel",
        isReady: () => true,
        isActive,
        canStartRequest: () => isActive(),
        focus: vi.fn(),
        post: (message) => messages.push(message),
      };
      host.registerSession(second);
      return second;
    },
    accessChanged: () => {
      for (const listener of accessListeners) listener();
    },
    dispose: () => host.dispose(),
  };
}

describe("AI suggestion lifecycle with the public Language Model API", () => {
  it("returns a ready suggestion when a same-version save is queued during model response", async () => {
    const f = fixture();
    const request = await f.startManual();
    const generation = deferred<Awaited<ReturnType<typeof response>>>();
    f.send.mockReturnValue(generation.promise);
    const pending = f.host.requestSuggestion("s1", request);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
    f.setQueueBusy(true);
    generation.resolve(response('{"insertText":" for safe publishing."}'));
    await pending;
    expect(f.messages.at(-1)).toMatchObject({
      type: "ai-suggestion-result",
      reason: "ready",
      text: " for safe publishing.",
    });
    f.dispose();
  });

  it("rejects delayed text after a TextDocument version change", async () => {
    const f = fixture();
    const request = await f.startManual();
    const generation = deferred<Awaited<ReturnType<typeof response>>>();
    f.send.mockReturnValue(generation.promise);
    const pending = f.host.requestSuggestion("s1", request);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
    f.setText("The release helper changed", 2);
    f.host.documentChanged("file:///document.md");
    f.host.cancelSession("s1");
    await pending;
    generation.resolve(response('{"insertText":" stale"}'));
    expect(
      f.messages.some(
        (message) =>
          message.type === "ai-suggestion-result" && message.reason === "ready",
      ),
    ).toBe(false);
    f.dispose();
  });

  it("does not send after authorization is revoked and never revives an old response", async () => {
    const f = fixture();
    const request = await f.startManual();
    const generation = deferred<Awaited<ReturnType<typeof response>>>();
    f.send.mockReturnValue(generation.promise);
    const pending = f.host.requestSuggestion("s1", request);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
    f.setAccess(false);
    await pending;
    generation.resolve(response('{"insertText":" stale"}'));
    expect(
      f.messages.some(
        (message) =>
          message.type === "ai-suggestion-result" && message.reason === "ready",
      ),
    ).toBe(false);
    f.dispose();
  });

  it("does not keep a request alive after panel deactivation or disposal", async () => {
    const f = fixture();
    const request = await f.startManual();
    const generation = deferred<Awaited<ReturnType<typeof response>>>();
    f.send.mockReturnValue(generation.promise);
    const pending = f.host.requestSuggestion("s1", request);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
    f.setActive(false);
    await f.host.sessionDeactivated("s1");
    await pending;
    generation.resolve(response('{"insertText":" stale"}'));
    expect(
      f.messages.some(
        (message) =>
          message.type === "ai-suggestion-result" && message.reason === "ready",
      ),
    ).toBe(false);
    f.dispose();
  });

  it("chooses a mini family by model metadata instead of list order", async () => {
    const f = fixture();
    await f.startManual();
    expect(f.api.selectChatModels).toHaveBeenCalledWith({ vendor: "copilot" });
    expect(f.messages.at(-1)).toMatchObject({
      type: "ai-suggestion-state",
      modelName: "Copilot Mini (copilot-gpt-4o-mini, 2026-10)",
    });
    f.dispose();
  });
});
