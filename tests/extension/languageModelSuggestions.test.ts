import { describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import {
  chooseCompletionModel,
  classifyLanguageModelError,
  LanguageModelSuggestions,
  type LanguageModelApi,
  type LanguageModelAccess,
} from "../../src/extension/languageModelSuggestions";

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

function token(): vscode.CancellationToken {
  return { isCancellationRequested: false } as vscode.CancellationToken;
}

function fakeModel(overrides: Record<string, unknown> = {}) {
  return {
    id: "copilot-z",
    name: "Copilot Z",
    vendor: "copilot",
    family: "gpt-4o",
    version: "v1",
    maxInputTokens: 32_000,
    countTokens: vi.fn(async () => 50),
    sendRequest: vi.fn(async () => ({
      text: (async function* () {
        yield '{"insertText":" next"}';
      })(),
    })),
    ...overrides,
  } as unknown as vscode.LanguageModelChat;
}

function setup(model = fakeModel(), savedIdentity = true) {
  let permitted: boolean | undefined = true;
  let availableModels: readonly vscode.LanguageModelChat[] = [model];
  const accessListeners = new Set<() => void>();
  const modelListeners = new Set<() => void>();
  const api: LanguageModelApi = {
    selectChatModels: vi.fn(async () => availableModels),
    onDidChangeChatModels: (listener) => {
      modelListeners.add(listener);
      return { dispose: () => modelListeners.delete(listener) };
    },
  };
  const access: LanguageModelAccess = {
    canSendRequest: () => permitted,
    onDidChange: (listener) => {
      accessListeners.add(listener);
      return { dispose: () => accessListeners.delete(listener) };
    },
  };
  const adapter = new LanguageModelSuggestions({
    api,
    access,
    savedModelIdentity: savedIdentity
      ? () => ({ id: model.id, version: model.version })
      : () => undefined,
  });
  return {
    adapter,
    api,
    access,
    model,
    permit(value: boolean | undefined) {
      permitted = value;
      for (const listener of accessListeners) listener();
    },
    modelsChanged(models?: readonly vscode.LanguageModelChat[]) {
      if (models) availableModels = models;
      for (const listener of modelListeners) listener();
    },
  };
}

describe("public VS Code Language Model adapter", () => {
  it("starts first-use setup consent with one context-free request and discards its response", async () => {
    const f = setup(fakeModel(), false);
    f.permit(undefined);
    vi.mocked(f.model.sendRequest).mockImplementationOnce(async () => {
      f.permit(true);
      return {
        text: (async function* () {
          yield "ignored setup response";
        })(),
      } as never;
    });

    await expect(f.adapter.selectForUserAction("setup")).resolves.toBe(
      undefined,
    );

    expect(f.model.sendRequest).toHaveBeenCalledTimes(1);
    const [messages, options] = vi.mocked(f.model.sendRequest).mock.calls[0]!;
    expect(messages).toEqual([{ role: 1, content: "Reply with OK." }]);
    expect(options).toMatchObject({
      justification: "Enable Copilot prose suggestions in Markdown Mint.",
    });
    expect(f.adapter.currentSelection?.model).toBe(f.model);
    expect(f.adapter.restoreAccess()).toBeUndefined();
    f.adapter.dispose();
  });

  it("leaves setup incomplete after consent is refused and does not retry", async () => {
    const f = setup(fakeModel(), false);
    f.permit(undefined);
    vi.mocked(f.model.sendRequest).mockRejectedValueOnce(
      Object.assign(new Error("Consent declined"), { code: "NoPermissions" }),
    );

    await expect(f.adapter.selectForUserAction("setup")).resolves.toBe(
      "needs-authorization",
    );
    expect(f.model.sendRequest).toHaveBeenCalledTimes(1);
    expect(f.adapter.currentSelection).toBeUndefined();
    f.adapter.dispose();
  });

  it("uses the manual completion request itself for first-use consent", async () => {
    const f = setup(fakeModel(), false);
    f.permit(undefined);

    await expect(f.adapter.selectForUserAction("suggestion")).resolves.toBe(
      undefined,
    );
    expect(f.model.sendRequest).not.toHaveBeenCalled();
    vi.mocked(f.model.sendRequest).mockImplementationOnce(async () => {
      f.permit(true);
      return {
        text: (async function* () {
          yield '{"insertText":" next"}';
        })(),
      } as never;
    });

    await expect(
      f.adapter.complete("The existing text", 17, "paragraph", token(), {
        allowConsentPrompt: true,
      }),
    ).resolves.toEqual({ text: " next" });

    expect(f.model.sendRequest).toHaveBeenCalledTimes(1);
    const [messages, options] = vi.mocked(f.model.sendRequest).mock.calls[0]!;
    expect(messages[0]?.content).not.toBe("Reply with OK.");
    expect(options).toMatchObject({
      justification:
        "Generate a short prose continuation from the current Markdown in Markdown Mint.",
    });
    f.adapter.dispose();
  });

  it("never opens consent from an automatic request when access is unknown", async () => {
    const f = setup(fakeModel(), false);
    f.permit(undefined);
    await f.adapter.selectForUserAction("suggestion");

    await expect(
      f.adapter.complete("The existing text", 17, "paragraph", token()),
    ).resolves.toEqual({ failure: "needs-authorization" });
    expect(f.model.sendRequest).not.toHaveBeenCalled();
    f.adapter.dispose();
  });

  it("coalesces concurrent user-initiated model selection while consent is pending", async () => {
    const f = setup();
    const pending = deferred<readonly vscode.LanguageModelChat[]>();
    vi.mocked(f.api.selectChatModels).mockReturnValue(pending.promise);
    const first = f.adapter.selectForUserAction();
    const second = f.adapter.selectForUserAction();
    expect(f.api.selectChatModels).toHaveBeenCalledTimes(1);
    pending.resolve([f.model]);
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(f.adapter.restoreAccess()).toBeUndefined();
    f.adapter.dispose();
  });

  it("selects an available low-latency family without relying on result order", () => {
    const first = fakeModel({ id: "copilot-z", family: "gpt-4o" });
    const mini = fakeModel({ id: "copilot-a", family: "gpt-4o-mini" });
    const result = chooseCompletionModel([first, mini]);
    expect(result?.model).toBe(mini);
    expect(result?.reason).toContain("mini");
  });

  it("requires access before it sends a request and preserves exact JSON insertion whitespace", async () => {
    const f = setup();
    expect(await f.adapter.selectForUserAction()).toBeUndefined();
    const result = await f.adapter.complete(
      "This function",
      13,
      "paragraph",
      token(),
    );
    expect(result).toEqual({ text: " next" });
    expect(f.model.sendRequest).toHaveBeenCalledTimes(1);
    f.permit(false);
    expect(
      await f.adapter.complete("This function", 13, "paragraph", token()),
    ).toEqual({ failure: "needs-authorization" });
    expect(f.model.sendRequest).toHaveBeenCalledTimes(1);
    f.adapter.dispose();
  });

  it("does not select a model or open consent from restoreAccess", () => {
    const f = setup();
    expect(f.adapter.restoreAccess()).toBe("needs-authorization");
    expect(f.api.selectChatModels).not.toHaveBeenCalled();
    f.adapter.dispose();
  });

  it("reacquires a previously authorized model after cold restart only on user input", async () => {
    const f = setup();
    expect(f.adapter.currentSelection).toBeUndefined();
    expect(f.adapter.canRevalidateForUserInput()).toBe(true);
    expect(f.api.selectChatModels).not.toHaveBeenCalled();

    await expect(f.adapter.revalidateForUserInput()).resolves.toBeUndefined();

    expect(f.api.selectChatModels).toHaveBeenCalledExactlyOnceWith({
      vendor: "copilot",
      id: f.model.id,
      version: f.model.version,
    });
    expect(f.adapter.currentSelection?.model).toBe(f.model);
    expect(f.adapter.restoreAccess()).toBeUndefined();
    f.adapter.dispose();
  });

  it("does not enumerate all models for automatic restoration without a saved identity", async () => {
    const f = setup(fakeModel(), false);
    expect(f.adapter.canRevalidateForUserInput()).toBe(false);
    await expect(f.adapter.revalidateForUserInput()).resolves.toBe(
      "needs-authorization",
    );
    expect(f.api.selectChatModels).not.toHaveBeenCalled();
    f.adapter.dispose();
  });

  it("stops using the selected model when permission is revoked and does not recover its old result", async () => {
    const f = setup();
    await f.adapter.selectForUserAction();
    const delayed = deferred<Awaited<ReturnType<typeof f.model.sendRequest>>>();
    vi.mocked(f.model.sendRequest).mockReturnValue(delayed.promise as never);
    const request = f.adapter.complete("A sentence", 10, "paragraph", token());
    await vi.waitFor(() =>
      expect(f.model.sendRequest).toHaveBeenCalledTimes(1),
    );
    f.permit(false);
    delayed.resolve({
      text: (async function* () {
        yield '{"insertText":" stale"}';
      })(),
    } as never);
    await expect(request).resolves.toMatchObject({ failure: "cancelled" });
    f.adapter.dispose();
  });

  it("handles delayed stream failures and classifies public API error codes", async () => {
    const f = setup(
      fakeModel({
        sendRequest: vi.fn(async () => ({
          text: (async function* () {
            yield '{"insertText":"a"}';
            throw new Error("stream ended");
          })(),
        })),
      }),
    );
    await f.adapter.selectForUserAction();
    await expect(
      f.adapter.complete("A sentence", 10, "paragraph", token()),
    ).resolves.toEqual({ failure: "failed" });
    expect(classifyLanguageModelError({ code: "Blocked" })).toBe("blocked");
    expect(classifyLanguageModelError({ code: "NoPermissions" })).toBe(
      "needs-authorization",
    );
    expect(classifyLanguageModelError({ code: "NotFound" })).toBe("no-model");
    f.adapter.dispose();
  });

  it("keeps a candidate model after an unrelated list change and rechecks it by exact identity", async () => {
    const f = setup();
    await f.adapter.selectForUserAction();
    const changed = vi.fn();
    f.adapter.onDidChange(changed);
    const unrelated = fakeModel({
      id: "copilot-unrelated",
      version: "v2",
    });
    f.modelsChanged([f.model, unrelated]);
    expect(f.access.canSendRequest(f.model)).toBe(true);
    const selection = f.adapter.currentSelection;
    expect(selection?.model).toBe(f.model);
    expect(f.adapter.modelSelectionStale).toBe(true);
    expect(f.adapter.restoreAccess()).toBe("needs-authorization");
    expect(f.api.selectChatModels).toHaveBeenCalledTimes(1);
    expect(changed.mock.calls).toEqual([["models"]]);
    await expect(
      f.adapter.validateSelectionForAdoption(selection!),
    ).resolves.toBe("available");
    expect(f.api.selectChatModels).toHaveBeenLastCalledWith({
      vendor: "copilot",
      id: f.model.id,
      version: f.model.version,
    });
    expect(f.adapter.modelSelectionStale).toBe(false);
    f.adapter.dispose();
  });

  it("does not strand a real-input retry when the model list changes during exact revalidation", async () => {
    const f = setup();
    await f.adapter.selectForUserAction();
    f.modelsChanged([f.model]);
    const pending = deferred<readonly vscode.LanguageModelChat[]>();
    vi.mocked(f.api.selectChatModels).mockReturnValueOnce(pending.promise);

    const firstRevalidation = f.adapter.revalidateForUserInput();
    await vi.waitFor(() =>
      expect(f.api.selectChatModels).toHaveBeenCalledTimes(2),
    );
    f.modelsChanged([f.model]);
    pending.resolve([f.model]);
    await expect(firstRevalidation).resolves.toBe("cancelled");

    expect(f.adapter.canRevalidateForUserInput()).toBe(true);
    await expect(f.adapter.revalidateForUserInput()).resolves.toBeUndefined();
    expect(f.api.selectChatModels).toHaveBeenCalledTimes(3);
    expect(f.adapter.modelSelectionStale).toBe(false);
    f.adapter.dispose();
  });

  it("rejects an adoption check when the selected id and version disappear", async () => {
    const f = setup();
    await f.adapter.selectForUserAction();
    const selection = f.adapter.currentSelection;
    expect(selection).toBeDefined();
    f.modelsChanged([]);

    await expect(
      f.adapter.validateSelectionForAdoption(selection!),
    ).resolves.toBe("missing");
    expect(f.adapter.currentSelection).toBeUndefined();
    expect(f.model.sendRequest).not.toHaveBeenCalled();
    f.adapter.dispose();
  });

  it("keeps tracking permission across model-list invalidation without restoring the stale model", async () => {
    const f = setup();
    await f.adapter.selectForUserAction();
    const changed = vi.fn();
    f.adapter.onDidChange(changed);

    f.permit(false);
    f.modelsChanged([f.model]);
    f.permit(true);

    expect(changed.mock.calls).toEqual([
      ["access", false],
      ["models"],
      ["access", true],
    ]);
    expect(f.adapter.currentSelection?.model).toBe(f.model);
    expect(f.api.selectChatModels).toHaveBeenCalledTimes(1);

    await expect(f.adapter.selectForUserAction()).resolves.toBeUndefined();
    expect(f.api.selectChatModels).toHaveBeenCalledTimes(2);
    expect(f.api.selectChatModels).toHaveBeenLastCalledWith({
      vendor: "copilot",
      id: f.model.id,
      version: f.model.version,
    });
    expect(f.adapter.currentSelection?.model).toBe(f.model);
    f.adapter.dispose();
  });

  it("labels missing-selection change events so the host can recover only on model registration", () => {
    const f = setup();
    const changed = vi.fn();
    f.adapter.onDidChange(changed);
    f.modelsChanged();
    f.permit(false);
    expect(changed.mock.calls).toEqual([["models"], ["access"]]);
    f.adapter.dispose();
  });
});
