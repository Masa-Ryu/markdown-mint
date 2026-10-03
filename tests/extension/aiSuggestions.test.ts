import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import {
  AiSuggestionsHost,
  classifyAiError,
  createAiSuggestionsEnvironment,
  type AiModel,
  type AiSuggestionsEnvironment,
} from "../../src/extension/aiSuggestions";
import {
  AI_LIMITS,
  type AiHostMessage,
  type AiSuggestionRequest,
} from "../../src/shared/aiSuggestions";

const native = vi.hoisted(() => ({
  workspace: { isTrusted: true, getConfiguration: vi.fn() },
  lm: {
    selectChatModels: vi.fn(),
    onDidChangeChatModels: vi.fn(() => ({ dispose: vi.fn() })),
  },
  LanguageModelChatMessage: { User: vi.fn() },
  CancellationTokenSource: vi.fn(),
}));
vi.mock("vscode", () => native);

async function* pieces(...text: string[]): AsyncIterable<string> {
  yield* text;
}
function response(
  text: AsyncIterable<string> = pieces(" next", "🌿"),
): vscode.LanguageModelChatResponse {
  return { text } as vscode.LanguageModelChatResponse;
}
function setup(autoTrigger = false) {
  let settings = { autoTrigger, model: "" };
  let permitted: boolean | undefined = true;
  let eligible = true;
  let version = 1;
  let accessChanged: () => void = () => undefined;
  let modelsChanged: () => void = () => undefined;
  const messages: AiHostMessage[] = [];
  const sources: Array<{
    token: { isCancellationRequested: boolean };
    cancel: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }> = [];
  const model: AiModel = {
    id: "copilot-model",
    name: "A model",
    vendor: "copilot",
    maxInputTokens: 4096,
    countTokens: vi.fn(async () => 20),
    sendRequest: vi.fn(async () => response()),
  };
  const environment: AiSuggestionsEnvironment = {
    supported: vi.fn(() => true),
    trusted: vi.fn(() => true),
    settings: () => settings,
    saveModel: vi.fn(async (id) => {
      settings = { ...settings, model: id };
    }),
    models: vi.fn(async () => [model]),
    access: () => permitted,
    choose: vi.fn(async (models) => models[0]),
    explain: vi.fn(async () => true),
    notify: vi.fn(),
    user: (text) =>
      ({
        role: 1,
        content: [{ value: text }],
      }) as vscode.LanguageModelChatMessage,
    tokenSource: () => {
      const token = {
        isCancellationRequested: false,
        onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
      };
      const source = {
        token,
        cancel: vi.fn(() => {
          token.isCancellationRequested = true;
        }),
        dispose: vi.fn(),
      };
      sources.push(source);
      return source as unknown as vscode.CancellationTokenSource;
    },
    onAccessChanged: (listener) => {
      accessChanged = listener;
      return { dispose: vi.fn() };
    },
    onModelsChanged: (listener) => {
      modelsChanged = listener;
      return { dispose: vi.fn() };
    },
  };
  const host = new AiSuggestionsHost(environment);
  const panel = {
    id: "s1",
    documentId: () => "file:///prose.md",
    version: () => version,
    eligible: () => eligible,
    focus: vi.fn(),
    post: (message: AiHostMessage) => messages.push(message),
  };
  host.registerSession(panel);
  host.publishState(panel.id);
  const request = (
    trigger: "auto" | "manual" = "manual",
    patch: Partial<AiSuggestionRequest> = {},
  ): AiSuggestionRequest => {
    const state = messages
      .filter((message) => message.type === "ai-suggestion-state")
      .at(-1)!;
    const invocation = messages
      .filter((message) => message.type === "ai-suggestion-trigger")
      .at(-1);
    return {
      protocolVersion: 1,
      type: "ai-suggestion-request",
      requestId: `r-${messages.length}`,
      sessionId: "s1",
      documentId: "file:///prose.md",
      baseVersion: version,
      editorRevision: 1,
      settingsGeneration: state.settingsGeneration,
      position: 6,
      targetKind: "paragraph",
      trigger,
      context: { before: "Hello", after: "", heading: "" },
      ...(trigger === "manual" && invocation
        ? { invocationId: invocation.invocationId }
        : {}),
      ...patch,
    };
  };
  return {
    host,
    panel,
    model,
    environment,
    messages,
    sources,
    request,
    results: () =>
      messages.filter((message) => message.type === "ai-suggestion-result"),
    configure: (patch: Partial<typeof settings>) => {
      settings = { ...settings, ...patch };
      host.refreshSettings();
    },
    permission: (value: boolean | undefined) => {
      permitted = value;
      accessChanged();
    },
    modelsChanged: () => modelsChanged(),
    setEligible: (value: boolean) => {
      eligible = value;
    },
    setVersion: (value: number) => {
      version = value;
    },
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});
describe("AI host isolation and authorization", () => {
  it("starts off, never enumerates or asks consent on startup, and supports manual requests while off", async () => {
    const f = setup();
    expect(f.environment.models).not.toHaveBeenCalled();
    expect(f.environment.explain).not.toHaveBeenCalled();
    await f.host.triggerFromUserAction("s1");
    const request = f.request();
    await f.host.requestSuggestion("s1", request);
    expect(f.results().at(-1)?.text).toBe(" next🌿");
    expect(f.panel.focus).toHaveBeenCalled();
    expect(f.sources[0]?.dispose).toHaveBeenCalled();
    await f.host.requestSuggestion("s1", request); // One invocation cannot be reused.
    expect(f.model.sendRequest).toHaveBeenCalledTimes(1);
    f.host.dispose();
  });
  it.each([false, undefined])(
    "never sends automatic requests with access %s",
    async (permission) => {
      const f = setup(true);
      await f.host.triggerFromUserAction("s1");
      f.permission(permission);
      await f.host.requestSuggestion("s1", f.request("auto"));
      expect(f.model.sendRequest).not.toHaveBeenCalled();
      expect(f.environment.models).toHaveBeenCalledTimes(1);
      expect(f.environment.notify).not.toHaveBeenCalled();
      f.host.dispose();
    },
  );
  it("permits consent only for an actual command invocation, including a grant during its response", async () => {
    const f = setup(true);
    f.permission(undefined);
    await f.host.triggerFromUserAction("s1");
    await f.host.requestSuggestion(
      "s1",
      f.request("manual", { invocationId: "forged" }),
    );
    expect(f.model.sendRequest).not.toHaveBeenCalled();
    await f.host.triggerFromUserAction("s1");
    vi.mocked(f.model.sendRequest).mockImplementation(async () => {
      f.permission(true);
      return response();
    });
    await f.host.requestSuggestion("s1", f.request());
    expect(f.results().at(-1)?.reason).toBe("ready");
    f.host.dispose();
  });
  it("requires a manual resume on restart/model loss and never silently changes a model", async () => {
    const f = setup(true);
    f.configure({ model: "copilot-model" });
    await f.host.requestSuggestion("s1", f.request("auto"));
    expect(f.environment.models).not.toHaveBeenCalled();
    await f.host.triggerFromUserAction("s1");
    f.modelsChanged();
    await f.host.requestSuggestion("s1", f.request("auto"));
    expect(f.model.sendRequest).not.toHaveBeenCalled();
    expect(f.environment.models).toHaveBeenCalledTimes(1);
    f.configure({ model: "missing" });
    await f.host.triggerFromUserAction("s1");
    expect(f.environment.choose).not.toHaveBeenCalled();
    expect(f.environment.notify).toHaveBeenCalledWith("no-model");
    f.host.dispose();
  });
  it("rejects a model invalidated while its user setting is being saved", async () => {
    const f = setup(true);
    const save = vi.mocked(f.environment.saveModel).getMockImplementation()!;
    vi.mocked(f.environment.saveModel).mockImplementation(async (id) => {
      await save(id);
      f.modelsChanged();
    });
    await f.host.triggerFromUserAction("s1");
    expect(
      f.messages.some((message) => message.type === "ai-suggestion-trigger"),
    ).toBe(false);
    await f.host.requestSuggestion("s1", f.request("auto"));
    expect(f.model.sendRequest).not.toHaveBeenCalled();
    await f.host.triggerFromUserAction("s1");
    expect(f.environment.models).toHaveBeenCalledTimes(2);
    f.host.dispose();
  });
  it.each(["unsupported", "untrusted"] as const)(
    "does not touch model APIs in an %s environment",
    async (reason) => {
      const f = setup(true);
      if (reason === "unsupported")
        vi.mocked(f.environment.supported).mockReturnValue(false);
      else vi.mocked(f.environment.trusted).mockReturnValue(false);
      await f.host.triggerFromUserAction("s1");
      await f.host.requestSuggestion("s1", f.request("auto"));
      expect(f.environment.models).not.toHaveBeenCalled();
      expect(f.model.sendRequest).not.toHaveBeenCalled();
      expect(f.environment.notify).toHaveBeenCalledWith(reason);
      f.host.dispose();
    },
  );
  it.each([
    { sessionId: "other" },
    { documentId: "file:///other.md" },
    { baseVersion: 0 },
    { baseVersion: 2 },
    { settingsGeneration: 100 },
    { trigger: "manual", invocationId: "fake" },
  ] as const)("rejects wrong identity %j", async (patch) => {
    const f = setup(true);
    await f.host.triggerFromUserAction("s1");
    await f.host.requestSuggestion("s1", f.request("auto", patch));
    expect(f.model.sendRequest).not.toHaveBeenCalled();
    f.host.dispose();
  });
  it("rejects inactive panels and expired command nonces", async () => {
    const f = setup(true);
    await f.host.triggerFromUserAction("s1");
    f.setEligible(false);
    await f.host.requestSuggestion("s1", f.request("auto"));
    f.setEligible(true);
    vi.setSystemTime(AI_LIMITS.deadlineMs + 1);
    await f.host.requestSuggestion("s1", f.request());
    expect(f.model.sendRequest).not.toHaveBeenCalled();
    f.host.dispose();
  });
  it("ignores workspace overrides when reading application settings", () => {
    native.workspace.getConfiguration.mockReturnValue({
      inspect: (key: string) =>
        key === "autoTrigger"
          ? {
              defaultValue: false,
              workspaceValue: true,
              workspaceFolderValue: true,
            }
          : { defaultValue: "", workspaceValue: "injected-model" },
    });
    const environment = createAiSuggestionsEnvironment(
      {} as vscode.ExtensionContext,
    );
    expect(environment.settings()).toEqual({ autoTrigger: false, model: "" });
  });
});
describe("AI request lifetime and limits", () => {
  it.each(["cancel", "permission", "model", "document", "dispose", "auto-off"])(
    "drops a provider's delayed response after %s",
    async (action) => {
      const f = setup(true);
      await f.host.triggerFromUserAction("s1");
      let resolve!: (value: vscode.LanguageModelChatResponse) => void;
      vi.mocked(f.model.sendRequest).mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      const request = f.request("auto");
      const pending = f.host.requestSuggestion("s1", request);
      await vi.advanceTimersByTimeAsync(0);
      if (action === "cancel") f.host.cancelSession("s1", request.requestId);
      if (action === "permission") f.permission(false);
      if (action === "model") f.configure({ model: "another" });
      if (action === "document") {
        f.setVersion(2);
        f.host.cancelSession("s1");
      }
      if (action === "dispose") f.host.dispose();
      if (action === "auto-off") f.configure({ autoTrigger: false });
      await pending;
      resolve(response());
      await vi.advanceTimersByTimeAsync(0);
      expect(f.results().some((result) => result.reason === "ready")).toBe(
        false,
      );
      expect(f.sources[0]?.token.isCancellationRequested).toBe(true);
      expect(f.sources[0]?.dispose).toHaveBeenCalled();
      f.host.dispose();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("keeps an in-flight manual request when automatic suggestions are switched off", async () => {
    const f = setup(true);
    await f.host.triggerFromUserAction("s1");
    vi.mocked(f.model.sendRequest).mockImplementation(async () => {
      f.configure({ autoTrigger: false });
      return response();
    });
    await f.host.requestSuggestion("s1", f.request());
    expect(f.results().at(-1)?.reason).toBe("ready");
    f.host.dispose();
  });
  it("settles deadlines even when a provider ignores cancellation, then discards its response", async () => {
    const f = setup(true);
    await f.host.triggerFromUserAction("s1");
    let resolve!: (value: vscode.LanguageModelChatResponse) => void;
    vi.mocked(f.model.sendRequest).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = f.host.requestSuggestion("s1", f.request());
    await vi.advanceTimersByTimeAsync(AI_LIMITS.deadlineMs);
    await pending;
    expect(f.results().at(-1)?.reason).toBe("timeout");
    resolve(response());
    await vi.advanceTimersByTimeAsync(0);
    expect(f.results().some((result) => result.reason === "ready")).toBe(false);
    expect(f.sources[0]?.dispose).toHaveBeenCalled();
    f.host.dispose();
  });
  it("enforces send intervals and the rolling host-wide request cap, including cancelled sends", async () => {
    const f = setup(true);
    await f.host.triggerFromUserAction("s1");
    vi.mocked(f.model.sendRequest).mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    for (let index = 0; index < AI_LIMITS.requestsPerWindow; index += 1) {
      vi.setSystemTime(index * AI_LIMITS.autoIntervalMs);
      const request = f.request("auto");
      const pending = f.host.requestSuggestion("s1", request);
      if (index === 0) {
        await vi.advanceTimersByTimeAsync(0);
        f.host.cancelSession("s1", request.requestId);
      }
      await pending;
    }
    vi.setSystemTime(24_000);
    await f.host.requestSuggestion("s1", f.request("auto"));
    expect(f.results().at(-1)?.reason).toBe("rate-limited");
    expect(f.model.sendRequest).toHaveBeenCalledTimes(12);
    vi.setSystemTime(60_001);
    await f.host.requestSuggestion("s1", f.request("auto"));
    expect(f.model.sendRequest).toHaveBeenCalledTimes(13);
    f.host.dispose();
  });
  it("blocks sends for a minute, then permits a fresh input request without a background retry", async () => {
    const f = setup(true);
    await f.host.triggerFromUserAction("s1");
    vi.mocked(f.model.sendRequest).mockRejectedValueOnce({ code: "Blocked" });
    await f.host.requestSuggestion("s1", f.request("auto"));
    vi.setSystemTime(59_999);
    await f.host.requestSuggestion("s1", f.request("auto"));
    expect(f.model.sendRequest).toHaveBeenCalledTimes(1);
    vi.setSystemTime(60_001);
    await f.host.requestSuggestion("s1", f.request("auto"));
    expect(f.model.sendRequest).toHaveBeenCalledTimes(2);
    expect(f.results().at(-1)?.reason).toBe("ready");
    expect(f.environment.notify).not.toHaveBeenCalled();
    f.host.dispose();
  });
  it("releases requests even when the stream's cleanup throws synchronously", async () => {
    const f = setup(true);
    await f.host.triggerFromUserAction("s1");
    const iterator = {
      next: async () => ({ done: true as const, value: undefined }),
      return: vi.fn(() => {
        throw Error("provider cleanup failure");
      }),
    };
    vi.mocked(f.model.sendRequest).mockResolvedValueOnce(
      response({ [Symbol.asyncIterator]: () => iterator }),
    );
    await f.host.requestSuggestion("s1", f.request("auto"));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.results().at(-1)?.reason).toBe("no-suggestion");
    expect(iterator.return).toHaveBeenCalled();
    expect(f.sources[0]?.dispose).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(2000);
    await f.host.requestSuggestion("s1", f.request("auto"));
    expect(f.results().at(-1)?.reason).toBe("ready");
    f.host.dispose();
  });
  it("cancels the preceding host request before starting a new valid one", async () => {
    const f = setup(true);
    await f.host.triggerFromUserAction("s1");
    vi.mocked(f.model.sendRequest).mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    const first = f.host.requestSuggestion("s1", f.request("auto"));
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(2000);
    await f.host.requestSuggestion("s1", f.request("auto"));
    await first;
    expect(f.sources[0]?.token.isCancellationRequested).toBe(true);
    expect(
      f.results().filter((result) => result.reason === "ready"),
    ).toHaveLength(1);
    f.host.dispose();
  });
  it.each(["NoPermissions", "NotFound", "Blocked", "network"])(
    "normalizes %s without revealing provider exception text",
    async (code) => {
      const f = setup(true);
      await f.host.triggerFromUserAction("s1");
      vi.mocked(f.model.sendRequest).mockRejectedValue({
        code,
        message: "secret document/path/token",
      });
      await f.host.requestSuggestion("s1", f.request());
      expect(f.results().at(-1)?.reason).toBe(classifyAiError({ code }));
      expect(JSON.stringify(f.messages)).not.toContain("secret");
      expect(f.environment.notify).toHaveBeenCalledWith(
        classifyAiError({ code }),
      );
      f.host.dispose();
    },
  );
  it("handles stream errors and output overflow without displaying a partial candidate or automatic retry", async () => {
    const f = setup(true);
    await f.host.triggerFromUserAction("s1");
    vi.mocked(f.model.sendRequest).mockResolvedValueOnce(
      response(
        (async function* () {
          yield "partial";
          throw Error("secret");
        })(),
      ),
    );
    await f.host.requestSuggestion("s1", f.request("auto"));
    expect(f.results().at(-1)?.reason).toBe("failed");
    vi.setSystemTime(2000);
    await f.host.requestSuggestion("s1", f.request("auto"));
    expect(f.model.sendRequest).toHaveBeenCalledTimes(1);
    vi.setSystemTime(30_001);
    vi.mocked(f.model.sendRequest).mockResolvedValueOnce(
      response(pieces("x".repeat(481))),
    );
    await f.host.requestSuggestion("s1", f.request("auto"));
    expect(f.results().at(-1)?.reason).toBe("no-suggestion");
    expect(f.environment.notify).not.toHaveBeenCalled();
    f.host.dispose();
  });
});
