import { afterEach, describe, expect, it } from "vitest";
import {
  parseMarkdown,
  renderMarkdown,
  schema,
  serializeMarkdown,
} from "../../src/core";
import {
  createEditorApp,
  type MarkdownEditorApp,
  type VSCodeApiLike,
} from "../../src/webview/editor";

const apps: MarkdownEditorApp[] = [];
const initial = "Before\n\n> [!NOTE]\n> body\n\nAfter";
function setup() {
  const root = document.createElement("div");
  document.body.append(root);
  const messages: Array<{
    type?: string;
    operationId?: string;
    markdown?: string;
  }> = [];
  let recovery: { recoveryDraft?: string } | undefined;
  const api: VSCodeApiLike = {
    postMessage: (message) =>
      messages.push(message as (typeof messages)[number]),
    getState: () => recovery,
    setState: (state) => {
      recovery = state as typeof recovery;
    },
  };
  const app = createEditorApp({
    root,
    vscode: api,
    core: { schema, parseMarkdown, serializeMarkdown, renderMarkdown },
    initialDocument: { markdown: initial, version: 1, profile: "github" },
  });
  apps.push(app);
  const body = root.querySelector<HTMLTextAreaElement>(
    ".mm-alert-body-editor",
  )!;
  body.focus();
  const edits = () => messages.filter((message) => message.type === "edit");
  const input = (value: string) => {
    body.value = value;
    body.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText" }),
    );
  };
  const reject = (currentMarkdown = "authoritative external") =>
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          protocolVersion: 1,
          type: "edit-rejected",
          operationId: edits()[0]!.operationId,
          reason: "stale",
          message: "External change",
          currentMarkdown,
          currentVersion: 2,
          draftMarkdown: edits()[0]!.markdown,
        },
      }),
    );
  return {
    app,
    body,
    input,
    reject,
    edits,
    recovery: () => recovery?.recoveryDraft,
    source: () => serializeMarkdown(app.view.state.doc, parseMarkdown(initial)),
  };
}
afterEach(() => {
  apps.splice(0).forEach((app) => app.destroy());
  document.body.replaceChildren();
});

describe("Alert conflict input preservation", () => {
  it("locks a focused Alert synchronously on edit rejection and retains the latest queued input", () => {
    const { body, input, reject, edits, recovery, source } = setup();
    input("first sent");
    input("second queued");
    const before = source();
    reject();
    expect(body.readOnly).toBe(true);
    expect(body.disabled).toBe(false);
    expect(document.activeElement).toBe(body);
    expect(body.value).toBe("second queued");
    expect(recovery()).toBe(before);
    expect(edits()).toHaveLength(1);
  });

  it("flushes native text already accepted before its input event into recovery when locking", () => {
    const { body, input, reject, edits, recovery, source } = setup();
    input("sent");
    // A DOM mutation is already visible, but its input notification is pending.
    body.value = "accepted before rejection";
    reject();
    expect(body.readOnly).toBe(true);
    expect(source()).toBe(
      initial.replace("> body", "> accepted before rejection"),
    );
    expect(recovery()).toBe(source());
    expect(edits()).toHaveLength(1);
  });

  it("rebases independent changes with native Alert text accepted before its input event", () => {
    const { app, body, input, reject, edits, recovery, source } = setup();
    input("sent");
    body.value = "accepted before rebase";
    reject(initial.replace("Before", "Remote before"));
    const expected = initial
      .replace("Before", "Remote before")
      .replace("> body", "> accepted before rebase");
    expect(source()).toBe(expected);
    expect(recovery()).toBe(expected);
    expect(edits()).toHaveLength(2);
    expect(edits()[1]!.markdown).toBe(expected);
    const currentBody = app.view.dom.querySelector<HTMLTextAreaElement>(
      ".mm-alert-body-editor",
    )!;
    expect(currentBody.value).toBe("accepted before rebase");
    expect(currentBody.readOnly).toBe(false);
  });

  it("waits for final IME input before rebasing an independent rejected edit", async () => {
    const { app, body, input, reject, edits, recovery, source } = setup();
    input("sent");
    body.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    body.value = "変換途中";
    reject(initial.replace("Before", "Remote before"));
    expect(body.readOnly).toBe(true);
    expect(recovery()).toContain("変換途中");
    expect(edits()).toHaveLength(1);
    body.value = "変換確定";
    body.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true }),
    );
    await Promise.resolve();
    input("変換確定の最終入力");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const expected = initial
      .replace("Before", "Remote before")
      .replace("> body", "> 変換確定の最終入力");
    expect(source()).toBe(expected);
    expect(recovery()).toBe(expected);
    expect(edits()).toHaveLength(2);
    expect(edits()[1]!.markdown).toBe(expected);
    expect(
      app.view.dom.querySelector<HTMLTextAreaElement>(".mm-alert-body-editor")!
        .readOnly,
    ).toBe(false);
  });

  it("keeps composition input through an ACK before merging a pending external snapshot", async () => {
    const { app, body, input, edits, recovery, source } = setup();
    input("sent");
    const sent = edits()[0]!;
    body.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    body.value = "変換途中";
    app.receiveDocument({
      protocolVersion: 1,
      type: "document",
      markdown: initial.replace("Before", "Remote before"),
      version: 3,
      profile: "github",
      reason: "external",
    });
    app.receiveDocument({
      protocolVersion: 1,
      type: "document",
      markdown: sent.markdown!,
      version: 2,
      profile: "github",
      operationId: sent.operationId!,
      reason: "ack",
    });
    expect(body.readOnly).toBe(true);
    expect(edits()).toHaveLength(1);
    body.value = "変換確定";
    body.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true }),
    );
    await Promise.resolve();
    input("変換確定の最終入力");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const expected = initial
      .replace("Before", "Remote before")
      .replace("> body", "> 変換確定の最終入力");
    expect(source()).toBe(expected);
    expect(recovery()).toBe(expected);
    expect(edits()).toHaveLength(2);
    expect(edits()[1]!.markdown).toBe(expected);
  });

  it("retains compositionend and a later final input after rejection without submitting either", async () => {
    const { app, body, input, reject, edits, recovery, source } = setup();
    input("sent");
    body.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    body.value = "変換途中";
    reject();
    expect(body.readOnly).toBe(true);
    expect(recovery()).toContain("変換途中");
    body.value = "変換確定";
    body.dispatchEvent(
      new CompositionEvent("compositionend", {
        bubbles: true,
        data: "変換確定",
      }),
    );
    await Promise.resolve();
    input("変換確定の最終入力");
    await Promise.resolve();
    expect(source()).toBe(initial.replace("> body", "> 変換確定の最終入力"));
    expect(recovery()).toBe(source());
    expect(edits()).toHaveLength(1);
    expect(body.readOnly).toBe(true);
    app.receiveDocument({
      protocolVersion: 1,
      type: "document",
      markdown: "later external",
      version: 3,
      profile: "github",
      reason: "external",
    });
    expect(recovery()).toBe(source());
    expect(source()).toContain("変換確定の最終入力");
  });

  it("also locks and flushes the focused Alert when a dirty document receives an external snapshot", () => {
    const { app, body, input, edits, recovery, source } = setup();
    input("sent");
    body.value = "latest native text";
    app.receiveDocument({
      protocolVersion: 1,
      type: "document",
      markdown: "external",
      version: 2,
      profile: "github",
      reason: "external",
    });
    expect(body.readOnly).toBe(true);
    expect(recovery()).toBe(source());
    expect(recovery()).toContain("latest native text");
    expect(edits()).toHaveLength(1);
  });
});
