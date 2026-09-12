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

function openRenderedEditor(
  root: HTMLElement,
  kind: "math" | "mermaid",
  occurrence = 0,
): void {
  const node = root.querySelectorAll<HTMLElement>(
    `[role="button"][aria-label="Edit ${kind === "math" ? "Math" : "Mermaid"}"]`,
  )[occurrence];
  if (!node) throw new Error(`rendered ${kind} block is not focusable`);
  node.dispatchEvent(
    new MouseEvent("dblclick", { bubbles: true, cancelable: true }),
  );
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
  it("keeps Alert body focus separate from its internal NodeSelection", () => {
    const { root, app } = setup("> [!NOTE]\n> before");
    const body = root.querySelector<HTMLTextAreaElement>(
      ".mm-alert-body-editor",
    )!;
    const alertView = root.querySelector<HTMLElement>(".mm-alert-node-view")!;

    body.focus();

    expect(app.view.state.selection.constructor.name).toBe("NodeSelection");
    expect(alertView.classList.contains("ProseMirror-selectednode")).toBe(true);
    expect(alertView.classList.contains("mm-alert-body-focused")).toBe(true);

    body.blur();
    expect(alertView.classList.contains("mm-alert-body-focused")).toBe(false);
    app.destroy();
  });

  it("keeps a body single click directly editable without a picker or modal", () => {
    const { root, app, messages } = setup("> [!NOTE]\n> before");
    const body = root.querySelector<HTMLTextAreaElement>(
      ".mm-alert-body-editor",
    )!;
    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    body.dispatchEvent(click);
    body.focus();
    body.value = "typed body";
    body.dispatchEvent(new Event("input", { bubbles: true }));

    expect(click.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(body);
    expect(root.querySelector(".mm-profile-feature-dialog[open]")).toBeNull();
    expect(root.querySelector(".mm-alert-type-picker")).toBeNull();
    expect(root.querySelector(".mm-alert-type-select")).toBeNull();
    expect(serializeMarkdown(app.view.state.doc)).toBe(
      "> [!NOTE]\n> typed body",
    );
    expect(
      messages.filter(
        (message) => (message as { type: string }).type === "edit",
      ),
    ).toHaveLength(1);
  });

  it("opens the existing Alert dialog from a body double click after flushing native input", () => {
    const { root, app } = setup("> [!WARNING]\n> before");
    const body = root.querySelector<HTMLTextAreaElement>(
      ".mm-alert-body-editor",
    )!;
    const alertView = root.querySelector<HTMLElement>(".mm-alert-node-view")!;
    body.focus();
    body.value = "latest native body";
    const doubleClick = new MouseEvent("dblclick", {
      bubbles: true,
      cancelable: true,
    });
    body.dispatchEvent(doubleClick);

    const dialog = root.querySelector<HTMLDialogElement>(
      ".mm-profile-feature-dialog",
    )!;
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(dialog.dataset.profileFeatureMode).toBe("edit");
    expect(
      dialog.querySelector<HTMLSelectElement>(
        '[data-feature-field="alert-type"]',
      )!.value,
    ).toBe("WARNING");
    expect(
      dialog.querySelector<HTMLTextAreaElement>('[data-feature-field="body"]')!
        .value,
    ).toBe("latest native body");
    expect(serializeMarkdown(app.view.state.doc)).toBe(
      "> [!WARNING]\n> latest native body",
    );
    expect(doubleClick.defaultPrevented).toBe(true);
    expect(alertView.classList.contains("mm-alert-dialog-open")).toBe(true);
    dialog
      .querySelector<HTMLButtonElement>("button:not([type='submit'])")!
      .click();
    expect(alertView.classList.contains("mm-alert-dialog-open")).toBe(false);
    expect(document.activeElement).toBe(body);
  });

  it("opens the same Alert dialog only on a header double click", () => {
    const { root, app } = setup("> [!TIP]\n> body");
    const alertView = root.querySelector<HTMLElement>(".mm-alert-node-view")!;
    const title = root.querySelector<HTMLElement>(".markdown-alert-title")!;
    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      detail: 1,
    });
    title.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    expect(root.querySelector(".mm-profile-feature-dialog[open]")).toBeNull();
    expect(root.querySelector(".mm-alert-type-picker")).toBeNull();
    expect(root.querySelector(".mm-alert-type-select")).toBeNull();

    const syntheticClick = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      detail: 0,
    });
    title.dispatchEvent(syntheticClick);
    const syntheticDialog = root.querySelector<HTMLDialogElement>(
      ".mm-profile-feature-dialog",
    )!;
    expect(syntheticClick.defaultPrevented).toBe(true);
    expect(syntheticDialog.hasAttribute("open")).toBe(true);
    expect(syntheticDialog.dataset.profileFeatureMode).toBe("edit");
    expect(
      syntheticDialog.querySelector<HTMLSelectElement>(
        '[data-feature-field="alert-type"]',
      )!.value,
    ).toBe("TIP");
    expect(
      syntheticDialog.querySelector<HTMLTextAreaElement>(
        '[data-feature-field="body"]',
      )!.value,
    ).toBe("body");
    syntheticDialog
      .querySelector<HTMLButtonElement>("button:not([type='submit'])")!
      .click();

    const secondPhysicalClick = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      detail: 2,
    });
    title.dispatchEvent(secondPhysicalClick);
    expect(secondPhysicalClick.defaultPrevented).toBe(false);
    expect(root.querySelector(".mm-profile-feature-dialog[open]")).toBeNull();

    title.dispatchEvent(
      new MouseEvent("dblclick", { bubbles: true, cancelable: true }),
    );
    const dialog = root.querySelector<HTMLDialogElement>(
      ".mm-profile-feature-dialog",
    )!;
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(dialog.dataset.profileFeatureMode).toBe("edit");
    expect(
      dialog.querySelector<HTMLSelectElement>(
        '[data-feature-field="alert-type"]',
      )!.value,
    ).toBe("TIP");
    expect(
      dialog.querySelector<HTMLTextAreaElement>('[data-feature-field="body"]')!
        .value,
    ).toBe("body");
    expect(alertView.classList.contains("mm-alert-dialog-open")).toBe(true);
    app.destroy();
  });

  it.each([
    ["Enter", "Enter"],
    ["Space", " "],
  ])(
    "keeps keyboard %s access to the Alert editor on its header",
    (_name, key) => {
      const { root, app } = setup("> [!NOTE]\n> body");
      const title = root.querySelector<HTMLElement>(".markdown-alert-title")!;
      expect(title.tabIndex).toBe(0);
      expect(title.getAttribute("role")).toBe("button");
      title.focus();
      const enter = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      });
      title.dispatchEvent(enter);
      expect(enter.defaultPrevented).toBe(true);
      title.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          detail: 0,
        }),
      );
      expect(
        root.querySelectorAll<HTMLDialogElement>(
          ".mm-profile-feature-dialog[open]",
        ),
      ).toHaveLength(1);
      app.destroy();
    },
  );

  it("rejects synthetic header activation during composition and preview", () => {
    const composing = setup("> [!NOTE]\n> composing");
    const composingTitle = composing.root.querySelector<HTMLElement>(
      ".markdown-alert-title",
    )!;
    composing.root
      .querySelector<HTMLElement>(".ProseMirror")!
      .dispatchEvent(new Event("compositionstart", { bubbles: true }));
    composingTitle.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        detail: 0,
      }),
    );
    expect(
      composing.root
        .querySelector<HTMLDialogElement>(".mm-profile-feature-dialog")!
        .hasAttribute("open"),
    ).toBe(false);

    const preview = setup("> [!NOTE]\n> preview");
    preview.app.receiveDocument({
      protocolVersion: 1,
      type: "document",
      markdown: "> [!NOTE]\n> preview",
      version: 2,
      profile: "github",
      mode: "preview",
      reason: "external",
    });
    preview.root
      .querySelector<HTMLElement>(".markdown-alert-title")!
      .dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          detail: 0,
        }),
      );
    expect(
      preview.root
        .querySelector<HTMLDialogElement>(".mm-profile-feature-dialog")!
        .hasAttribute("open"),
    ).toBe(false);
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
      openRenderedEditor(root, source.startsWith("```") ? "mermaid" : "math");
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

  it.each([
    ["math", "$$\nx^2\n$$"],
    ["mermaid", "```mermaid\ngraph LR\n  A --> B\n```"],
  ] as const)(
    "uses the rendered %s block for modal editing",
    (kind, source) => {
      const { root, app } = setup(source);
      const label = kind === "math" ? "Math" : "Mermaid";
      const rendered = root.querySelector<HTMLElement>(
        `[role="button"][aria-label="Edit ${label}"]`,
      )!;
      expect(rendered).not.toBeNull();
      expect(rendered.tabIndex).toBe(0);
      expect(rendered.getAttribute("role")).toBe("button");
      expect(rendered.getAttribute("aria-label")).toBe(`Edit ${label}`);
      expect(root.querySelector(".mm-block-source-trigger")).toBeNull();

      const click = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        detail: 1,
      });
      rendered.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(false);
      expect(root.querySelector(".mm-profile-feature-dialog[open]")).toBeNull();

      rendered.dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true, cancelable: true }),
      );
      let dialog = root.querySelector<HTMLDialogElement>(
        ".mm-profile-feature-dialog[open]",
      )!;
      expect(dialog.dataset.profileFeatureMode).toBe("edit");
      dialog
        .querySelector<HTMLButtonElement>("button:not([type='submit'])")!
        .click();

      rendered.focus();
      for (const key of ["Enter", " "]) {
        const event = new KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
        });
        rendered.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        dialog = root.querySelector<HTMLDialogElement>(
          ".mm-profile-feature-dialog[open]",
        )!;
        expect(dialog).not.toBeNull();
        dialog
          .querySelector<HTMLButtonElement>("button:not([type='submit'])")!
          .click();
      }

      const childButton = document.createElement("button");
      childButton.type = "button";
      childButton.textContent = "interactive";
      rendered.append(childButton);
      childButton.dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true, cancelable: true }),
      );
      expect(root.querySelector(".mm-profile-feature-dialog[open]")).toBeNull();
      childButton.remove();

      rendered.dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true, cancelable: true }),
      );
      dialog = root.querySelector<HTMLDialogElement>(
        ".mm-profile-feature-dialog[open]",
      )!;
      dialog.querySelector<HTMLTextAreaElement>(
        "[data-feature-field=body]",
      )!.value = kind === "math" ? "y^3" : "graph TD\n  C --> D";
      dialog.querySelector<HTMLButtonElement>("button[type=submit]")!.click();
      expect(serializeMarkdown(app.view.state.doc)).toContain(
        kind === "math" ? "y^3" : "C --> D",
      );
    },
  );

  it.each(["preview", "readonly"])(
    "preserves an open source draft when %s is imposed",
    (mode) => {
      const { root, app } = setup("$$\nx\n$$");
      openRenderedEditor(root, "math");
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

  it.each([
    "$$\nx + y\n$$",
    "```mermaid title=diagram\ngraph TD\n A-->B\n```",
    "~~~math\nx + y\n~~~",
  ])(
    "edits the existing rendered source and preserves its wrapper: %s",
    (source) => {
      const { root, app, messages } = setup(source);
      openRenderedEditor(root, source.startsWith("```") ? "mermaid" : "math");
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
      openRenderedEditor(root, source.startsWith("```") ? "mermaid" : "math");
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
    openRenderedEditor(root, "math", 1);
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
    openRenderedEditor(root, "math");
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
