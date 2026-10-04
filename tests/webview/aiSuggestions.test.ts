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
  createEditorApp,
  type MarkdownEditorApp,
} from "../../src/webview/editor";

const apps: MarkdownEditorApp[] = [];

vi.mock("vscode", () => ({
  window: { showInformationMessage: vi.fn(async () => undefined) },
  LanguageModelChatMessage: {
    User: (content: string) => ({ role: 1, content }),
  },
  env: { clipboard: { writeText: vi.fn() }, openExternal: vi.fn() },
  Uri: { parse: (value: string) => ({ toString: () => value }) },
  workspace: { isTrusted: true },
}));

function receive(data: unknown): void {
  window.dispatchEvent(new MessageEvent("message", { data }));
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
      invocationId: "manual-invocation",
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

  it("reacquires after restart only from a debounced real text edit and preserves that request through consent status", async () => {
    const f = setup("Hello", true);
    f.state({
      availability: "needs-authorization",
      autoRestoreOnInput: true,
      statusText: "Type to re-check access",
    });
    f.type("!");
    f.ack();
    await vi.advanceTimersByTimeAsync(AI_LIMITS.debounceMs - 1);
    expect(f.requests()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    const request = f.requests()[0];
    expect(request).toMatchObject({
      trigger: "auto",
      afterUserInput: true,
    });
    f.state({
      availability: "preparing",
      autoRestoreOnInput: true,
      statusText: "Checking access",
    });
    f.state({
      availability: "ready",
      autoRestoreOnInput: true,
      statusText: "Ready",
    });
    f.result(" continues safely", request);
    expect(f.root.querySelector(".mm-ai-suggestion")?.textContent).toBe(
      " continues safely",
    );
  });

  it("suspends the normal request deadline while model selection waits for consent", async () => {
    const f = setup("Hello", true);
    f.state({
      availability: "needs-authorization",
      autoRestoreOnInput: true,
    });
    f.type("!");
    f.ack();
    await vi.advanceTimersByTimeAsync(AI_LIMITS.debounceMs);
    const request = f.requests()[0]!;
    f.state({
      availability: "preparing",
      autoRestoreOnInput: true,
    });

    f.app.view.dom.blur();
    await vi.advanceTimersByTimeAsync(AI_LIMITS.deadlineMs * 2);
    expect(
      f.messages.some((message) => message.type === "ai-suggestion-cancel"),
    ).toBe(false);

    f.app.view.focus();
    f.state({
      availability: "ready",
      autoRestoreOnInput: true,
    });
    await vi.advanceTimersByTimeAsync(AI_LIMITS.deadlineMs - 1);
    expect(
      f.messages.some((message) => message.type === "ai-suggestion-cancel"),
    ).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(
      f.messages.some((message) => message.type === "ai-suggestion-cancel"),
    ).toBe(true);
    expect(request.afterUserInput).toBe(true);
  });

  it("cancels a consent-wait request when the caret moves to a different snapshot", async () => {
    const f = setup("Hello", true);
    f.state({
      availability: "needs-authorization",
      autoRestoreOnInput: true,
    });
    f.type("!");
    f.ack();
    await vi.advanceTimersByTimeAsync(AI_LIMITS.debounceMs);
    f.state({
      availability: "preparing",
      autoRestoreOnInput: true,
    });

    f.app.view.dispatch(
      f.app.view.state.tr.setSelection(
        TextSelection.create(f.app.view.state.doc, 2),
      ),
    );
    expect(
      f.messages.some((message) => message.type === "ai-suggestion-cancel"),
    ).toBe(true);
  });

  it("answers the post-consent snapshot check from the current webview identity", async () => {
    const f = setup("Hello", true);
    f.state({
      availability: "needs-authorization",
      autoRestoreOnInput: true,
    });
    f.type("!");
    f.ack();
    await vi.advanceTimersByTimeAsync(AI_LIMITS.debounceMs);
    const request = f.requests()[0]!;
    const check = {
      protocolVersion: 1,
      type: "ai-suggestion-snapshot-check",
      requestId: request.requestId,
      sessionId: request.sessionId,
    };

    receive(check);
    expect(f.messages.at(-1)).toMatchObject({
      type: "ai-suggestion-snapshot-validation",
      requestId: request.requestId,
      sessionId: request.sessionId,
      current: true,
    });

    f.app.view.dispatch(
      f.app.view.state.tr.setSelection(
        TextSelection.create(f.app.view.state.doc, 2),
      ),
    );
    receive(check);
    expect(f.messages.at(-1)).toMatchObject({
      type: "ai-suggestion-snapshot-validation",
      requestId: request.requestId,
      sessionId: request.sessionId,
      current: false,
    });
  });

  it("does not use cursor movement alone to reacquire authorization after restart", async () => {
    const f = setup("Hello", true);
    f.state({
      availability: "needs-authorization",
      autoRestoreOnInput: true,
    });
    f.app.view.dispatch(
      f.app.view.state.tr.setSelection(
        TextSelection.create(f.app.view.state.doc, 2),
      ),
    );
    await vi.advanceTimersByTimeAsync(AI_LIMITS.debounceMs);
    expect(f.requests()).toHaveLength(0);
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

  it.each(["needs-authorization", "no-model"] as const)(
    "drops a pending-only request after status becomes %s, even if ready returns",
    async (availability) => {
      const f = setup("Hello", false);
      f.trigger();
      await vi.advanceTimersByTimeAsync(0);
      const request = f.requests()[0]!;

      f.state({ availability, statusText: availability });
      f.result(" stale", request);
      expect(f.root.querySelector(".mm-ai-suggestion")).toBeNull();

      f.state({ availability: "ready", statusText: "Ready again" });
      f.result(" stale", request);
      expect(f.root.querySelector(".mm-ai-suggestion")).toBeNull();
      expect(f.key("Tab").defaultPrevented).toBe(false);
      expect(f.root.querySelector(".mm-ai-suggestion")).toBeNull();
    },
  );

  it("cannot accept a displayed candidate after model authorization expires", async () => {
    const f = setup("Hello", false);
    f.trigger();
    await vi.advanceTimersByTimeAsync(0);
    const request = f.requests()[0]!;
    const nativeDoc = f.app.view.state.doc;
    f.result(" stale", request);
    expect(f.root.querySelector(".mm-ai-suggestion")).not.toBeNull();

    f.state({
      availability: "needs-authorization",
      statusText: "Authorization required",
    });
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

  it("validates the single language-model insertion against the Markdown source", async () => {
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
    f.result("nice ", request);

    expect(f.root.querySelector(".mm-ai-suggestion")?.textContent).toBe(
      "nice ",
    );
    expect(f.requests()).toHaveLength(1);
  });

  it("rejects an unsafe insertion without displaying a candidate", async () => {
    const f = setup("hello world**", false);
    f.app.view.dispatch(
      f.app.view.state.tr.setSelection(
        TextSelection.create(f.app.view.state.doc, 7),
      ),
    );
    f.trigger();
    await vi.advanceTimersByTimeAsync(0);
    const request = f.requests()[0]!;
    f.result("**", request);

    expect(f.root.querySelector(".mm-ai-suggestion")).toBeNull();
    expect(
      f.root.querySelector<HTMLElement>(".mm-ai-status")?.textContent,
    ).toMatch(/safely inserted without changing existing Markdown/i);
    expect(f.requests()).toHaveLength(1);
  });

  it("does not display a result after the document version changes", async () => {
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
    f.result("nice ", request);

    expect(f.root.querySelector(".mm-ai-suggestion")).toBeNull();
  });

  it("shows manual no-suggestion feedback outside the visually hidden live region", async () => {
    const f = setup("Hello", false);
    f.trigger();
    await vi.advanceTimersByTimeAsync(0);
    const request = f.requests()[0]!;
    f.result("", request, { reason: "no-suggestion" });

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
