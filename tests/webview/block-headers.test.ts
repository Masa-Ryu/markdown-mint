import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isMathFenceLanguage,
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
import { NodeSelection } from "prosemirror-state";

const apps: MarkdownEditorApp[] = [];

function installMermaidRuntime(): void {
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.markdownMintMermaidVersion = "11.17.2";
  globals.markdownMintMermaid = {
    parse: async (source: string) => {
      if (!/^(?:flowchart|graph)\b/m.test(source) || /-->\s*$/.test(source))
        throw new Error("Mermaid syntax error");
      return {
        diagramType: source.trimStart().startsWith("graph")
          ? "flowchart"
          : "flowchart-v2",
      };
    },
    render: () => "<svg />",
  };
}

async function settleMermaidValidation(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 320));
  await Promise.resolve();
}
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
beforeEach(() => {
  installMermaidRuntime();
});

afterEach(() => {
  apps.splice(0).forEach((app) => app.destroy());
  const globals = globalThis as unknown as Record<string, unknown>;
  delete globals.markdownMintMermaid;
  delete globals.markdownMintMermaidVersion;
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
    async (kind, source) => {
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
      if (kind === "mermaid") {
        dialog
          .querySelector<HTMLTextAreaElement>("[data-feature-field=body]")!
          .dispatchEvent(new Event("input", { bubbles: true }));
        await settleMermaidValidation();
      }
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
    async (source) => {
      const { root, app, messages } = setup(source);
      openRenderedEditor(root, source.startsWith("```") ? "mermaid" : "math");
      if (source.startsWith("```")) await settleMermaidValidation();
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
      if (source.startsWith("```")) {
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await settleMermaidValidation();
      }
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

  it.each(["math", "latex", "tex", "asciimath"] as const)(
    "keeps the parser and rendered source editor aligned for %s fences",
    (language) => {
      const source = `~~~${language} title="Pythagoras" custom=value\r\nx^2\r\n~~~\r\n`;
      expect(isMathFenceLanguage(`${language} title="Pythagoras"`)).toBe(true);
      const snapshot = parseMarkdown(source);
      const node = snapshot.doc.firstChild!;
      expect(node.type.name).toBe("raw_block");
      expect(node.attrs.kind).toBe("math-block");
      expect(blockSourceEditor(node)?.kind).toBe("math");
      expect(renderMarkdown(source)).toContain('class="mm-math mm-math-block"');
      expect(serializeMarkdown(snapshot.doc, snapshot)).toBe(source);
      expect(blockSourceEditor(node)?.replace("y^3")).toBe(
        source.replace("x^2", "y^3"),
      );
    },
  );

  it("recognizes a mixed-case Math alias without changing its source casing", () => {
    const source = '```LaTeX title="Pythagoras" custom=value\nx^2\n```\n';
    const snapshot = parseMarkdown(source);
    const node = snapshot.doc.firstChild!;
    const editor = blockSourceEditor(node)!;

    expect(node.attrs.kind).toBe("math-block");
    expect(editor.kind).toBe("math");
    expect(editor.body).toBe("x^2");
    expect(editor.replace("y^3")).toBe(
      '```LaTeX title="Pythagoras" custom=value\ny^3\n```\n',
    );
  });

  it.each([
    ["multiline LF", "$$\nx^2\n$$\n", "x^2"],
    ["multiline CRLF", "$$\r\nx^2\r\n$$\r\n", "x^2"],
    ["multiline CR", "$$\rx^2\r$$\r", "x^2"],
    ["compact one-line", "$$x^2$$", "x^2"],
    ["indented", "   $$\n   x^2\n   $$\n", "   x^2"],
  ] as const)(
    "keeps display Math source editable and source-preserving: %s",
    (_label, source, body) => {
      const snapshot = parseMarkdown(source);
      const node = snapshot.doc.firstChild!;
      const editor = blockSourceEditor(node);

      expect(node.type.name).toBe("raw_block");
      expect(node.attrs.kind).toBe("math-block");
      expect(editor?.kind).toBe("math");
      expect(editor?.body).toBe(body);
      expect(editor?.replace("y^3")).toBe(source.replace(body, "y^3"));
    },
  );

  it("edits only an inline Math atom and keeps ordinary text double clicks native", () => {
    const source = "Before $x^2$ After";
    const { root, app, messages } = setup(source);
    const math = root.querySelector<HTMLElement>(
      ".mm-rendered-inline[data-mm-editable-math='true']",
    )!;
    expect(math).not.toBeNull();
    expect(math.tabIndex).toBe(-1);
    expect(math.getAttribute("role")).toBe("button");
    expect(math.getAttribute("aria-label")).toBe("Edit Math");

    const paragraph = root.querySelector("p")!;
    paragraph.dispatchEvent(
      new MouseEvent("dblclick", { bubbles: true, cancelable: true }),
    );
    expect(root.querySelector(".mm-profile-feature-dialog[open]")).toBeNull();

    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      detail: 1,
    });
    math.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    const position = app.view.posAtDOM(math, 0);
    app.view.dispatch(
      app.view.state.tr.setSelection(
        NodeSelection.create(app.view.state.doc, position),
      ),
    );
    expect(app.view.state.selection.constructor.name).toBe("NodeSelection");
    expect(root.querySelector(".mm-profile-feature-dialog[open]")).toBeNull();

    math.dispatchEvent(
      new MouseEvent("dblclick", { bubbles: true, cancelable: true }),
    );
    const dialog = root.querySelector<HTMLDialogElement>(
      ".mm-profile-feature-dialog[open]",
    )!;
    const input = dialog.querySelector<HTMLTextAreaElement>(
      "[data-feature-field=body]",
    )!;
    expect(input.value).toBe("x^2");
    dialog
      .querySelector<HTMLButtonElement>("button:not([type='submit'])")!
      .click();
    expect(serializeMarkdown(app.view.state.doc)).toBe(source);
    expect(
      messages.filter(
        (message) => (message as { type: string }).type === "edit",
      ),
    ).toHaveLength(0);

    const beforeText = paragraph.firstChild!;
    beforeText.dispatchEvent(
      new MouseEvent("dblclick", { bubbles: true, cancelable: true }),
    );
    expect(root.querySelector(".mm-profile-feature-dialog[open]")).toBeNull();

    math.dispatchEvent(
      new MouseEvent("dblclick", { bubbles: true, cancelable: true }),
    );
    const updateDialog = root.querySelector<HTMLDialogElement>(
      ".mm-profile-feature-dialog[open]",
    )!;
    updateDialog.querySelector<HTMLTextAreaElement>(
      "[data-feature-field=body]",
    )!.value = "y^3";
    updateDialog
      .querySelector<HTMLButtonElement>("button[type=submit]")!
      .click();
    expect(serializeMarkdown(app.view.state.doc)).toBe("Before $y^3$ After");
    expect(
      messages.filter(
        (message) => (message as { type: string }).type === "edit",
      ),
    ).toHaveLength(1);
  });

  it.each(["Enter", " "])(
    "opens inline Math from a selected atom with %s",
    (key) => {
      const { root, app } = setup("Before $x$ After");
      const math = root.querySelector<HTMLElement>(
        ".mm-rendered-inline[data-mm-editable-math='true']",
      )!;
      math.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          detail: 1,
        }),
      );
      const position = app.view.posAtDOM(math, 0);
      app.view.dispatch(
        app.view.state.tr.setSelection(
          NodeSelection.create(app.view.state.doc, position),
        ),
      );
      expect(app.view.state.selection.constructor.name).toBe("NodeSelection");
      app.view.focus();
      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      });
      app.view.dom.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(
        root.querySelector(".mm-profile-feature-dialog[open]"),
      ).not.toBeNull();
    },
  );

  it.each([
    [
      "different expressions",
      "Before $a$ middle $b$ After",
      "b",
      "c",
      "Before $a$ middle $c$ After",
    ],
    [
      "identical expressions",
      "Before $x$ middle $x$ After",
      "x",
      "y",
      "Before $x$ middle $y$ After",
    ],
  ] as const)(
    "updates only the selected inline Math atom: %s",
    (_label, source, body, replacement, expected) => {
      const { root, app } = setup(source);
      const math = root.querySelectorAll<HTMLElement>(
        ".mm-rendered-inline[data-mm-editable-math='true']",
      )[1]!;
      math.dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true, cancelable: true }),
      );
      const dialog = root.querySelector<HTMLDialogElement>(
        ".mm-profile-feature-dialog[open]",
      )!;
      const input = dialog.querySelector<HTMLTextAreaElement>(
        "[data-feature-field=body]",
      )!;
      expect(input.value).toBe(body);
      input.value = replacement;
      dialog.querySelector<HTMLButtonElement>("button[type=submit]")!.click();
      expect(serializeMarkdown(app.view.state.doc)).toBe(expected);
    },
  );

  it.each([
    "**Before $x^2$ After**",
    "Text *before $x^2$ after*",
    "[Text $x^2$](https://example.com)",
  ])("preserves surrounding inline marks while editing Math: %s", (source) => {
    const { root, app } = setup(source);
    const math = root.querySelector<HTMLElement>(
      ".mm-rendered-inline[data-mm-editable-math='true']",
    )!;
    math.dispatchEvent(
      new MouseEvent("dblclick", { bubbles: true, cancelable: true }),
    );
    const dialog = root.querySelector<HTMLDialogElement>(
      ".mm-profile-feature-dialog[open]",
    )!;
    dialog.querySelector<HTMLTextAreaElement>(
      "[data-feature-field=body]",
    )!.value = "y^3";
    dialog.querySelector<HTMLButtonElement>("button[type=submit]")!.click();
    expect(serializeMarkdown(app.view.state.doc)).toBe(
      source.replace("x^2", "y^3"),
    );
  });

  it("keeps escaped dollars inside an inline Math source atom", () => {
    const source = "Before $x\\$y$ After";
    const { root, app } = setup(source);
    const math = root.querySelector<HTMLElement>(
      ".mm-rendered-inline[data-mm-editable-math='true']",
    )!;
    math.dispatchEvent(
      new MouseEvent("dblclick", { bubbles: true, cancelable: true }),
    );
    const dialog = root.querySelector<HTMLDialogElement>(
      ".mm-profile-feature-dialog[open]",
    )!;
    const input = dialog.querySelector<HTMLTextAreaElement>(
      "[data-feature-field=body]",
    )!;
    expect(input.value).toBe("x\\$y");
    dialog
      .querySelector<HTMLButtonElement>("button:not([type='submit'])")!
      .click();
    expect(serializeMarkdown(app.view.state.doc)).toBe(source);

    math.dispatchEvent(
      new MouseEvent("dblclick", { bubbles: true, cancelable: true }),
    );
    root.querySelector<HTMLTextAreaElement>(
      "[data-feature-field=body]",
    )!.value = "z";
    root
      .querySelector<HTMLButtonElement>(
        ".mm-profile-feature-dialog button[type=submit]",
      )!
      .click();
    expect(serializeMarkdown(app.view.state.doc)).toBe("Before $z$ After");
  });

  it("keeps an inline Math draft when the target becomes stale", () => {
    const { root, app } = setup("Before $x$ After");
    const math = root.querySelector<HTMLElement>(
      ".mm-rendered-inline[data-mm-editable-math='true']",
    )!;
    math.dispatchEvent(
      new MouseEvent("dblclick", { bubbles: true, cancelable: true }),
    );
    const input = root.querySelector<HTMLTextAreaElement>(
      "[data-feature-field=body]",
    )!;
    input.value = "draft survives";
    app.receiveDocument({
      protocolVersion: 1,
      type: "document",
      markdown: "External replacement",
      version: 2,
      profile: "github",
      reason: "external",
    });
    root
      .querySelector<HTMLButtonElement>(
        ".mm-profile-feature-dialog button[type=submit]",
      )!
      .click();
    expect(serializeMarkdown(app.view.state.doc)).toBe("External replacement");
    expect(input.value).toBe("draft survives");
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
