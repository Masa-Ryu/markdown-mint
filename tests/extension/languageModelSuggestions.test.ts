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

function setup(model = fakeModel()) {
  let permitted = true;
  const accessListeners = new Set<() => void>();
  const modelListeners = new Set<() => void>();
  const api: LanguageModelApi = {
    selectChatModels: vi.fn(async () => [model]),
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
  const adapter = new LanguageModelSuggestions({ api, access });
  return {
    adapter,
    api,
    model,
    permit(value: boolean) {
      permitted = value;
      for (const listener of accessListeners) listener();
    },
    modelsChanged() {
      for (const listener of modelListeners) listener();
    },
  };
}

describe("public VS Code Language Model adapter", () => {
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

  it("does not invalidate on an unrelated model-list event while selected-model access remains true", async () => {
    const f = setup();
    await f.adapter.selectForUserAction();
    const changed = vi.fn();
    f.adapter.onDidChange(changed);
    f.modelsChanged();
    expect(changed).not.toHaveBeenCalled();
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
