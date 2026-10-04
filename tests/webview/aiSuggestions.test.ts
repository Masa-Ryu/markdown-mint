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
});
