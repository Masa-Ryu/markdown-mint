import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextSelection } from "prosemirror-state";
import {
  parseMarkdown,
  renderMarkdown,
  schema,
  serializeMarkdown,
} from "../../src/core";
import {
  AI_LIMITS,
  type AiSuggestionRequest,
} from "../../src/shared/aiSuggestions";
import {
  AiSuggestionsHost,
  type AiPanelSession,
  type AiSuggestionsEnvironment,
} from "../../src/extension/aiSuggestions";
import type { CopilotLanguageServer } from "../../src/extension/copilotLanguageServer";
import {
  createEditorApp,
  type MarkdownEditorApp,
} from "../../src/webview/editor";

const apps: MarkdownEditorApp[] = [];

vi.mock("vscode", () => ({
  window: { showInformationMessage: vi.fn(async () => undefined) },
  env: { clipboard: { writeText: vi.fn() }, openExternal: vi.fn() },
  Uri: { parse: (value: string) => ({ toString: () => value }) },
  workspace: { isTrusted: true },
}));

function receive(data: unknown): void {
  window.dispatchEvent(new MessageEvent("message", { data }));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(source = "Hello", autoTrigger = false) {
  const root = document.createElement("div");
  document.body.append(root);
  const messages: Array<Record<string, unknown>> = [];
  const setState = vi.fn();
  const app = createEditorApp({
    root,
    core: { schema, parseMarkdown, renderMarkdown, serializeMarkdown },
    vscode: {
      postMessage: (message) =>
        messages.push(message as Record<string, unknown>),
      getState: () => undefined,
      setState,
    },
    initialDocument: {
      markdown: source,
      profile: "github",
      version: 1,
      documentId: "file:///prose.md",
    },
  });
  apps.push(app);
  app.view.setProps({ handleScrollToSelection: () => true });
  app.view.dispatch(
    app.view.state.tr.setSelection(
      TextSelection.create(
        app.view.state.doc,
        app.view.state.doc.content.size - 1,
      ),
    ),
  );
  app.view.focus();
  const state = (patch = {}) =>
    receive({
      protocolVersion: 1,
      type: "ai-suggestion-state",
      sessionId: "s1",
      settingsGeneration: 1,
      autoTrigger,
      availability: "ready",
      statusText: "Copilot ready",
      ...patch,
    });
  state();
  const trigger = () =>
    receive({
      protocolVersion: 1,
      type: "ai-suggestion-trigger",
      sessionId: "s1",
      settingsGeneration: 1,
    });
  const requests = () =>
    messages.filter(
      (message) => message.type === "ai-suggestion-request",
    ) as unknown as AiSuggestionRequest[];
  const result = (text = " next🌿", request = requests().at(-1)!, patch = {}) =>
    receive({
      protocolVersion: 1,
      type: "ai-suggestion-result",
      requestId: request.requestId,
      sessionId: request.sessionId,
      documentId: request.documentId,
      baseVersion: request.baseVersion,
      editorRevision: request.editorRevision,
      settingsGeneration: request.settingsGeneration,
      position: request.position,
      targetKind: request.targetKind,
      candidateId: "candidate-" + requests().length,
      partialAcceptanceOffset: 0,
      text,
      reason: "ready",
      ...patch,
    });
  const ack = () => {
    const edit = messages.filter((message) => message.type === "edit").at(-1)!;
    receive({
      protocolVersion: 1,
      type: "document",
      markdown: edit.markdown,
      version: app.version + 1,
      profile: app.profile,
      documentId: "file:///prose.md",
      operationId: edit.operationId,
      reason: "ack",
    });
  };
  const type = (text: string, inputType = "insertText") => {
    app.view.dom.dispatchEvent(
      new InputEvent("beforeinput", { bubbles: true, inputType, data: text }),
    );
    app.view.dispatch(app.view.state.tr.insertText(text));
  };
  const key = (key: string, patch: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...patch,
    });
    app.view.dom.dispatchEvent(event);
    return event;
  };
  return {
    app,
    root,
    messages,
    setState,
    state,
    trigger,
    requests,
    result,
    ack,
    type,
    key,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const app of apps.splice(0)) app.destroy();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("Copilot inline completion ghost", () => {
  it("maps a synchronized PM cursor to Markdown UTF-16 source and keeps display transient", async () => {
    const f = setup("日本語🌿 prose");
    f.trigger();
    await vi.advanceTimersByTimeAsync(0);
    const request = f.requests()[0]!;
    expect(request.position).toBe("日本語🌿 prose".length);
    const before = f.app.view.state.doc;
    const writes = f.setState.mock.calls.length;
    f.result(" continues");
    expect(f.root.querySelector(".mm-ai-suggestion")?.textContent).toBe(
      " continues",
    );
    expect(f.app.view.state.doc).toBe(before);
    expect(f.app.sync.hasPending).toBe(false);
    expect(f.messages.some((message) => message.type === "edit")).toBe(false);
    expect(f.setState.mock.calls.length).toBe(writes);
    expect(f.key("Escape").defaultPrevented).toBe(true);
    expect(f.root.querySelector(".mm-ai-suggestion")).toBeNull();
  });

  it("accepts the candidate as a normal single edit and preserves marks and host undo boundaries", async () => {
    const f = setup("**Hello**");
    f.trigger();
    await vi.advanceTimersByTimeAsync(0);
    f.result(" next");
    expect(f.key("Tab").defaultPrevented).toBe(true);
    const edits = f.messages.filter((message) => message.type === "edit");
    expect(edits).toHaveLength(1);
    expect(edits[0]?.markdown).toContain("**Hello next**");
    expect(
      f.app.view.state.doc.lastChild?.lastChild?.marks.map(
        (mark) => mark.type.name,
      ),
    ).toContain("strong");
    f.ack();
    f.key("z", { ctrlKey: true });
    expect(f.messages.some((message) => message.type === "undo")).toBe(true);
  });

  it("keeps only the unmatched remainder when the user types matching completion text", async () => {
    const f = setup("Hello");
    f.trigger();
    await vi.advanceTimersByTimeAsync(0);
    f.result(" world");
    f.type(" ");
    expect(f.root.querySelector(".mm-ai-suggestion")?.textContent).toBe(
      "world",
    );
    expect(
      f.messages.some(
        (message) =>
          message.type === "ai-suggestion-feedback" &&
          message.action === "partially-accepted" &&
          message.acceptedLength === 1,
      ),
    ).toBe(true);
    expect(
      f.messages.filter((message) => message.type === "edit").at(-1)?.markdown,
    ).toBe("Hello ");
    f.ack();
    expect(f.key("Tab").defaultPrevented).toBe(true);
    expect(
      f.messages.filter((message) => message.type === "edit").at(-1)?.markdown,
    ).toBe("Hello world");
  });

  it("allows paragraph and heading midline locations but rejects code and table positions", () => {
    const heading = setup("# Heading text");
    heading.app.view.dispatch(
      heading.app.view.state.tr.setSelection(
        TextSelection.create(heading.app.view.state.doc, 5),
      ),
    );
    heading.trigger();
    expect(heading.requests().length).toBe(0);
    vi.advanceTimersByTime(0);
    expect(heading.requests()[0]?.targetKind).toBe("heading");
  });

  it("uses a 300ms opt-in debounce, while manual requests still work when automatic suggestions are off", async () => {
    const f = setup("Hello", false);
    f.type("!");
    f.ack();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.requests()).toHaveLength(0);
    f.trigger();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.requests()).toHaveLength(1);
    const automatic = setup("Words", true);
    automatic.type("!");
    automatic.ack();
    await vi.advanceTimersByTimeAsync(AI_LIMITS.debounceMs - 1);
    expect(automatic.requests()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(automatic.requests()).toHaveLength(1);
  });

  it("rejects stale replies, ends rejected pending requests, and never captures IME Tab/Escape/229", async () => {
    const f = setup("Hello", true);
    f.type("!");
    f.ack();
    await vi.advanceTimersByTimeAsync(AI_LIMITS.debounceMs);
    const request = f.requests()[0]!;
    f.result(" late", request, { baseVersion: 99 });
    expect(f.root.querySelector(".mm-ai-suggestion")).toBeNull();
    expect(f.key("Tab", { isComposing: true }).defaultPrevented).toBe(false);
    expect(f.key("Escape", { keyCode: 229 }).defaultPrevented).toBe(false);
    f.app.view.dom.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    f.app.view.dom.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: "あ" }),
    );
    expect(f.key("Tab", { keyCode: 229 }).defaultPrevented).toBe(false);
  });

  it.each(["needs-sign-in", "excluded"] as const)(
    "drops a pending-only request after status becomes %s, even if ready returns",
    async (availability) => {
      const f = setup("Hello", false);
      f.trigger();
      await vi.advanceTimersByTimeAsync(0);
      const request = f.requests()[0]!;

      f.state({ availability, statusText: availability });
      f.result(" stale", request, { candidateId: "old-after-expiry" });
      expect(f.root.querySelector(".mm-ai-suggestion")).toBeNull();

      f.state({ availability: "ready", statusText: "Ready again" });
      f.result(" stale", request, { candidateId: "old-after-recovery" });
      expect(f.root.querySelector(".mm-ai-suggestion")).toBeNull();
      expect(f.key("Tab").defaultPrevented).toBe(false);
      expect(f.messages).not.toContainEqual(
        expect.objectContaining({
          type: "ai-suggestion-feedback",
          candidateId: "old-after-recovery",
          action: "shown",
        }),
      );
    },
  );

  it("connects host invalidation to the webview pending and late-result paths", async () => {
    const f = setup("Hello", false);
    const response = deferred<{ items: Array<{ insertText: string }> }>();
    const documentUri = "file:///prose.md";
    const status = {
      kind: "Normal" as const,
      busy: false,
      message: "Copilot ready",
    };
    let statusListener:
      | Parameters<NonNullable<AiSuggestionsEnvironment["statusChanged"]>>[0]
      | undefined;
    const server = {
      get currentStatus() {
        return status;
      },
      isRunning: true,
      start: vi.fn(async () => undefined),
      synchronizeDocument: vi.fn(async () => undefined),
      synchronizeAndFocusDocument: vi.fn(
        async (
          _uri: string,
          _version: number,
          _markdown: string,
          isCurrent: () => boolean,
        ) => isCurrent(),
      ),
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
      settings: () => ({ autoTrigger: false }),
      notify: vi.fn(),
      tokenSource: () => {
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
        } as never;
      },
      statusChanged: (listener) => {
        statusListener = listener;
        listener("ready", "Copilot ready", documentUri);
        return { dispose: vi.fn() };
      },
    };
    const host = new AiSuggestionsHost(environment);
    const panel: AiPanelSession = {
      id: "s1",
      documentId: () => documentUri,
      uri: () => documentUri,
      version: () => f.app.version,
      markdown: () => "Hello",
      isReady: () => true,
      isActive: () => true,
      canStartRequest: () => true,
      focus: vi.fn(),
      post: receive,
    };
    try {
      host.trustChanged();
      host.registerSession(panel);
      await host.triggerFromUserAction("s1");
      await vi.advanceTimersByTimeAsync(0);
      const request = f.requests()[0]!;
      expect(request).toBeDefined();
      const pending = host.requestSuggestion("s1", request);
      await vi.waitFor(() =>
        expect(server.requestInlineCompletion).toHaveBeenCalledTimes(1),
      );

      statusListener?.("needs-sign-in", "Sign in required", documentUri);
      await pending;
      response.resolve({ items: [{ insertText: " stale" }] });
      await Promise.resolve();
      await Promise.resolve();

      expect(f.root.querySelector(".mm-ai-suggestion")).toBeNull();
      expect(f.app.view.state.doc.textContent).toBe("Hello");
      expect(
        f.messages.some(
          (message) =>
            message.type === "ai-suggestion-feedback" &&
            message.action === "shown",
        ),
      ).toBe(false);
    } finally {
      host.dispose();
    }
  });

  it("cannot accept a displayed candidate after authentication expires", async () => {
    const f = setup("Hello", false);
    f.trigger();
    await vi.advanceTimersByTimeAsync(0);
    const request = f.requests()[0]!;
    const nativeDoc = f.app.view.state.doc;
    f.result(" stale", request, { candidateId: "candidate-before-expiry" });
    expect(f.root.querySelector(".mm-ai-suggestion")).not.toBeNull();

    f.state({ availability: "needs-sign-in", statusText: "Sign in required" });
    expect(f.root.querySelector(".mm-ai-suggestion")).toBeNull();
    expect(f.key("Tab").defaultPrevented).toBe(false);
    expect(f.app.view.state.doc).toBe(nativeDoc);

    f.state({ availability: "ready", statusText: "Ready again" });
    expect(f.root.querySelector(".mm-ai-suggestion")).toBeNull();
    expect(f.key("Tab").defaultPrevented).toBe(false);
    expect(f.app.view.state.doc).toBe(nativeDoc);
  });

  it("starts one debounced request after composing Japanese text without a candidate", async () => {
    const f = setup("Hello", true);
    f.app.view.dom.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    f.app.view.dom.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        inputType: "insertCompositionText",
        data: "あ",
      }),
    );
    f.app.view.dispatch(f.app.view.state.tr.insertText("あ"));
    f.app.view.dom.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: "あ" }),
    );
    f.ack();

    await vi.advanceTimersByTimeAsync(AI_LIMITS.debounceMs);
    expect(f.requests()).toHaveLength(1);
  });

  it("starts one request when the final composition transaction follows compositionend", async () => {
    const f = setup("Hello", true);
    f.app.view.dom.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    f.app.view.dom.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: "あ" }),
    );
    f.app.view.dom.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        inputType: "insertFromComposition",
        data: "あ",
      }),
    );
    f.app.view.dispatch(f.app.view.state.tr.insertText("あ"));
    f.ack();

    await vi.advanceTimersByTimeAsync(AI_LIMITS.debounceMs);
    expect(f.requests()).toHaveLength(1);
  });

  it("keeps a matching composition remainder without issuing a duplicate request", async () => {
    const f = setup("Hello", true);
    f.trigger();
    await vi.advanceTimersByTimeAsync(0);
    f.result(" あした");
    f.app.view.dom.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    f.app.view.dom.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        inputType: "insertCompositionText",
        data: " ",
      }),
    );
    f.app.view.dispatch(f.app.view.state.tr.insertText(" "));
    f.app.view.dom.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: " " }),
    );
    f.ack();

    await vi.advanceTimersByTimeAsync(AI_LIMITS.debounceMs * 2);
    expect(f.root.querySelector(".mm-ai-suggestion")?.textContent).toBe(
      "あした",
    );
    expect(f.requests()).toHaveLength(1);
  });

  it("discards a mismatched composition candidate and requests from the confirmed text", async () => {
    const f = setup("Hello", true);
    f.trigger();
    await vi.advanceTimersByTimeAsync(0);
    f.result(" world");
    f.app.view.dom.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    f.app.view.dom.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        inputType: "insertCompositionText",
        data: "あ",
      }),
    );
    f.app.view.dispatch(f.app.view.state.tr.insertText("あ"));
    f.app.view.dom.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: "あ" }),
    );
    f.ack();

    await vi.advanceTimersByTimeAsync(AI_LIMITS.debounceMs);
    expect(f.root.querySelector(".mm-ai-suggestion")).toBeNull();
    expect(f.requests()).toHaveLength(2);
    expect(f.requests()[1]?.baseVersion).toBe(f.app.version);
  });

  it("re-evaluates automatic suggestions after forward deletion with a stable cursor", async () => {
    const f = setup("Hello world", true);
    f.app.view.dispatch(
      f.app.view.state.tr.setSelection(
        TextSelection.create(f.app.view.state.doc, 6),
      ),
    );
    f.app.view.dom.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        inputType: "deleteContentForward",
      }),
    );
    f.app.view.dispatch(f.app.view.state.tr.delete(6, 7));
    f.ack();

    await vi.advanceTimersByTimeAsync(AI_LIMITS.debounceMs);
    expect(f.requests()).toHaveLength(1);
  });

  it("retries the latest eligible user input once the server becomes ready", async () => {
    const f = setup("Hello", true);
    f.state({ availability: "preparing" });
    f.type("!");
    f.ack();
    await vi.advanceTimersByTimeAsync(AI_LIMITS.debounceMs * 2);
    expect(f.requests()).toHaveLength(0);

    f.state({ availability: "ready" });
    await vi.advanceTimersByTimeAsync(AI_LIMITS.debounceMs);
    expect(f.requests()).toHaveLength(1);
  });

  it("keeps and accepts a manual candidate when automatic suggestions are turned off", async () => {
    const f = setup("Hello", true);
    f.trigger();
    await vi.advanceTimersByTimeAsync(0);
    f.result(" next");
    f.state({ autoTrigger: false, availability: "disabled" });

    expect(f.root.querySelector(".mm-ai-suggestion")?.textContent).toBe(
      " next",
    );
    expect(f.key("Tab").defaultPrevented).toBe(true);
    expect(
      f.messages.filter((message) => message.type === "edit").at(-1)?.markdown,
    ).toBe("Hello next");
  });

  it("still stops an automatic candidate when automatic suggestions are turned off", async () => {
    const f = setup("Hello", true);
    f.type("!");
    f.ack();
    await vi.advanceTimersByTimeAsync(AI_LIMITS.debounceMs);
    f.result(" next");
    expect(f.root.querySelector(".mm-ai-suggestion")).not.toBeNull();

    f.state({ autoTrigger: false, availability: "disabled" });
    expect(f.root.querySelector(".mm-ai-suggestion")).toBeNull();
  });

  it("tries later SDK alternatives when the first Markdown insertion is unsafe", async () => {
    const source = "hello world**";
    const f = setup(source, false);
    f.app.view.dispatch(
      f.app.view.state.tr.setSelection(
        TextSelection.create(f.app.view.state.doc, 7),
      ),
    );
    f.trigger();
    await vi.advanceTimersByTimeAsync(0);
    const request = f.requests()[0]!;
    f.result("**", request, {
      candidateId: "unsafe-item",
      candidates: [
        { candidateId: "unsafe-item", text: "**", partialAcceptanceOffset: 0 },
        { candidateId: "safe-item", text: "nice ", partialAcceptanceOffset: 0 },
      ],
    });

    expect(f.root.querySelector(".mm-ai-suggestion")?.textContent).toBe(
      "nice ",
    );
    expect(
      f.messages.filter((message) => message.type === "ai-suggestion-feedback"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidateId: "unsafe-item",
          action: "rejected",
          rejectionReason: "unsafe-suggestion",
        }),
        expect.objectContaining({ candidateId: "safe-item", action: "shown" }),
      ]),
    );
    expect(f.requests()).toHaveLength(1);
  });

  it("rejects all unsafe alternatives without displaying a candidate", async () => {
    const f = setup("hello world**", false);
    f.app.view.dispatch(
      f.app.view.state.tr.setSelection(
        TextSelection.create(f.app.view.state.doc, 7),
      ),
    );
    f.trigger();
    await vi.advanceTimersByTimeAsync(0);
    const request = f.requests()[0]!;
    f.result("**", request, {
      candidateId: "unsafe-item-1",
      candidates: [
        { candidateId: "unsafe-item-1", text: "**" },
        { candidateId: "unsafe-item-2", text: "***" },
      ],
    });

    expect(f.root.querySelector(".mm-ai-suggestion")).toBeNull();
    expect(
      f.root.querySelector<HTMLElement>(".mm-ai-status")?.textContent,
    ).toMatch(/safely inserted without changing existing Markdown/i);
    expect(
      f.messages.filter(
        (message) =>
          message.type === "ai-suggestion-feedback" &&
          message.action === "rejected",
      ),
    ).toHaveLength(2);
    expect(f.requests()).toHaveLength(1);
  });

  it("does not display any alternative after the document version changes", async () => {
    const f = setup("hello world**", false);
    f.app.view.dispatch(
      f.app.view.state.tr.setSelection(
        TextSelection.create(f.app.view.state.doc, 7),
      ),
    );
    f.trigger();
    await vi.advanceTimersByTimeAsync(0);
    const request = f.requests()[0]!;
    f.app.version += 1;
    f.result("nice ", request, {
      candidateId: "stale-item-1",
      candidates: [
        { candidateId: "stale-item-1", text: "nice " },
        { candidateId: "stale-item-2", text: "safe " },
      ],
    });

    expect(f.root.querySelector(".mm-ai-suggestion")).toBeNull();
    expect(f.messages).not.toContainEqual(
      expect.objectContaining({
        type: "ai-suggestion-feedback",
        action: "shown",
      }),
    );
  });

  it("shows manual no-suggestion feedback outside the visually hidden live region", async () => {
    const f = setup("Hello", false);
    f.trigger();
    await vi.advanceTimersByTimeAsync(0);
    const request = f.requests()[0]!;
    f.result("", request, { reason: "no-suggestion", candidateId: undefined });

    const status = f.root.querySelector<HTMLElement>(".mm-ai-status");
    expect(status).not.toBeNull();
    expect(status?.hidden).toBe(false);
    expect(status?.textContent).toMatch(/did not return a suggestion/i);
    expect(status?.title).toBe(status?.textContent);
    expect(f.root.querySelector(".mm-ai-announcement")?.textContent).toMatch(
      /did not return a suggestion/i,
    );
  });
});
