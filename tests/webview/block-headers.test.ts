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
} from "../../src/webview/editor";
import { blockSourceEditor } from "../../src/webview/blockSourceEditing";

const apps: MarkdownEditorApp[] = [];
function setup(source: string) {
  const root = document.createElement("div");
  document.body.append(root);
  const messages: unknown[] = [];
  const app = createEditorApp({
    root,
    vscode: { postMessage: (message) => messages.push(message) },
    core: { schema, parseMarkdown, renderMarkdown, serializeMarkdown },
    initialDocument: { markdown: source, profile: "github", version: 1 },
  });
  apps.push(app);
  return { root, app, messages };
}
afterEach(() => {
  apps.splice(0).forEach((app) => app.destroy());
  document.body.replaceChildren();
});

describe("block header actions", () => {
  it("does not commit a language with an unflagged composition Enter and preserves a deleted language draft", () => {
    const { root, app, messages } = setup("```ts\ncode\n```");
    root.querySelector<HTMLButtonElement>(".mm-code-language-trigger")!.click();
    const input = root.querySelector<HTMLInputElement>(
      ".mm-code-language-inline",
    )!;
    input.value = "typescript";
    input.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    input.dispatchEvent(new Event("compositionend", { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(
      messages.filter(
        (message) => (message as { type: string }).type === "edit",
      ),
    ).toHaveLength(0);
    app.receiveDocument({
      protocolVersion: 1,
      type: "document",
      markdown: "external replacement",
      version: 2,
      profile: "github",
      reason: "external",
    });
    expect(
      root.querySelector<HTMLTextAreaElement>(
        ".mm-block-draft-dialog textarea",
      )!.value,
    ).toBe("typescript");
    expect(serializeMarkdown(app.view.state.doc)).toBe("external replacement");
  });
  it("changes Alert type after directly typing its body", () => {
    const { root, app } = setup("> [!NOTE]\n> before");
    const body = root.querySelector<HTMLTextAreaElement>(
      ".mm-alert-body-editor",
    )!;
    body.value = "typed body";
    body.dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector<HTMLButtonElement>(".mm-alert-type-trigger")!.click();
    const select = root.querySelector<HTMLSelectElement>(
      ".mm-alert-type-select",
    )!;
    select.value = "TIP";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(serializeMarkdown(app.view.state.doc)).toBe(
      "> [!TIP]\n> typed body",
    );
  });

  it.each([
    "```mermaid\n```",
    "~~~math\n~~~",
    "$$\r\nx +\r\ny\r\n$$",
    "```mermaid\r\ngraph TD\r\nA-->B\r\n```",
  ])(
    "opens and cancels/commits unchanged empty or CRLF source: %s",
    (source) => {
      const { root, messages, app } = setup(source);
      root
        .querySelector<HTMLButtonElement>(".mm-block-source-trigger")!
        .click();
      root
        .querySelector<HTMLButtonElement>(
          ".mm-profile-feature-dialog button[type=submit]",
        )!
        .click();
      expect(serializeMarkdown(app.view.state.doc, parseMarkdown(source))).toBe(
        source,
      );
      expect(
        messages.filter(
          (message) => (message as { type: string }).type === "edit",
        ),
      ).toHaveLength(0);
    },
  );

  it.each(["preview", "readonly"])(
    "preserves an open source draft when %s is imposed",
    (mode) => {
      const { root, app } = setup("$$\nx\n$$");
      root
        .querySelector<HTMLButtonElement>(".mm-block-source-trigger")!
        .click();
      const input = root.querySelector<HTMLTextAreaElement>(
        "[data-feature-field=body]",
      )!;
      input.value = "preserve me";
      if (mode === "preview")
        app.receiveDocument({
          protocolVersion: 1,
          type: "document",
          markdown: "$$\nx\n$$",
          profile: "github",
          version: 2,
          reason: "external",
          mode: "preview",
        });
      else app.view.setProps({ editable: () => false });
      root
        .querySelector<HTMLButtonElement>(
          ".mm-profile-feature-dialog button[type=submit]",
        )!
        .click();
      expect(
        root.querySelector(".mm-profile-feature-dialog[open]"),
      ).not.toBeNull();
      expect(input.value).toBe("preserve me");
      expect(serializeMarkdown(app.view.state.doc)).toBe("$$\nx\n$$");
    },
  );

  it("keeps Alert selection gestures independent and changes only its marker", () => {
    const source = "> [!NOTE]\n> first  \nlazy continuation\n> last";
    const { root, app, messages } = setup(source);
    const body = root.querySelector<HTMLTextAreaElement>(
      ".mm-alert-body-editor",
    )!;
    body.focus();
    body.setSelectionRange(2, 9, "backward");
    for (const type of ["click", "dblclick", "mousedown", "mouseup"])
      body.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    expect(root.querySelector("dialog[open]")).toBeNull();
    root.querySelector<HTMLButtonElement>(".mm-alert-type-trigger")!.click();
    const select = root.querySelector<HTMLSelectElement>(
      ".mm-alert-type-select",
    )!;
    select.value = "WARNING";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(serializeMarkdown(app.view.state.doc)).toBe(
      source.replace("[!NOTE]", "[!WARNING]"),
    );
    expect(document.activeElement).toBe(body);
    expect([
      body.selectionStart,
      body.selectionEnd,
      body.selectionDirection,
    ]).toEqual([2, 9, "backward"]);
    expect(
      messages.filter(
        (message) => (message as { type: string }).type === "edit",
      ),
    ).toHaveLength(1);
  });

  it.each([
    "$$\nx + y\n$$",
    "```mermaid title=diagram\ngraph TD\n A-->B\n```",
    "~~~math\nx + y\n~~~",
  ])(
    "edits the existing rendered source and preserves its wrapper: %s",
    (source) => {
      const { root, app, messages } = setup(source);
      root
        .querySelector<HTMLButtonElement>(".mm-block-source-trigger")!
        .click();
      const dialog = root.querySelector<HTMLDialogElement>(
        ".mm-profile-feature-dialog",
      )!;
      expect(dialog.dataset.profileFeatureMode).toBe("edit");
      const input = dialog.querySelector<HTMLTextAreaElement>(
        "[data-feature-field=body]",
      )!;
      const original = input.value;
      dialog.querySelector<HTMLButtonElement>("button[type=submit]")!.click();
      expect(serializeMarkdown(app.view.state.doc)).toBe(source);
      expect(
        messages.filter(
          (message) => (message as { type: string }).type === "edit",
        ),
      ).toHaveLength(0);
      root
        .querySelector<HTMLButtonElement>(".mm-block-source-trigger")!
        .click();
      input.value = original + "  ";
      dialog.querySelector<HTMLButtonElement>("button[type=submit]")!.click();
      expect(app.view.state.doc.childCount).toBe(1);
      expect(serializeMarkdown(app.view.state.doc)).toBe(
        source.replace(original, original + "  "),
      );
    },
  );

  it("maps an existing source edit past earlier changes without matching identical blocks", () => {
    const { root, app } = setup("before\n\n$$\nx\n$$\n\n$$\nx\n$$");
    root
      .querySelectorAll<HTMLButtonElement>(".mm-block-source-trigger")[1]!
      .click();
    app.view.dispatch(app.view.state.tr.insertText("moved ", 1));
    const input = root.querySelector<HTMLTextAreaElement>(
      "[data-feature-field=body]",
    )!;
    input.value = "changed";
    root
      .querySelector<HTMLButtonElement>(
        ".mm-profile-feature-dialog button[type=submit]",
      )!
      .click();
    expect(serializeMarkdown(app.view.state.doc)).toBe(
      "moved before\n\n$$\nx\n$$\n\n$$\nchanged\n$$",
    );
  });

  it("keeps a rendered source draft visible after the edited node is removed", () => {
    const { root, app } = setup("before\n\n$$\nx\n$$");
    root.querySelector<HTMLButtonElement>(".mm-block-source-trigger")!.click();
    const input = root.querySelector<HTMLTextAreaElement>(
      "[data-feature-field=body]",
    )!;
    input.value = "unsaved expression";
    app.receiveDocument({
      protocolVersion: 1,
      type: "document",
      markdown: "external replacement",
      profile: "github",
      version: 2,
      reason: "external",
    });
    root
      .querySelector<HTMLButtonElement>(
        ".mm-profile-feature-dialog button[type=submit]",
      )!
      .click();
    expect(serializeMarkdown(app.view.state.doc)).toBe("external replacement");
    expect(input.value).toBe("unsaved expression");
    expect(
      root.querySelector(".mm-profile-feature-dialog[open]"),
    ).not.toBeNull();
  });

  it("retains fences, custom metadata, CRLF and embedded fence runs", () => {
    const node = schema.nodes.raw_block!.create({
      kind: "protected-fence",
      source: '~~~mermaid title="A"\r\ngraph TD\r\n~~~\r\n',
    });
    const editor = blockSourceEditor(node)!;
    expect(editor.body).toBe("graph TD");
    expect(editor.replace("graph TD\r\n~~~~")).toBe(
      '~~~~~mermaid title="A"\r\ngraph TD\r\n~~~~\r\n~~~~~\r\n',
    );
  });
});
