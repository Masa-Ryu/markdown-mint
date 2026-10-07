import { afterEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import {
  AiSuggestionsHost,
  type AiPanelSession,
  type AiSuggestionsEnvironment,
  type AiSuggestionsOnboardingChoice,
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

function fixture(
  autoTrigger = false,
  options: {
    onboardingCompleted?: boolean;
    setupCompleted?: boolean;
    explicitAutoTriggerPreference?: boolean;
    supported?: boolean;
    trusted?: boolean;
    active?: boolean;
    ready?: boolean;
    promptFirstRun?: () => Promise<AiSuggestionsOnboardingChoice>;
  } = {},
) {
  let automatic = autoTrigger;
  let version = 1;
  let text = "The release helper";
  let uri = "file:///document.md";
  let active = options.active ?? true;
  let ready = options.ready ?? true;
  let requestIsQueueBusy = false;
  let allow: boolean | undefined = true;
  let setupCompleted = options.setupCompleted ?? false;
  let onboardingCompleted = options.onboardingCompleted ?? true;
  let explicitAutoTriggerPreference = options.explicitAutoTriggerPreference;
  let supported = options.supported ?? true;
  let trusted = options.trusted ?? true;
  let savedModelIdentity: { id: string; version: string } | undefined;
  let snapshotCurrent = true;
  let beforeSnapshotValidation: (() => void) | undefined;
  let availableModels: readonly vscode.LanguageModelChat[] = [];
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
  if (setupCompleted)
    savedModelIdentity = { id: model.id, version: model.version };
  availableModels = [model];
  const api: LanguageModelApi = {
    selectChatModels: vi.fn(async () => availableModels),
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
  const languageModel = new LanguageModelSuggestions({
    api,
    access,
    savedModelIdentity: () => savedModelIdentity,
  });
  const promptFirstRun = vi.fn(
    options.promptFirstRun ??
      (async (): Promise<AiSuggestionsOnboardingChoice> => undefined),
  );
  const updateAutoTrigger = vi.fn(async (enabled: boolean) => {
    automatic = enabled;
    explicitAutoTriggerPreference = enabled;
  });
  const notify = vi.fn();
  const environment: AiSuggestionsEnvironment = {
    languageModel,
    setupCompleted: () => setupCompleted,
    markSetupCompleted: async () => {
      setupCompleted = true;
      savedModelIdentity = { id: model.id, version: model.version };
    },
    onboardingCompleted: () => onboardingCompleted,
    markOnboardingCompleted: async () => {
      onboardingCompleted = true;
    },
    explicitAutoTriggerPreference: () => explicitAutoTriggerPreference,
    promptFirstRun,
    supported: () => supported,
    trusted: () => trusted,
    settings: () => ({ autoTrigger: automatic }),
    updateAutoTrigger,
    notify,
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
    post: (message) => {
      messages.push(message);
      if (message.type === "ai-suggestion-snapshot-check") {
        beforeSnapshotValidation?.();
        host.confirmSnapshotValidation("s1", {
          protocolVersion: 1,
          type: "ai-suggestion-snapshot-validation",
          requestId: message.requestId,
          sessionId: message.sessionId,
          current: snapshotCurrent,
        });
      }
    },
  };
  host.registerSession(panel);
  const startManual = async (existingSetup = true) => {
    if (existingSetup) {
      setupCompleted = true;
      savedModelIdentity = { id: model.id, version: model.version };
    }
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
    autoTrigger: () => automatic,
    setupCompleted: () => setupCompleted,
    onboardingCompleted: () => onboardingCompleted,
    savedModelIdentity: () => savedModelIdentity,
    promptFirstRun,
    updateAutoTrigger,
    notify,
    setSetupCompleted: (value: boolean) => {
      setupCompleted = value;
      savedModelIdentity = value
        ? { id: model.id, version: model.version }
        : undefined;
    },
    setAccess: (value: boolean | undefined, notifyListeners = true) => {
      allow = value;
      if (notifyListeners) for (const listener of accessListeners) listener();
    },
    setSnapshotCurrent: (value: boolean) => {
      snapshotCurrent = value;
    },
    setBeforeSnapshotValidation: (callback: (() => void) | undefined) => {
      beforeSnapshotValidation = callback;
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
    setSupported: (value: boolean) => {
      supported = value;
    },
    setTrusted: (value: boolean) => {
      trusted = value;
    },
    setReady: (value: boolean) => {
      ready = value;
    },
    setQueueBusy: (value: boolean) => {
      requestIsQueueBusy = value;
    },
    setAutomatic: (value: boolean) => {
      automatic = value;
      explicitAutoTriggerPreference = value;
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
    modelsChanged: (models?: readonly vscode.LanguageModelChat[]) => {
      if (models) availableModels = models;
      for (const listener of modelListeners) listener();
    },
    dispose: () => host.dispose(),
  };
}

describe("AI suggestion lifecycle with the public Language Model API", () => {
  it("publishes state to each panel without creating a separate status channel", async () => {
    const f = fixture();
    let secondActive = false;
    const second = f.addPanel("s2", "file:///second.md", () => secondActive);
    const latestState = (sessionId: string) =>
      f.messages
        .filter(
          (message) =>
            message.type === "ai-suggestion-state" &&
            message.sessionId === sessionId,
        )
        .at(-1);
    expect(latestState("s2")).toMatchObject({
      type: "ai-suggestion-state",
      sessionId: "s2",
      autoTrigger: false,
    });

    f.setActive(false);
    await f.host.sessionDeactivated("s1");

    secondActive = true;
    await f.activate(second.id);
    expect(latestState("s2")).toMatchObject({
      type: "ai-suggestion-state",
      sessionId: "s2",
      active: true,
    });

    secondActive = false;
    await f.host.sessionDeactivated(second.id);

    f.setActive(true);
    await f.activate("s1");
    f.dispose();
  });

  it("uses the first Copilot toolbar click only for setup, even during an edit queue", async () => {
    const f = fixture(true);
    f.setQueueBusy(true);
    expect(f.api.selectChatModels).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();

    await f.host.handleToolbarAction("s1");

    expect(f.api.selectChatModels).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.setupCompleted()).toBe(true);
    expect(f.autoTrigger()).toBe(true);
    expect(
      f.messages.some((message) => message.type === "ai-suggestion-trigger"),
    ).toBe(false);
    expect(
      f.messages.some((message) => message.type === "ai-suggestion-result"),
    ).toBe(false);
  });

  it("keeps fresh-install setup lazy until the first Copilot toolbar click", async () => {
    const f = fixture(true);
    expect(f.setupCompleted()).toBe(false);
    expect(f.savedModelIdentity()).toBeUndefined();
    expect(f.api.selectChatModels).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.messages.at(-1)).toMatchObject({
      type: "ai-suggestion-state",
      autoTrigger: true,
      availability: "needs-authorization",
    });

    await f.host.requestSuggestion(
      "s1",
      f.autoRequest("fresh-install-typing", true),
    );

    expect(f.api.selectChatModels).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.setupCompleted()).toBe(false);

    await f.host.handleToolbarAction("s1");

    expect(f.api.selectChatModels).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.setupCompleted()).toBe(true);
    expect(f.savedModelIdentity()).toEqual({
      id: f.model.id,
      version: f.model.version,
    });
    expect(f.autoTrigger()).toBe(true);
    expect(f.messages.at(-1)).toMatchObject({
      type: "ai-suggestion-state",
      autoTrigger: true,
      availability: "ready",
    });
    f.dispose();
  });

  it("guides users when no Copilot model is available during setup", async () => {
    const f = fixture(true);
    vi.mocked(f.api.selectChatModels).mockResolvedValueOnce([]);

    await f.host.handleToolbarAction("s1");

    expect(f.notify).toHaveBeenCalledWith(
      "No Copilot language model is available. Sign in to GitHub and make sure GitHub Copilot is enabled in VS Code, then try again.",
    );
    expect(f.messages.at(-1)).toMatchObject({
      type: "ai-suggestion-state",
      availability: "no-model",
      autoTrigger: true,
      statusText:
        "No Copilot language model is available. Sign in to GitHub and make sure GitHub Copilot is enabled in VS Code, then try again.",
    });
    expect(f.setupCompleted()).toBe(false);
    expect(f.savedModelIdentity()).toBeUndefined();
    expect(f.api.selectChatModels).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();
    f.dispose();
  });

  it("shows first-run onboarding once and routes Enable through toolbar setup", async () => {
    const choice = deferred<AiSuggestionsOnboardingChoice>();
    const f = fixture(true, {
      onboardingCompleted: false,
      promptFirstRun: () => choice.promise,
    });

    expect(f.promptFirstRun).toHaveBeenCalledTimes(1);
    expect(f.onboardingCompleted()).toBe(false);
    expect(f.setupCompleted()).toBe(false);
    expect(f.api.selectChatModels).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();

    choice.resolve("enable");
    await f.activate("s1");

    expect(f.onboardingCompleted()).toBe(true);
    expect(f.setupCompleted()).toBe(true);
    expect(f.autoTrigger()).toBe(true);
    expect(f.api.selectChatModels).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.messages.at(-1)).toMatchObject({
      type: "ai-suggestion-state",
      autoTrigger: true,
      availability: "ready",
    });
    await f.activate("s1");
    expect(f.promptFirstRun).toHaveBeenCalledTimes(1);
    f.dispose();
  });

  it.each([
    { choice: "enable" as const, label: "Enable" },
    { choice: "not-now" as const, label: "Not Now" },
    { choice: undefined, label: "dismiss" },
  ])(
    "preserves toolbar setup while the first-run prompt is pending ($label)",
    async ({ choice }) => {
      const prompt = deferred<AiSuggestionsOnboardingChoice>();
      const f = fixture(true, {
        onboardingCompleted: false,
        promptFirstRun: () => prompt.promise,
      });
      const activation = f.activate("s1");

      expect(f.promptFirstRun).toHaveBeenCalledTimes(1);
      await f.host.handleToolbarAction("s1");
      expect(f.setupCompleted()).toBe(true);
      expect(f.autoTrigger()).toBe(true);
      expect(f.api.selectChatModels).toHaveBeenCalledTimes(1);

      prompt.resolve(choice);
      await activation;

      expect(f.onboardingCompleted()).toBe(true);
      expect(f.setupCompleted()).toBe(true);
      expect(f.autoTrigger()).toBe(true);
      expect(f.api.selectChatModels).toHaveBeenCalledTimes(1);
      expect(f.updateAutoTrigger).toHaveBeenCalledExactlyOnceWith(true);
      expect(f.send).not.toHaveBeenCalled();
      f.dispose();
    },
  );

  it("leaves Enable pending when its Mint session closes and prompts again on activation", async () => {
    const firstPrompt = deferred<AiSuggestionsOnboardingChoice>();
    const promptFirstRun = vi
      .fn(async (): Promise<AiSuggestionsOnboardingChoice> => undefined)
      .mockReturnValueOnce(firstPrompt.promise)
      .mockResolvedValueOnce(undefined);
    const f = fixture(true, {
      onboardingCompleted: false,
      promptFirstRun,
    });
    const activation = f.activate("s1");

    f.setActive(false);
    await f.host.sessionDeactivated("s1");
    firstPrompt.resolve("enable");
    await activation;

    expect(f.setupCompleted()).toBe(false);
    expect(f.onboardingCompleted()).toBe(false);
    expect(f.api.selectChatModels).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();

    const second = f.addPanel("s2", "file:///second.md", () => true);
    await f.activate(second.id);

    expect(promptFirstRun).toHaveBeenCalledTimes(2);
    expect(f.setupCompleted()).toBe(false);
    expect(f.onboardingCompleted()).toBe(true);
    expect(f.autoTrigger()).toBe(false);
    expect(f.api.selectChatModels).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    f.dispose();
  });

  it("keeps a later toolbar OFF choice when the pending onboarding prompt resolves", async () => {
    const prompt = deferred<AiSuggestionsOnboardingChoice>();
    const f = fixture(true, {
      onboardingCompleted: false,
      promptFirstRun: () => prompt.promise,
    });
    const activation = f.activate("s1");

    await f.host.handleToolbarAction("s1");
    await f.host.handleToolbarAction("s1");
    expect(f.setupCompleted()).toBe(true);
    expect(f.autoTrigger()).toBe(false);
    expect(f.updateAutoTrigger.mock.calls).toEqual([[true], [false]]);

    prompt.resolve("enable");
    await activation;

    expect(f.onboardingCompleted()).toBe(true);
    expect(f.autoTrigger()).toBe(false);
    expect(f.api.selectChatModels).toHaveBeenCalledTimes(1);
    expect(f.updateAutoTrigger.mock.calls).toEqual([[true], [false]]);
    f.dispose();
  });

  it.each([
    { choice: "enable" as const, preference: false },
    { choice: "not-now" as const, preference: true },
  ])(
    "preserves an explicit autoTrigger setting changed while onboarding is pending",
    async ({ choice, preference }) => {
      const prompt = deferred<AiSuggestionsOnboardingChoice>();
      const f = fixture(true, {
        onboardingCompleted: false,
        promptFirstRun: () => prompt.promise,
      });
      const activation = f.activate("s1");

      f.setAutomatic(preference);
      prompt.resolve(choice);
      await activation;

      expect(f.onboardingCompleted()).toBe(true);
      expect(f.autoTrigger()).toBe(preference);
      expect(f.updateAutoTrigger).not.toHaveBeenCalled();
      expect(f.api.selectChatModels).not.toHaveBeenCalled();
      expect(f.send).not.toHaveBeenCalled();
      f.dispose();
    },
  );

  it.each([
    {
      choice: "not-now" as const,
      expectedAutoTrigger: false,
      label: "Not Now",
    },
    { choice: undefined, expectedAutoTrigger: false, label: "dismiss" },
    { choice: "enable" as const, expectedAutoTrigger: true, label: "Enable" },
  ])(
    "applies $label after manual first-use consent without reselecting",
    async ({ choice, expectedAutoTrigger }) => {
      const prompt = deferred<AiSuggestionsOnboardingChoice>();
      const f = fixture(true, {
        onboardingCompleted: false,
        promptFirstRun: () => prompt.promise,
      });
      const activation = f.activate("s1");
      f.setAccess(undefined, false);

      const request = await f.startManual(false);
      expect(f.setupCompleted()).toBe(false);
      expect(f.api.selectChatModels).toHaveBeenCalledTimes(1);
      f.send.mockImplementationOnce(async () => {
        f.setAccess(true);
        return response('{"insertText":" next"}');
      });
      await f.host.requestSuggestion("s1", request);

      expect(f.setupCompleted()).toBe(true);
      expect(f.autoTrigger()).toBe(true);
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(f.updateAutoTrigger).not.toHaveBeenCalled();

      prompt.resolve(choice);
      await activation;

      expect(f.onboardingCompleted()).toBe(true);
      expect(f.setupCompleted()).toBe(true);
      expect(f.autoTrigger()).toBe(expectedAutoTrigger);
      expect(f.api.selectChatModels).toHaveBeenCalledTimes(1);
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(f.updateAutoTrigger).toHaveBeenCalledExactlyOnceWith(
        expectedAutoTrigger,
      );
      f.dispose();
    },
  );

  it.each([
    { choice: "not-now" as const, label: "Not Now" },
    { choice: undefined, label: "closing the notification" },
  ])("treats $label as a one-time opt-out", async ({ choice }) => {
    const f = fixture(true, {
      onboardingCompleted: false,
      promptFirstRun: async () => choice,
    });

    await f.activate("s1");

    expect(f.promptFirstRun).toHaveBeenCalledTimes(1);
    expect(f.onboardingCompleted()).toBe(true);
    expect(f.autoTrigger()).toBe(false);
    expect(f.updateAutoTrigger).toHaveBeenCalledExactlyOnceWith(false);
    expect(f.setupCompleted()).toBe(false);
    expect(f.api.selectChatModels).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();

    await f.activate("s1");
    expect(f.promptFirstRun).toHaveBeenCalledTimes(1);

    await f.host.handleToolbarAction("s1");
    expect(f.setupCompleted()).toBe(true);
    expect(f.autoTrigger()).toBe(true);
    expect(f.api.selectChatModels).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();
    f.dispose();
  });

  it("does not prompt users with completed setup or an explicit global OFF", async () => {
    const setup = fixture(true, {
      onboardingCompleted: false,
      setupCompleted: true,
    });
    await setup.activate("s1");
    expect(setup.promptFirstRun).not.toHaveBeenCalled();
    expect(setup.onboardingCompleted()).toBe(true);
    expect(setup.api.selectChatModels).not.toHaveBeenCalled();
    setup.dispose();

    const optedOut = fixture(false, {
      onboardingCompleted: false,
      explicitAutoTriggerPreference: false,
      promptFirstRun: async () => "enable",
    });
    await optedOut.activate("s1");
    expect(optedOut.promptFirstRun).not.toHaveBeenCalled();
    expect(optedOut.onboardingCompleted()).toBe(true);
    expect(optedOut.autoTrigger()).toBe(false);
    expect(optedOut.updateAutoTrigger).not.toHaveBeenCalled();
    expect(optedOut.api.selectChatModels).not.toHaveBeenCalled();
    expect(optedOut.send).not.toHaveBeenCalled();
    optedOut.dispose();
  });

  it("coalesces simultaneous panel activation into one onboarding prompt", async () => {
    const choice = deferred<AiSuggestionsOnboardingChoice>();
    const f = fixture(true, {
      onboardingCompleted: false,
      promptFirstRun: () => choice.promise,
    });
    f.setActive(false);
    const second = f.addPanel("s2", "file:///second.md", () => true);

    expect(f.promptFirstRun).toHaveBeenCalledTimes(1);
    choice.resolve("not-now");
    await f.activate(second.id);

    expect(f.promptFirstRun).toHaveBeenCalledTimes(1);
    expect(f.onboardingCompleted()).toBe(true);
    expect(f.autoTrigger()).toBe(false);
    expect(f.api.selectChatModels).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    f.dispose();
  });

  it("waits for a ready active trusted and supported editor before prompting", async () => {
    const f = fixture(true, {
      onboardingCompleted: false,
      active: false,
      ready: false,
      supported: false,
      trusted: false,
      promptFirstRun: async () => "not-now",
    });

    await f.activate("s1");
    f.setReady(true);
    await f.activate("s1");
    expect(f.promptFirstRun).not.toHaveBeenCalled();

    f.setActive(true);
    await f.activate("s1");
    expect(f.promptFirstRun).not.toHaveBeenCalled();

    f.setSupported(true);
    await f.activate("s1");
    expect(f.promptFirstRun).not.toHaveBeenCalled();

    f.setTrusted(true);
    f.host.trustChanged();
    await f.activate("s1");

    expect(f.promptFirstRun).toHaveBeenCalledTimes(1);
    expect(f.onboardingCompleted()).toBe(true);
    expect(f.autoTrigger()).toBe(false);
    expect(f.api.selectChatModels).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    f.dispose();
  });

  it("keeps failed onboarding setup incomplete and retries from the toolbar", async () => {
    const choice = deferred<AiSuggestionsOnboardingChoice>();
    const f = fixture(true, {
      onboardingCompleted: false,
      promptFirstRun: () => choice.promise,
    });
    f.setAccess(undefined, false);
    f.send.mockRejectedValueOnce({ code: "Blocked" });

    choice.resolve("enable");
    await f.activate("s1");

    expect(f.onboardingCompleted()).toBe(true);
    expect(f.setupCompleted()).toBe(false);
    expect(f.savedModelIdentity()).toBeUndefined();
    expect(f.autoTrigger()).toBe(true);
    expect(f.messages.at(-1)).toMatchObject({
      type: "ai-suggestion-state",
      availability: "blocked",
    });

    f.setAccess(true, false);
    await f.host.handleToolbarAction("s1");

    expect(f.promptFirstRun).toHaveBeenCalledTimes(1);
    expect(f.setupCompleted()).toBe(true);
    expect(f.savedModelIdentity()).toEqual({
      id: f.model.id,
      version: f.model.version,
    });
    expect(f.autoTrigger()).toBe(true);
    expect(f.api.selectChatModels).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.messages.at(-1)).toMatchObject({
      type: "ai-suggestion-state",
      availability: "ready",
    });
    f.dispose();
  });

  it("retries blocked first-run setup on the next explicit toolbar click", async () => {
    const f = fixture(true);
    f.setAccess(undefined);
    f.send.mockRejectedValueOnce({ code: "Blocked" });

    await f.host.handleToolbarAction("s1");

    expect(f.api.selectChatModels).toHaveBeenCalledTimes(1);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.setupCompleted()).toBe(false);
    expect(f.savedModelIdentity()).toBeUndefined();
    expect(f.messages.at(-1)).toMatchObject({
      type: "ai-suggestion-state",
      availability: "blocked",
    });

    f.setAccess(true, false);
    await f.host.handleToolbarAction("s1");

    expect(f.api.selectChatModels).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.setupCompleted()).toBe(true);
    expect(f.savedModelIdentity()).toEqual({
      id: f.model.id,
      version: f.model.version,
    });
    expect(f.autoTrigger()).toBe(true);
    expect(f.messages.at(-1)).toMatchObject({
      type: "ai-suggestion-state",
      autoTrigger: true,
      availability: "ready",
    });
    f.dispose();
  });

  it("uses one context-free consent request for first toolbar setup and discards it", async () => {
    const f = fixture(false);
    f.setAccess(undefined);
    f.send.mockImplementationOnce(async () => {
      f.setAccess(true);
      return response("ignored setup response");
    });

    await f.host.handleToolbarAction("s1");

    expect(f.send).toHaveBeenCalledTimes(1);
    const [messages, options] = f.send.mock.calls[0]! as unknown as [
      unknown,
      { justification?: string },
    ];
    expect(messages).toEqual([{ role: 1, content: "Reply with OK." }]);
    expect(options).toMatchObject({
      justification: "Enable Copilot suggestions in Markdown Mint.",
    });
    expect(f.setupCompleted()).toBe(true);
    expect(f.autoTrigger()).toBe(true);
    expect(
      f.messages.some((message) => message.type === "ai-suggestion-trigger"),
    ).toBe(false);
    expect(
      f.messages.some((message) => message.type === "ai-suggestion-result"),
    ).toBe(false);
  });

  it("does not complete setup or retry when first toolbar consent is refused", async () => {
    const f = fixture(false);
    f.setAccess(undefined);
    f.send.mockRejectedValueOnce(
      Object.assign(new Error("Consent declined"), { code: "NoPermissions" }),
    );

    await f.host.handleToolbarAction("s1");

    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.setupCompleted()).toBe(false);
    expect(f.autoTrigger()).toBe(false);
    expect(
      [...f.messages]
        .reverse()
        .find((message) => message.type === "ai-suggestion-state"),
    ).toMatchObject({
      availability: "needs-authorization",
    });
    expect(
      f.messages.some((message) => message.type === "ai-suggestion-trigger"),
    ).toBe(false);
  });

  it("uses one actual manual completion request for first-use consent", async () => {
    const f = fixture(false);
    f.setAccess(undefined);
    const request = await f.startManual(false);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.setupCompleted()).toBe(false);

    f.send.mockImplementationOnce(async () => {
      f.setAccess(true);
      return response('{"insertText":" next"}');
    });
    await f.host.requestSuggestion("s1", request);

    expect(f.send).toHaveBeenCalledTimes(1);
    const [messages, options] = f.send.mock.calls[0]! as unknown as [
      Array<{ content?: string }>,
      { justification?: string },
    ];
    expect(messages[0]?.content).not.toBe("Reply with OK.");
    expect(options).toMatchObject({
      justification:
        "Generate a short continuation from the active Markdown Mint editor surface.",
    });
    expect(f.setupCompleted()).toBe(true);
    expect(
      f.messages
        .filter((message) => message.type === "ai-suggestion-result")
        .at(-1),
    ).toMatchObject({
      type: "ai-suggestion-result",
      requestId: request.requestId,
      reason: "ready",
      text: " next",
    });
  });

  it("keeps first-use manual consent refusal blocked without retrying or persisting setup", async () => {
    const f = fixture(false);
    f.setAccess(undefined);
    const manualRequest = await f.startManual(false);
    f.send.mockRejectedValueOnce(
      Object.assign(new Error("Consent declined"), { code: "NoPermissions" }),
    );

    await f.host.requestSuggestion("s1", manualRequest);

    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.setupCompleted()).toBe(false);
    expect(
      f.messages
        .filter((message) => message.type === "ai-suggestion-result")
        .at(-1),
    ).toMatchObject({
      type: "ai-suggestion-result",
      requestId: manualRequest.requestId,
      reason: "needs-authorization",
    });
    f.setAutomatic(true);
    await f.host.requestSuggestion(
      "s1",
      f.autoRequest("no-consent-auto", true),
    );
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.setupCompleted()).toBe(false);
    expect(
      f.messages
        .filter((message) => message.type === "ai-suggestion-result")
        .at(-1),
    ).toMatchObject({
      type: "ai-suggestion-result",
      requestId: "no-consent-auto",
      reason: "needs-authorization",
    });
  });

  it("toggles the application setting without a completion and preserves manual requests", async () => {
    const f = fixture(false);
    f.addPanel("s2", "file:///second.md", () => false);
    await f.startManual();
    const triggerCount = () =>
      f.messages.filter((message) => message.type === "ai-suggestion-trigger")
        .length;
    const latestState = (sessionId: string) =>
      f.messages
        .filter(
          (message) =>
            message.type === "ai-suggestion-state" &&
            message.sessionId === sessionId,
        )
        .at(-1);
    const initialTriggerCount = triggerCount();

    await f.host.handleToolbarAction("s1");
    expect(f.autoTrigger()).toBe(true);
    expect(latestState("s1")).toMatchObject({
      type: "ai-suggestion-state",
      sessionId: "s1",
      autoTrigger: true,
      availability: "ready",
    });
    expect(latestState("s2")).toMatchObject({ autoTrigger: true });
    expect(triggerCount()).toBe(initialTriggerCount);

    await f.host.handleToolbarAction("s1");
    expect(f.autoTrigger()).toBe(false);
    expect(latestState("s1")).toMatchObject({
      type: "ai-suggestion-state",
      sessionId: "s1",
      autoTrigger: false,
      availability: "disabled",
    });
    expect(latestState("s2")).toMatchObject({ autoTrigger: false });
    expect(triggerCount()).toBe(initialTriggerCount);

    await f.host.triggerFromUserAction("s1");
    expect(triggerCount()).toBe(initialTriggerCount + 1);
  });

  it("turning automatic suggestions off removes candidates and cancels pending work", async () => {
    const f = fixture(true);
    await f.startManual();

    const candidateRequest = f.autoRequest("toolbar-off-candidate");
    f.send.mockResolvedValueOnce(
      response('{"insertText":" from the automatic candidate."}') as never,
    );
    await f.host.requestSuggestion("s1", candidateRequest);
    expect(f.messages.at(-1)).toMatchObject({
      type: "ai-suggestion-result",
      requestId: candidateRequest.requestId,
      reason: "ready",
    });

    await f.host.handleToolbarAction("s1");
    expect(f.autoTrigger()).toBe(false);
    await f.host.validateCandidateAdoption("s1", {
      ...candidateRequest,
      type: "ai-suggestion-adoption-check",
      attemptId: "toolbar-off-adoption",
    });
    expect(f.messages.at(-1)).toMatchObject({
      type: "ai-suggestion-adoption-validation",
      attemptId: "toolbar-off-adoption",
      available: false,
    });

    await f.host.handleToolbarAction("s1");
    expect(f.autoTrigger()).toBe(true);
    const delayed = deferred<Awaited<ReturnType<typeof response>>>();
    f.send.mockReturnValueOnce(delayed.promise);
    const pendingRequest = f.autoRequest("toolbar-off-pending");
    const pending = f.host.requestSuggestion("s1", pendingRequest);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));

    await f.host.handleToolbarAction("s1");
    await pending;
    delayed.resolve(response('{"insertText":" stale after turning off."}'));

    expect(f.autoTrigger()).toBe(false);
    expect(
      f.messages.some(
        (message) =>
          message.type === "ai-suggestion-result" &&
          message.requestId === pendingRequest.requestId &&
          message.reason === "ready",
      ),
    ).toBe(false);
    expect(f.messages.at(-1)).toMatchObject({
      type: "ai-suggestion-result",
      requestId: pendingRequest.requestId,
      reason: "cancelled",
    });
    f.dispose();
  });

  it("ignores a toolbar action from an inactive or unknown session", async () => {
    const f = fixture(false);
    let secondActive = false;
    f.addPanel("s2", "file:///second.md", () => secondActive);

    await f.host.handleToolbarAction("s2");
    await f.host.handleToolbarAction("unknown-session");

    expect(f.api.selectChatModels).not.toHaveBeenCalled();
    expect(f.autoTrigger()).toBe(false);
    expect(
      f.messages.some((message) => message.type === "ai-suggestion-trigger"),
    ).toBe(false);
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

  it("retries a blocked model only after an explicit toolbar action", async () => {
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
    vi.useFakeTimers();
    await f.host.requestSuggestion("s1", request("auto-typed-after-block"));
    f.host.documentChanged("file:///document.md");
    await f.activate("s1");
    f.host.refreshSettings();
    await vi.advanceTimersByTimeAsync(199);
    await f.host.requestSuggestion("s1", request("auto-after-199ms"));
    await vi.advanceTimersByTimeAsync(1);
    await f.host.requestSuggestion("s1", request("auto-after-200ms"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(modelSelection).toHaveBeenCalledTimes(modelSelectionCalls);
    expect(f.send).toHaveBeenCalledTimes(callsAfterBlock);

    await f.host.handleToolbarAction("s1");
    expect(modelSelection).toHaveBeenCalledTimes(modelSelectionCalls + 1);
    expect(f.send).toHaveBeenCalledTimes(callsAfterBlock);
    expect(f.messages.at(-1)).toMatchObject({
      type: "ai-suggestion-state",
      autoTrigger: true,
      availability: "ready",
    });

    f.send.mockResolvedValueOnce(
      response('{"insertText":" for safer publishing."}') as never,
    );
    await f.host.requestSuggestion("s1", request("auto-after-explicit-retry"));
    expect(f.send).toHaveBeenCalledTimes(callsAfterBlock + 1);
    expect(f.messages.at(-1)).toMatchObject({
      type: "ai-suggestion-result",
      reason: "ready",
    });
    f.dispose();
  });

  it("keeps automatic suggestions off after blocked recovery", async () => {
    const f = fixture(false);
    const manual = await f.startManual();
    f.send.mockRejectedValueOnce({ code: "Blocked" });
    await f.host.requestSuggestion("s1", manual);
    expect(
      f.messages
        .filter((message) => message.type === "ai-suggestion-result")
        .at(-1),
    ).toMatchObject({
      type: "ai-suggestion-result",
      reason: "blocked",
    });

    const modelSelectionCalls = vi.mocked(f.api.selectChatModels).mock.calls
      .length;
    const requestCalls = f.send.mock.calls.length;
    await f.host.handleToolbarAction("s1");

    expect(f.api.selectChatModels).toHaveBeenCalledTimes(
      modelSelectionCalls + 1,
    );
    expect(f.send).toHaveBeenCalledTimes(requestCalls);
    expect(f.setupCompleted()).toBe(true);
    expect(f.autoTrigger()).toBe(false);
    expect(f.messages.at(-1)).toMatchObject({
      type: "ai-suggestion-state",
      autoTrigger: false,
      availability: "disabled",
    });
    f.dispose();
  });

  it("lets the explicit Suggest Continuation action recover from blocked", async () => {
    const f = fixture(true);
    const manual = await f.startManual();
    f.send.mockRejectedValueOnce({ code: "Blocked" });
    await f.host.requestSuggestion("s1", manual);
    expect(
      f.messages
        .filter((message) => message.type === "ai-suggestion-result")
        .at(-1),
    ).toMatchObject({ reason: "blocked" });

    const modelSelectionCalls = vi.mocked(f.api.selectChatModels).mock.calls
      .length;
    const requestCalls = f.send.mock.calls.length;
    await f.host.triggerFromUserAction("s1");

    expect(f.api.selectChatModels).toHaveBeenCalledTimes(
      modelSelectionCalls + 1,
    );
    expect(f.send).toHaveBeenCalledTimes(requestCalls);
    expect(f.messages.at(-1)).toMatchObject({
      type: "ai-suggestion-state",
      autoTrigger: true,
      availability: "ready",
    });
    expect(
      f.messages.filter((message) => message.type === "ai-suggestion-trigger"),
    ).toHaveLength(2);
    f.dispose();
  });

  it("reacquires a saved model only after a real-input request after restart", async () => {
    const f = fixture(true);
    f.setSetupCompleted(true);
    f.host.publishState("s1");
    expect(f.messages.at(-1)).toMatchObject({
      type: "ai-suggestion-state",
      autoRestoreOnInput: true,
    });
    expect(f.api.selectChatModels).not.toHaveBeenCalled();
    f.send.mockResolvedValueOnce(
      response('{"insertText":" for safer publishing."}') as never,
    );

    await f.host.requestSuggestion("s1", f.autoRequest("restart-input", true));

    expect(f.api.selectChatModels).toHaveBeenCalledExactlyOnceWith({
      vendor: "copilot",
      id: f.model.id,
      version: f.model.version,
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
    "does not auto-reacquire a model after restart $label",
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
    f.setBeforeSnapshotValidation(() => f.setAccess(false));

    await f.host.requestSuggestion(
      "s1",
      f.autoRequest("restart-access-race", true),
    );
    f.setBeforeSnapshotValidation(undefined);
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
    f.modelsChanged([f.model]);
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

  it("preserves no-model recovery across an unassociated access event", async () => {
    const f = fixture(true);
    f.setSetupCompleted(true);
    vi.mocked(f.api.selectChatModels).mockResolvedValueOnce([]);

    await f.host.requestSuggestion("s1", f.autoRequest("missing-model", true));
    expect(
      f.messages
        .filter((message) => message.type === "ai-suggestion-result")
        .at(-1),
    ).toMatchObject({
      type: "ai-suggestion-result",
      reason: "no-model",
    });
    expect(
      f.messages
        .filter((message) => message.type === "ai-suggestion-state")
        .at(-1),
    ).toMatchObject({ autoRestoreOnInput: false });

    f.accessChanged();
    f.modelsChanged([f.model]);
    expect(f.api.selectChatModels).toHaveBeenCalledTimes(1);
    f.setText("The registered model can help", 2);
    f.send.mockResolvedValueOnce(
      response('{"insertText":" with the next step."}') as never,
    );
    await f.host.requestSuggestion("s1", f.autoRequest("model-restored", true));

    expect(f.api.selectChatModels).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.messages.at(-1)).toMatchObject({
      type: "ai-suggestion-result",
      reason: "ready",
    });
    f.dispose();
  });

  it("recovers permission after a model-list event without reusing its stale selection", async () => {
    const f = fixture(true);
    f.setSetupCompleted(true);
    f.send.mockResolvedValueOnce(
      response('{"insertText":" is drafted."}') as never,
    );
    await f.host.requestSuggestion(
      "s1",
      f.autoRequest("first-after-setup", true),
    );
    expect(f.api.selectChatModels).toHaveBeenCalledTimes(1);

    f.setAccess(false);
    f.modelsChanged([f.model]);
    f.setAccess(true);
    expect(f.api.selectChatModels).toHaveBeenCalledTimes(1);
    f.setText("The revised publication plan", 2);
    f.host.documentChanged("file:///document.md");
    f.send.mockResolvedValueOnce(
      response('{"insertText":" is ready."}') as never,
    );
    await f.host.requestSuggestion(
      "s1",
      f.autoRequest("permission-restored", true),
    );

    expect(f.api.selectChatModels).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenCalledTimes(2);
    const sendCalls = f.send.mock.calls as unknown as Array<[unknown]>;
    const requestMessages = sendCalls[1]?.[0] as
      Array<{ content?: string }> | undefined;
    expect(requestMessages?.[0]?.content).toContain(
      'PREFIX: "The revised publication plan"',
    );
    expect(f.messages.at(-1)).toMatchObject({
      type: "ai-suggestion-result",
      reason: "ready",
    });
    f.dispose();
  });

  it("cancels an active candidate when the selected model leaves the model list", async () => {
    const f = fixture();
    const request = await f.startManual();
    const generation = deferred<Awaited<ReturnType<typeof response>>>();
    f.send.mockReturnValue(generation.promise);
    const pending = f.host.requestSuggestion("s1", request);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));

    f.modelsChanged([]);
    await pending;
    generation.resolve(response('{"insertText":" stale candidate"}'));

    expect(f.api.selectChatModels).toHaveBeenCalledTimes(1);
    expect(
      f.messages.some(
        (message) =>
          message.type === "ai-suggestion-result" && message.reason === "ready",
      ),
    ).toBe(false);
    expect(f.messages.at(-1)).toMatchObject({
      type: "ai-suggestion-result",
      reason: "needs-authorization",
    });
    f.dispose();
  });

  it("confirms a cached candidate against the exact model after an unrelated list change", async () => {
    const f = fixture();
    const request = await f.startManual();
    f.send.mockResolvedValueOnce(
      response('{"insertText":" for the release."}') as never,
    );
    await f.host.requestSuggestion("s1", request);
    f.modelsChanged([
      f.model,
      {
        ...f.model,
        id: "copilot-other",
        version: "v2",
      } as vscode.LanguageModelChat,
    ]);

    await f.host.validateCandidateAdoption("s1", {
      ...request,
      type: "ai-suggestion-adoption-check",
      attemptId: "adopt-unrelated-list",
    });

    expect(f.messages.at(-1)).toMatchObject({
      type: "ai-suggestion-adoption-validation",
      attemptId: "adopt-unrelated-list",
      requestId: request.requestId,
      available: true,
    });
    expect(f.api.selectChatModels).toHaveBeenLastCalledWith({
      vendor: "copilot",
      id: f.model.id,
      version: f.model.version,
    });
    f.dispose();
  });

  it("keeps a candidate available for a fresh Tab check after its first check goes stale", async () => {
    const f = fixture();
    const request = await f.startManual();
    f.send.mockResolvedValueOnce(
      response('{"insertText":" for the release."}') as never,
    );
    await f.host.requestSuggestion("s1", request);
    f.modelsChanged([f.model]);
    const delayedMembership = deferred<readonly vscode.LanguageModelChat[]>();
    vi.mocked(f.api.selectChatModels).mockReturnValueOnce(
      delayedMembership.promise,
    );
    const check = (attemptId: string, baseVersion: number) => ({
      protocolVersion: 1 as const,
      type: "ai-suggestion-adoption-check" as const,
      attemptId,
      requestId: request.requestId,
      sessionId: request.sessionId,
      documentId: request.documentId,
      baseVersion,
      editorRevision: request.editorRevision,
      settingsGeneration: request.settingsGeneration,
      position: request.position,
      targetKind: request.targetKind,
    });

    const firstCheck = f.host.validateCandidateAdoption(
      "s1",
      check("adopt-stale", request.baseVersion),
    );
    await vi.waitFor(() =>
      expect(f.api.selectChatModels).toHaveBeenCalledTimes(2),
    );
    f.setText("The release helper!", 2);
    f.host.documentChanged("file:///document.md");
    delayedMembership.resolve([f.model]);
    await firstCheck;
    expect(
      f.messages
        .filter(
          (message) => message.type === "ai-suggestion-adoption-validation",
        )
        .at(-1),
    ).toMatchObject({ attemptId: "adopt-stale", available: false });

    await f.host.validateCandidateAdoption("s1", check("adopt-retry", 2));
    expect(
      f.messages
        .filter(
          (message) => message.type === "ai-suggestion-adoption-validation",
        )
        .at(-1),
    ).toMatchObject({ attemptId: "adopt-retry", available: true });
    f.dispose();
  });

  it("rejects Tab adoption when the selected model was removed", async () => {
    const f = fixture();
    const request = await f.startManual();
    f.send.mockResolvedValueOnce(response('{"insertText":" stale."}') as never);
    await f.host.requestSuggestion("s1", request);
    f.modelsChanged([]);

    await f.host.validateCandidateAdoption("s1", {
      ...request,
      type: "ai-suggestion-adoption-check",
      attemptId: "adopt-removed-model",
    });

    expect(
      f.messages
        .filter(
          (message) => message.type === "ai-suggestion-adoption-validation",
        )
        .at(-1),
    ).toMatchObject({
      type: "ai-suggestion-adoption-validation",
      attemptId: "adopt-removed-model",
      requestId: request.requestId,
      available: false,
    });
    expect(
      f.messages.some(
        (message) =>
          message.type === "ai-suggestion-state" &&
          message.availability === "no-model",
      ),
    ).toBe(true);
    f.dispose();
  });

  it("uses one actual manual request to receive first-use consent", async () => {
    const f = fixture(false);
    f.setAccess(undefined);
    const selection = deferred<readonly vscode.LanguageModelChat[]>();
    vi.mocked(f.api.selectChatModels).mockReturnValue(selection.promise);
    const command = f.host.triggerFromUserAction("s1");
    await vi.waitFor(() => expect(f.api.selectChatModels).toHaveBeenCalled());

    f.accessChanged();
    selection.resolve([f.model]);
    await command;
    expect(f.setupCompleted()).toBe(false);
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
    f.send.mockImplementationOnce(async () => {
      f.setAccess(true);
      return response('{"insertText":" from the authorized request."}');
    });
    await f.host.requestSuggestion("s1", request);
    expect(
      f.messages
        .filter((message) => message.type === "ai-suggestion-result")
        .at(-1),
    ).toMatchObject({ reason: "ready" });
    expect(f.setupCompleted()).toBe(true);
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

  it("uses only the bounded Mermaid draft with its dedicated completion prompt", async () => {
    const f = fixture();
    const manual = await f.startManual();
    const draft = "flowchart TD\n  A[Start] -->";
    const request: AiSuggestionRequest = {
      ...manual,
      requestId: "r-mermaid",
      position: 0,
      targetKind: "mermaid",
      surfaceText: draft,
      surfacePosition: draft.length,
    };
    f.send.mockResolvedValueOnce(response('{"insertText":" B[End]"}') as never);

    await f.host.requestSuggestion("s1", request);

    const sendCalls = f.send.mock.calls as unknown as Array<[unknown]>;
    const messages = sendCalls[0]?.[0] as
      Array<{ content?: string }> | undefined;
    expect(messages?.[0]?.content).toContain(
      "You complete Mermaid diagram source.",
    );
    expect(messages?.[0]?.content).toContain(
      `PREFIX: ${JSON.stringify(draft)}`,
    );
    expect(messages?.[0]?.content).not.toContain(
      "You complete prose in a Markdown document.",
    );
    expect(f.messages.at(-1)).toMatchObject({
      type: "ai-suggestion-result",
      requestId: request.requestId,
      reason: "ready",
      text: " B[End]",
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
