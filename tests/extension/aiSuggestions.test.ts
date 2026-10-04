import { afterEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import {
  AiSuggestionsHost,
  type AiPanelSession,
  type AiStatusSnapshot,
  type AiSuggestionsEnvironment,
  transientFailureBackoffMs,
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

afterEach(() => vi.useRealTimers());

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
  let setupCompleted = false;
  let snapshotCurrent = true;
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
  const statusReports: Array<AiStatusSnapshot | undefined> = [];
  const environment: AiSuggestionsEnvironment = {
    languageModel,
    setupCompleted: () => setupCompleted,
    markSetupCompleted: async () => {
      setupCompleted = true;
    },
    supported: () => true,
    trusted: () => true,
    settings: () => ({ autoTrigger: automatic }),
    notify: vi.fn(),
    tokenSource: cancellationSource,
  };
  const host = new AiSuggestionsHost(environment, (status) =>
    statusReports.push(status),
  );
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
    post: (message) => {
      messages.push(message);
      if (message.type === "ai-suggestion-snapshot-check")
        host.confirmSnapshotValidation("s1", {
          protocolVersion: 1,
          type: "ai-suggestion-snapshot-validation",
          requestId: message.requestId,
          sessionId: message.sessionId,
          current: snapshotCurrent,
        });
    },
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
    statusReports,
    setupCompleted: () => setupCompleted,
    setSetupCompleted: (value: boolean) => {
      setupCompleted = value;
    },
    setSnapshotCurrent: (value: boolean) => {
      snapshotCurrent = value;
    },
    send,
    startManual,
    autoRequest: (
      requestId: string,
      afterUserInput?: boolean,
    ): AiSuggestionRequest => {
      const state = [...messages]
        .reverse()
        .find((message) => message.type === "ai-suggestion-state");
      return {
        protocolVersion: 1,
        type: "ai-suggestion-request",
        requestId,
        sessionId: panel.id,
        documentId: uri,
        baseVersion: version,
        editorRevision: 1,
        settingsGeneration:
          state?.type === "ai-suggestion-state" ? state.settingsGeneration : 0,
        position: text.length,
        targetKind: "paragraph",
        trigger: "auto",
        ...(afterUserInput ? { afterUserInput: true } : {}),
      };
    },
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
    modelsChanged: () => {
      for (const listener of modelListeners) listener();
    },
    dispose: () => host.dispose(),
  };
}

describe("AI suggestion lifecycle with the public Language Model API", () => {
  it("reports status only for the active Mint panel and clears it when none remains", async () => {
    const f = fixture();
    let secondActive = false;
    const second = f.addPanel("s2", "file:///second.md", () => secondActive);
    expect(f.statusReports.at(-1)).toMatchObject({ sessionId: "s1" });

    f.setActive(false);
    await f.host.sessionDeactivated("s1");
    expect(f.statusReports.at(-1)).toBeUndefined();

    secondActive = true;
    await f.activate(second.id);
    expect(f.statusReports.at(-1)).toMatchObject({ sessionId: "s2" });

    secondActive = false;
    await f.host.sessionDeactivated(second.id);
    expect(f.statusReports.at(-1)).toBeUndefined();

    f.setActive(true);
    await f.activate("s1");
    expect(f.statusReports.at(-1)).toMatchObject({ sessionId: "s1" });
    f.dispose();
    expect(f.statusReports.at(-1)).toBeUndefined();
  });

  it("reconciles consent completion to the new panel without triggering the old target", async () => {
    const f = fixture(true);
    const selection = deferred<readonly vscode.LanguageModelChat[]>();
    vi.mocked(f.api.selectChatModels).mockReturnValue(selection.promise);
    const oldTargetCommand = f.host.triggerFromUserAction("s1");
    let secondActive = false;
    const second = f.addPanel("s2", "file:///second.md", () => secondActive);
    f.setActive(false);
    secondActive = true;
    await f.host.sessionDeactivated("s1");
    await f.activate(second.id);

    selection.resolve([f.model]);
    await oldTargetCommand;

    const secondStates = f.messages.filter(
      (message) =>
        message.type === "ai-suggestion-state" && message.sessionId === "s2",
    );
    expect(secondStates.at(-1)).toMatchObject({
      availability: "ready",
      active: true,
    });
    expect(
      f.messages.some((message) => message.type === "ai-suggestion-trigger"),
    ).toBe(false);
    expect(f.statusReports.at(-1)).toMatchObject({
      sessionId: "s2",
      availability: "ready",
    });
    f.dispose();
  });

  it("backs off transient failures with a bounded delay and resumes after the pause", async () => {
    vi.useFakeTimers();
    expect([1, 2, 3, 6, 20].map(transientFailureBackoffMs)).toEqual([
      1_000, 2_000, 4_000, 30_000, 30_000,
    ]);
    const f = fixture(true);
    const manual = await f.startManual();
    const { invocationId: _invocationId, ...identity } = manual;
    void _invocationId;
    const request = (requestId: string): AiSuggestionRequest => ({
      ...identity,
      requestId,
      trigger: "auto",
    });

    f.send.mockRejectedValueOnce(new Error("temporary network failure"));
    await f.host.requestSuggestion("s1", request("auto-1"));
    expect(
      f.messages
        .filter((message) => message.type === "ai-suggestion-result")
        .at(-1),
    ).toMatchObject({
      type: "ai-suggestion-result",
      reason: "failed",
    });
    expect(
      f.messages.filter(
        (message) =>
          message.type === "ai-suggestion-state" &&
          message.availability === "temporarily-unavailable",
      ),
    ).not.toHaveLength(0);

    await f.host.requestSuggestion("s1", request("auto-2"));
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(
      f.messages
        .filter((message) => message.type === "ai-suggestion-result")
        .at(-1),
    ).toMatchObject({
      type: "ai-suggestion-result",
      reason: "backoff",
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.messages.at(-1)).toMatchObject({
      type: "ai-suggestion-state",
      availability: "ready",
    });
    f.send.mockResolvedValueOnce(
      response('{"insertText":" for safer publishing."}') as never,
    );
    await f.host.requestSuggestion("s1", request("auto-3"));
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.messages.at(-1)).toMatchObject({
      type: "ai-suggestion-result",
      reason: "ready",
    });
    f.dispose();
  });

  it("keeps quota blocks separate and does not retry a blocked model automatically", async () => {
    const f = fixture(true);
    const manual = await f.startManual();
    const { invocationId: _invocationId, ...identity } = manual;
    void _invocationId;
    const request = (requestId: string): AiSuggestionRequest => ({
      ...identity,
      requestId,
      trigger: "auto",
    });
    f.send.mockRejectedValueOnce({ code: "Blocked" });
    await f.host.requestSuggestion("s1", request("auto-blocked"));
    expect(
      f.messages
        .filter((message) => message.type === "ai-suggestion-result")
        .at(-1),
    ).toMatchObject({ reason: "blocked" });
    const callsAfterBlock = f.send.mock.calls.length;
    await f.host.requestSuggestion("s1", request("auto-still-blocked"));
    expect(f.send).toHaveBeenCalledTimes(callsAfterBlock);
    expect(f.messages.at(-1)).toMatchObject({
      type: "ai-suggestion-result",
      reason: "blocked",
    });
    expect(f.messages.at(-2)).toMatchObject({
      type: "ai-suggestion-state",
      availability: "blocked",
    });
    const modelSelection = vi.mocked(f.api.selectChatModels);
    const modelSelectionCalls = modelSelection.mock.calls.length;
    await f.host.triggerFromUserAction("s1");
    expect(modelSelection).toHaveBeenCalledTimes(modelSelectionCalls);
    f.dispose();
  });

  it("reacquires a saved model only after a debounced real-input request after restart", async () => {
    const f = fixture(true);
    f.setSetupCompleted(true);
    expect(f.api.selectChatModels).not.toHaveBeenCalled();
    f.send.mockResolvedValueOnce(
      response('{"insertText":" for safer publishing."}') as never,
    );

    await f.host.requestSuggestion("s1", f.autoRequest("restart-input", true));

    expect(f.api.selectChatModels).toHaveBeenCalledExactlyOnceWith({
      vendor: "copilot",
    });
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.messages.at(-1)).toMatchObject({
      type: "ai-suggestion-result",
      reason: "ready",
      text: " for safer publishing.",
    });
    f.dispose();
  });

  it("does not send the saved request snapshot when the cursor changed during model selection", async () => {
    const f = fixture(true);
    f.setSetupCompleted(true);
    f.setSnapshotCurrent(false);

    await f.host.requestSuggestion(
      "s1",
      f.autoRequest("restart-stale-cursor", true),
    );

    expect(
      f.messages.some(
        (message) => message.type === "ai-suggestion-snapshot-check",
      ),
    ).toBe(true);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.messages.at(-1)).toMatchObject({
      type: "ai-suggestion-result",
      reason: "stale",
    });
    f.dispose();
  });

  it.each([
    { setup: false, afterUserInput: true, label: "without completed setup" },
    { setup: true, afterUserInput: false, label: "without real-input origin" },
  ])(
    "does not restore consent after restart $label",
    async ({ setup, afterUserInput }) => {
      const f = fixture(true);
      f.setSetupCompleted(setup);

      await f.host.requestSuggestion(
        "s1",
        f.autoRequest("restart-gated", afterUserInput),
      );

      expect(f.api.selectChatModels).not.toHaveBeenCalled();
      expect(f.send).not.toHaveBeenCalled();
      expect(f.messages.at(-1)).toMatchObject({
        type: "ai-suggestion-result",
        reason: "needs-authorization",
      });
      f.dispose();
    },
  );

  it("rechecks public access after model reacquisition and does not send when access is denied", async () => {
    const f = fixture(true);
    f.setSetupCompleted(true);
    f.setAccess(false);

    await f.host.requestSuggestion("s1", f.autoRequest("restart-denied", true));

    expect(f.api.selectChatModels).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();
    expect(
      f.messages
        .filter((message) => message.type === "ai-suggestion-result")
        .at(-1),
    ).toMatchObject({
      type: "ai-suggestion-result",
      reason: "needs-authorization",
    });
    expect(
      f.messages
        .filter((message) => message.type === "ai-suggestion-state")
        .at(-1),
    ).toMatchObject({ autoRestoreOnInput: false });
    f.dispose();
  });

  it("blocks automatic restoration if access is lost before the snapshot is sent", async () => {
    const f = fixture(true);
    f.setSetupCompleted(true);
    vi.spyOn(f.access, "canSendRequest")
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    await f.host.requestSuggestion(
      "s1",
      f.autoRequest("restart-access-race", true),
    );
    f.setAccess(false);
    await f.host.requestSuggestion(
      "s1",
      f.autoRequest("restart-access-still-denied", true),
    );

    expect(f.api.selectChatModels).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();
    expect(
      f.messages
        .filter((message) => message.type === "ai-suggestion-state")
        .at(-1),
    ).toMatchObject({
      availability: "needs-authorization",
      autoRestoreOnInput: false,
    });
    expect(
      f.messages
        .filter((message) => message.type === "ai-suggestion-result")
        .at(-1),
    ).toMatchObject({ reason: "needs-authorization" });
    f.dispose();
  });

  it("does not repeat model selection after a delayed access-change event follows denial", async () => {
    const f = fixture(true);
    f.setSetupCompleted(true);
    f.setAccess(false);
    await f.host.requestSuggestion("s1", f.autoRequest("denied-first", true));
    expect(f.api.selectChatModels).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();

    f.accessChanged();
    await f.host.requestSuggestion("s1", f.autoRequest("denied-again", true));

    expect(f.api.selectChatModels).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();
    expect(
      f.messages
        .filter((message) => message.type === "ai-suggestion-result")
        .at(-1),
    ).toMatchObject({ reason: "needs-authorization" });
    f.dispose();
  });

  it("resumes from the latest input after public access is restored", async () => {
    const f = fixture(true);
    f.setSetupCompleted(true);
    f.setAccess(false);

    await f.host.requestSuggestion("s1", f.autoRequest("access-denied", true));
    expect(f.api.selectChatModels).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();

    f.setAccess(true);
    f.setText("The updated release plan", 2);
    f.send.mockResolvedValueOnce(
      response('{"insertText":" is ready."}') as never,
    );
    await f.host.requestSuggestion(
      "s1",
      f.autoRequest("access-restored", true),
    );

    expect(f.api.selectChatModels).toHaveBeenCalledTimes(1);
    expect(f.send).toHaveBeenCalledTimes(1);
    const sendCalls = f.send.mock.calls as unknown as Array<[unknown]>;
    const requestMessages = sendCalls[0]?.[0] as
      Array<{ content?: string }> | undefined;
    expect(requestMessages?.[0]?.content).toContain(
      'PREFIX: "The updated release plan"',
    );
    expect(f.messages.at(-1)).toMatchObject({
      type: "ai-suggestion-result",
      reason: "ready",
    });
    f.dispose();
  });

  it("allows a model-list event to recover auto restoration after no model was listed", async () => {
    const f = fixture(true);
    f.setSetupCompleted(true);
    const selectModels = vi.mocked(f.api.selectChatModels);
    selectModels.mockResolvedValueOnce([]);
    await f.host.requestSuggestion("s1", f.autoRequest("model-missing", true));
    expect(selectModels).toHaveBeenCalledTimes(1);
    expect(
      f.messages
        .filter((message) => message.type === "ai-suggestion-result")
        .at(-1),
    ).toMatchObject({ reason: "no-model" });

    f.modelsChanged();
    f.send.mockResolvedValueOnce(
      response('{"insertText":" after model registration."}') as never,
    );
    await f.host.requestSuggestion("s1", f.autoRequest("model-arrived", true));

    expect(selectModels).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.messages.at(-1)).toMatchObject({
      type: "ai-suggestion-result",
      reason: "ready",
    });
    f.dispose();
  });

  it("keeps an explicit first-use request alive when access changes during consent selection", async () => {
    const f = fixture(false);
    const selection = deferred<readonly vscode.LanguageModelChat[]>();
    vi.mocked(f.api.selectChatModels).mockReturnValue(selection.promise);
    const command = f.host.triggerFromUserAction("s1");
    await vi.waitFor(() => expect(f.api.selectChatModels).toHaveBeenCalled());

    f.accessChanged();
    selection.resolve([f.model]);
    await command;
    expect(f.setupCompleted()).toBe(true);
    expect(
      f.messages.some((message) => message.type === "ai-suggestion-trigger"),
    ).toBe(true);

    const trigger = [...f.messages]
      .reverse()
      .find((message) => message.type === "ai-suggestion-trigger");
    const state = [...f.messages]
      .reverse()
      .find((message) => message.type === "ai-suggestion-state");
    if (
      trigger?.type !== "ai-suggestion-trigger" ||
      state?.type !== "ai-suggestion-state"
    )
      throw new Error("initial consent did not create a manual request");
    const request: AiSuggestionRequest = {
      protocolVersion: 1,
      type: "ai-suggestion-request",
      requestId: "consented-first-request",
      sessionId: "s1",
      documentId: "file:///document.md",
      baseVersion: 1,
      editorRevision: 1,
      settingsGeneration: state.settingsGeneration,
      position: "The release helper".length,
      targetKind: "paragraph",
      trigger: "manual",
      invocationId: trigger.invocationId,
    };
    f.send.mockResolvedValueOnce(
      response('{"insertText":" from the authorized request."}') as never,
    );
    await f.host.requestSuggestion("s1", request);
    expect(
      f.messages
        .filter((message) => message.type === "ai-suggestion-result")
        .at(-1),
    ).toMatchObject({ reason: "ready" });
    f.dispose();
  });

  it("cancels a restart re-acquisition when the user leaves the request snapshot", async () => {
    const f = fixture(true);
    f.setSetupCompleted(true);
    const selection = deferred<readonly vscode.LanguageModelChat[]>();
    vi.mocked(f.api.selectChatModels).mockReturnValue(selection.promise);

    const pending = f.host.requestSuggestion(
      "s1",
      f.autoRequest("restart-cancelled", true),
    );
    await vi.waitFor(() => expect(f.api.selectChatModels).toHaveBeenCalled());
    f.host.cancelSession("s1", "restart-cancelled");
    await pending;
    selection.resolve([f.model]);
    await selection.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(f.send).not.toHaveBeenCalled();
    expect(
      f.messages.some(
        (message) =>
          message.type === "ai-suggestion-result" && message.reason === "ready",
      ),
    ).toBe(false);
    f.dispose();
  });

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
