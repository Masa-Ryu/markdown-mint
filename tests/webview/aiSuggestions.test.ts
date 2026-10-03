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
      postMessage: (message) => {
        messages.push(message as Record<string, unknown>);
      },
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
      modelName: "Copilot",
      ...patch,
    });
  state();
  const trigger = () =>
    receive({
      protocolVersion: 1,
      type: "ai-suggestion-trigger",
      sessionId: "s1",
      settingsGeneration: 1,
      invocationId: "c1",
    });
  const requests = () =>
    messages.filter(
      (message) => message.type === "ai-suggestion-request",
    ) as unknown as AiSuggestionRequest[];
  const result = (text = " next🌿", request = requests().at(-1)!, patch = {}) =>
    receive({
      ...request,
      type: "ai-suggestion-result",
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
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  for (const app of apps.splice(0)) app.destroy();
  document.body.replaceChildren();
  vi.useRealTimers();
});
describe("AI ghost integration", () => {
  it("preserves the current input generation through dirty-only echoes and implicit acknowledgements", async () => {
    const f = setup("Hello", true);
    f.type("!");
    const edit = f.messages
      .filter((message) => message.type === "edit")
      .at(-1)!;
    receive({
      protocolVersion: 1,
      type: "document",
      markdown: edit.markdown,
      version: 2,
      profile: "github",
      documentId: "file:///prose.md",
      reason: "external",
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.requests()).toHaveLength(1);
    f.result();
    receive({
      protocolVersion: 1,
      type: "document",
      markdown: edit.markdown,
      version: 2,
      profile: "github",
      documentId: "file:///prose.md",
      reason: "external",
    });
    expect(f.root.querySelector(".mm-ai-suggestion")).not.toBeNull();
    receive({
      protocolVersion: 1,
      type: "document",
      markdown: edit.markdown,
      version: 3,
      profile: "github",
      documentId: "file:///prose.md",
      reason: "external",
    });
    expect(f.root.querySelector(".mm-ai-suggestion")).toBeNull();
  });
  it("invalidates on host panel deactivation even when the iframe does not report blur", async () => {
    const f = setup();
    f.trigger();
    await vi.advanceTimersByTimeAsync(0);
    const request = f.requests()[0]!;
    f.result();
    f.state({ active: false });
    f.state({ active: true });
    f.result(" late", request);
    expect(f.root.querySelector(".mm-ai-suggestion")).toBeNull();
  });
  it("keeps a successful manual candidate when access-information API is unavailable", async () => {
    const f = setup();
    f.state({ availability: "needs-authorization" });
    f.trigger();
    await vi.advanceTimersByTimeAsync(0);
    f.result();
    f.state({ availability: "needs-authorization" });
    expect(f.root.querySelector(".mm-ai-suggestion")).not.toBeNull();
    expect(f.key("Tab").defaultPrevented).toBe(true);
  });
  it("displays/dismisses a literal decoration without edits, serialization, dirty state, or recovery writes", async () => {
    const f = setup();
    f.trigger();
    await vi.advanceTimersByTimeAsync(0);
    const before = f.app.view.state.doc;
    const writes = f.setState.mock.calls.length;
    f.result(" **literal**🌿");
    expect(f.root.querySelector(".mm-ai-suggestion")?.textContent).toBe(
      " **literal**🌿",
    );
    expect(
      f.root
        .querySelector(".mm-ai-suggestion")
        ?.getAttribute("contenteditable"),
    ).toBe("false");
    expect(f.app.view.state.doc).toBe(before);
    expect(f.app.sync.hasPending).toBe(false);
    expect(f.messages.some((message) => message.type === "edit")).toBe(false);
    expect(f.setState.mock.calls.length).toBe(writes);
    expect(
      f.root.querySelector('.mm-ai-announcement[aria-live="polite"]')
        ?.textContent,
    ).toContain("Press Tab");
    expect(f.key("Escape").defaultPrevented).toBe(true);
    expect(f.root.querySelector(".mm-ai-suggestion")).toBeNull();
    expect(f.app.view.state.doc).toBe(before);
  });
  it("accepts with Tab as a standalone normal edit, retains formatting, and does not trigger another automatic request", async () => {
    const f = setup("**Hello**", true);
    f.trigger();
    await vi.advanceTimersByTimeAsync(0);
    f.result();
    expect(f.key("Tab").defaultPrevented).toBe(true);
    const edit = f.messages.filter((message) => message.type === "edit");
    expect(edit).toHaveLength(1);
    expect(edit[0]?.markdown).toContain("**Hello next🌿**");
    expect(
      f.app.view.state.doc.lastChild?.lastChild?.marks.map(
        (mark) => mark.type.name,
      ),
    ).toContain("strong");
    expect(f.root.querySelector(".mm-ai-suggestion")).toBeNull();
    f.ack();
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.requests()).toHaveLength(1);
    f.key("z", { ctrlKey: true });
    expect(f.messages.some((message) => message.type === "undo")).toBe(true);
  });
  it("preserves the original Tab/Shift+Tab/Escape handling when no candidate exists", () => {
    const f = setup();
    expect(f.key("Tab").defaultPrevented).toBe(false);
    expect(f.key("Tab", { shiftKey: true }).defaultPrevented).toBe(false);
    expect(f.key("Escape").defaultPrevented).toBe(false);
  });
  it("debounces ordinary input, stays off by default, and ignores paste/programmatic edits", async () => {
    const f = setup();
    f.type("a");
    f.ack();
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.requests()).toHaveLength(0);
    f.state({ autoTrigger: true });
    f.type("b");
    f.ack();
    await vi.advanceTimersByTimeAsync(AI_LIMITS.debounceMs - 1);
    expect(f.requests()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.requests()).toHaveLength(1);
    f.result("", f.requests()[0]!, { reason: "no-suggestion" });
    f.app.view.dispatch(f.app.view.state.tr.insertText("programmatic"));
    f.ack();
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.requests()).toHaveLength(1);
    f.type("paste", "insertFromPaste");
    f.ack();
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.requests()).toHaveLength(1);
  });
  it("waits for host synchronization using the same input generation and the acknowledged version", async () => {
    const f = setup("Hello", true);
    f.type("!");
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.requests()).toHaveLength(0);
    f.ack();
    expect(f.requests()).toHaveLength(1);
    expect(f.requests()[0]?.baseVersion).toBe(2);
    expect(f.requests()[0]?.context.before).toBe("Hello!");
  });
  it("rechecks a host cooldown only after new input without retrying on its own", async () => {
    const f = setup("Hello", true);
    f.state({ availability: "blocked" });
    f.type("!");
    f.ack();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.requests()).toHaveLength(1);
    f.result("", f.requests()[0]!, { reason: "blocked" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.requests()).toHaveLength(1);
    f.type("a");
    f.ack();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.requests()).toHaveLength(2);
  });
  it("resnapshots after manual focus restoration and waits for unsynced input even when auto is off", async () => {
    const f = setup();
    f.type("!");
    const button = f.root.querySelector<HTMLButtonElement>("button")!;
    button.focus();
    f.trigger();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.requests()).toHaveLength(0);
    f.ack();
    expect(f.requests()[0]?.context.before).toBe("Hello!");
    expect(document.activeElement).toBe(f.app.view.dom);
  });
  it("suppresses a dismissed/empty/failed context until another real input", async () => {
    const f = setup("Hello", true);
    f.type("!");
    f.ack();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.key("Escape").defaultPrevented).toBe(true);
    f.result();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.requests()).toHaveLength(1);
    expect(f.root.querySelector(".mm-ai-suggestion")).toBeNull();
    f.type("a");
    f.ack();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.requests()).toHaveLength(2);
  });
  it.each([
    "cursor",
    "external",
    "focus",
    "model",
    "auto-off",
    "source",
    "destroy",
  ])("rejects a late candidate after %s", async (change) => {
    const f = setup("Hello", true);
    f.trigger();
    await vi.advanceTimersByTimeAsync(0);
    const request = f.requests()[0]!;
    if (change === "cursor") {
      f.app.view.dispatch(
        f.app.view.state.tr.setSelection(
          TextSelection.create(f.app.view.state.doc, 1),
        ),
      );
      f.app.view.dispatch(
        f.app.view.state.tr.setSelection(
          TextSelection.create(f.app.view.state.doc, 6),
        ),
      );
    }
    if (change === "external")
      receive({
        protocolVersion: 1,
        type: "document",
        markdown: "Changed",
        version: 2,
        profile: "github",
        reason: "external",
        documentId: "file:///prose.md",
      });
    if (change === "focus")
      f.root.querySelector<HTMLButtonElement>("button")!.focus();
    if (change === "model") f.state({ settingsGeneration: 2 });
    if (change === "auto-off") {
      // A manual request is preserved when only auto is disabled.
      f.state({ autoTrigger: false });
      f.result(" next", request);
      expect(f.root.querySelector(".mm-ai-suggestion")?.textContent).toBe(
        " next",
      );
      return;
    }
    if (change === "source")
      f.root.querySelector<HTMLButtonElement>('[data-mode="source"]')!.click();
    if (change === "destroy") {
      f.app.destroy();
      apps.splice(apps.indexOf(f.app), 1);
    }
    f.result(" next", request);
    expect(f.root.querySelector(".mm-ai-suggestion")).toBeNull();
  });
  it("cancels automatic candidates when off and rejects mismatched result identities", async () => {
    const f = setup("Hello", true);
    f.type("!");
    f.ack();
    await vi.advanceTimersByTimeAsync(1000);
    f.result(" next", f.requests()[0]!, { baseVersion: 99 });
    expect(f.root.querySelector(".mm-ai-suggestion")).toBeNull();
    f.result();
    expect(f.root.querySelector(".mm-ai-suggestion")).not.toBeNull();
    f.state({ autoTrigger: false });
    expect(f.root.querySelector(".mm-ai-suggestion")).toBeNull();
  });
  it("gives IME Tab/Escape/229 priority and starts debounce again after composition commits", async () => {
    const f = setup("Hello", true);
    f.trigger();
    await vi.advanceTimersByTimeAsync(0);
    f.result();
    expect(f.key("Tab", { isComposing: true }).defaultPrevented).toBe(false);
    expect(f.key("Escape", { keyCode: 229 }).defaultPrevented).toBe(false);
    f.app.view.dom.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    expect(f.root.querySelector(".mm-ai-suggestion")).toBeNull();
    f.type("日本語", "insertCompositionText");
    f.ack();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.requests()).toHaveLength(1);
    f.app.view.dom.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: "日本語" }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.requests()).toHaveLength(2);
  });
});
