import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TextSelection } from "prosemirror-state";
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
import { BlockBoundarySelection } from "../../src/webview/blockBoundary";
import { installModalSubmitShortcut } from "../../src/webview/modalSubmitShortcut";

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

function makeApp(
  markdown = "selected text",
  profile: "github" | "gitlab" | "commonmark" = "github",
): { app: MarkdownEditorApp; root: HTMLElement; messages: unknown[] } {
  const root = document.createElement("div");
  document.body.append(root);
  const messages: unknown[] = [];
  const app = createEditorApp({
    root,
    vscode: { postMessage: (message) => messages.push(message) },
    core: { schema, parseMarkdown, serializeMarkdown, renderMarkdown },
    initialDocument: { markdown, version: 1, profile },
  });
  apps.push(app);
  return { app, root, messages };
}

function currentSource(app: MarkdownEditorApp): string {
  return serializeMarkdown(app.view.state.doc);
}

function featureButton(root: HTMLElement, id: string): HTMLButtonElement {
  return root.querySelector<HTMLButtonElement>(
    '[data-profile-feature="' + id + '"]',
  )!;
}

function selectBoundaryBetweenFirstTwoBlocks(app: MarkdownEditorApp): number {
  const position = app.view.state.doc.child(0).nodeSize;
  app.view.dispatch(
    app.view.state.tr.setSelection(
      new BlockBoundarySelection(app.view.state.doc.resolve(position)),
    ),
  );
  return position;
}

function editCount(messages: unknown[]): number {
  return messages.filter(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      (message as { type?: unknown }).type === "edit",
  ).length;
}

function doubleClickAlert(root: HTMLElement, index = 0): void {
  root
    .querySelectorAll<HTMLElement>(".mm-alert-node-view")
    [index]!.dispatchEvent(
      new MouseEvent("dblclick", { bubbles: true, cancelable: true }),
    );
}

function dispatchCellText(app: MarkdownEditorApp, root: HTMLElement): void {
  const cell = root.querySelector("tbody td")!;
  const position = app.view.posAtDOM(cell, 0);
  app.view.dispatch(
    app.view.state.tr.setSelection(
      TextSelection.near(app.view.state.doc.resolve(position + 1)),
    ),
  );
}

beforeEach(() => {
  document.body.replaceChildren();
  installMermaidRuntime();
  if (typeof Range !== "undefined" && !Range.prototype.getClientRects)
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [],
    });
  if (typeof Range !== "undefined" && !Range.prototype.getBoundingClientRect)
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
        width: 0,
        height: 0,
      }),
    });
});

afterEach(() => {
  for (const app of apps) app.destroy();
  apps.length = 0;
  const globals = globalThis as unknown as Record<string, unknown>;
  delete globals.markdownMintMermaid;
  delete globals.markdownMintMermaidVersion;
  document.body.replaceChildren();
});

describe("profile feature toolbar", () => {
  it("shows the profile row only for rich GitHub/GitLab editing and keeps table order", () => {
    const github = makeApp();
    const profile = github.root.querySelector<HTMLElement>(
      ".mm-profile-toolbar",
    )!;
    expect(profile.hidden).toBe(false);
    expect(profile.querySelector("[data-profile-toolbar-label]")).toBeNull();
    expect(profile.getAttribute("aria-label")).toBe(
      "Profile-specific Markdown features",
    );
    expect(
      profile.querySelectorAll("[data-profile-feature]:not([hidden])"),
    ).toHaveLength(4);

    const gitlab = makeApp("selected text", "gitlab");
    const gitlabProfile = gitlab.root.querySelector<HTMLElement>(
      ".mm-profile-toolbar",
    )!;
    expect(gitlabProfile.hidden).toBe(false);
    expect(
      gitlabProfile.querySelector("[data-profile-toolbar-label]"),
    ).toBeNull();
    expect(
      gitlabProfile.querySelectorAll("[data-profile-feature]:not([hidden])"),
    ).toHaveLength(8);

    const commonmark = makeApp("selected text", "commonmark");
    expect(
      commonmark.root.querySelector<HTMLElement>(".mm-profile-toolbar")!.hidden,
    ).toBe(true);

    const table = makeApp("| A | B |\n| --- | --- |\n| C | D |");
    dispatchCellText(table.app, table.root);
    const tableToolbar =
      table.root.querySelector<HTMLElement>(".mm-table-toolbar")!;
    const tableProfile = table.root.querySelector<HTMLElement>(
      ".mm-profile-toolbar",
    )!;
    expect(tableToolbar.hidden).toBe(false);
    expect(tableProfile.hidden).toBe(false);
    expect(
      tableToolbar.compareDocumentPosition(tableProfile) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows Mermaid-only metadata and keeps the accessible source label", async () => {
    const { root } = makeApp();
    featureButton(root, "mermaid").click();
    const dialog = root.querySelector<HTMLDialogElement>(
      ".mm-profile-feature-dialog",
    )!;
    const body = dialog.querySelector<HTMLTextAreaElement>(
      '[data-feature-field="body"]',
    )!;
    const status = dialog.querySelector<HTMLElement>(
      ".mm-mermaid-validation-status",
    )!;
    expect(dialog.dataset.profileFeature).toBe("mermaid");
    expect(dialog.querySelector("h2")?.textContent).toBe("Insert Mermaid");
    expect(
      dialog.querySelector<HTMLElement>(".mm-mermaid-dialog-meta")!.hidden,
    ).toBe(false);
    expect(
      dialog.querySelector<HTMLElement>(".mm-mermaid-version")!.textContent,
    ).toBe("Mermaid 11.17.2");
    expect(status.textContent).toBe("Checking…");
    expect(
      dialog.querySelector("[data-feature-field-container=body] > span"),
    ).not.toBeNull();
    expect(body.getAttribute("aria-label")).toBe("Diagram source");
    expect(
      dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!
        .disabled,
    ).toBe(true);
    await settleMermaidValidation();
    expect(status.textContent).toBe("✓ Valid · Flowchart");
    expect(
      dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!
        .disabled,
    ).toBe(false);

    dialog
      .querySelector<HTMLButtonElement>("button:not([type=submit])")!
      .click();
    featureButton(root, "math").click();
    expect(dialog.dataset.profileFeature).toBe("math");
    expect(
      dialog.querySelector<HTMLElement>(".mm-mermaid-dialog-meta")!.hidden,
    ).toBe(true);
  });

  it("blocks invalid and empty Mermaid source, including direct form submission", async () => {
    const { root, app, messages } = makeApp();
    featureButton(root, "mermaid").click();
    const dialog = root.querySelector<HTMLDialogElement>(
      ".mm-profile-feature-dialog",
    )!;
    const body = dialog.querySelector<HTMLTextAreaElement>(
      '[data-feature-field="body"]',
    )!;
    const submit = dialog.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    )!;
    body.value = "flowchart TD\n  A -->";
    body.dispatchEvent(new Event("input", { bubbles: true }));
    expect(submit.disabled).toBe(true);
    await settleMermaidValidation();
    expect(
      dialog.querySelector<HTMLElement>(".mm-mermaid-validation-status")!
        .textContent,
    ).toBe("✕ Syntax error");
    expect(submit.disabled).toBe(true);
    dialog
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    expect(editCount(messages)).toBe(0);
    expect(dialog.hasAttribute("open")).toBe(true);

    body.value = "";
    body.dispatchEvent(new Event("input", { bubbles: true }));
    expect(submit.disabled).toBe(true);
    await Promise.resolve();
    expect(
      dialog.querySelector<HTMLElement>(".mm-mermaid-validation-status")!
        .textContent,
    ).toBe("Enter Mermaid source");
    expect(serializeMarkdown(app.view.state.doc)).toBe("selected text");
  });

  it("requires a valid latest source for the platform submit shortcut", async () => {
    const { root, messages } = makeApp();
    const disposeShortcut = installModalSubmitShortcut(root, "Linux x86_64");
    try {
      featureButton(root, "mermaid").click();
      const dialog = root.querySelector<HTMLDialogElement>(
        ".mm-profile-feature-dialog",
      )!;
      const body = dialog.querySelector<HTMLTextAreaElement>(
        '[data-feature-field="body"]',
      )!;
      body.value = "flowchart TD\n  A -->";
      body.dispatchEvent(new Event("input", { bubbles: true }));
      await settleMermaidValidation();
      const invalidEnter = new KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      body.dispatchEvent(invalidEnter);
      await Promise.resolve();
      expect(invalidEnter.defaultPrevented).toBe(false);
      expect(editCount(messages)).toBe(0);

      body.value = "flowchart TD\n  A --> B";
      body.dispatchEvent(new Event("input", { bubbles: true }));
      await settleMermaidValidation();
      const validEnter = new KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      body.dispatchEvent(validEnter);
      await Promise.resolve();
      expect(validEnter.defaultPrevented).toBe(true);
      expect(editCount(messages)).toBe(1);
    } finally {
      disposeShortcut();
    }
  });

  it("inserts the four GitHub features through guarded dialogs", async () => {
    const cases: Array<{
      id: string;
      configure: (dialog: HTMLDialogElement) => void;
      expected: string;
    }> = [
      {
        id: "alert",
        configure: (dialog) => {
          dialog.querySelector<HTMLSelectElement>(
            '[data-feature-field="alert-type"]',
          )!.value = "WARNING";
          dialog.querySelector<HTMLTextAreaElement>(
            '[data-feature-field="body"]',
          )!.value = "Watch this";
        },
        expected: "> [!WARNING]",
      },
      {
        id: "details",
        configure: (dialog) => {
          dialog.querySelector<HTMLInputElement>(
            '[data-feature-field="title"]',
          )!.value = "More";
          dialog.querySelector<HTMLTextAreaElement>(
            '[data-feature-field="body"]',
          )!.value = "Hidden body";
        },
        expected: "<summary>More</summary>",
      },
      {
        id: "math",
        configure: (dialog) => {
          dialog.querySelector<HTMLTextAreaElement>(
            '[data-feature-field="body"]',
          )!.value = "x^2";
        },
        expected: "$$\nx^2\n$$",
      },
      {
        id: "mermaid",
        configure: (dialog) => {
          dialog.querySelector<HTMLTextAreaElement>(
            '[data-feature-field="body"]',
          )!.value = "flowchart TD\n A-->B";
        },
        expected: "mermaid",
      },
    ];
    for (const entry of cases) {
      const { root, app, messages } = makeApp();
      featureButton(root, entry.id).click();
      const dialog = root.querySelector<HTMLDialogElement>(
        '[data-feature-dialog="true"]',
      )!;
      expect(dialog.querySelector("h2")?.textContent).toBe(
        {
          alert: "Insert Alert",
          details: "Insert Details",
          math: "Insert Math",
          mermaid: "Insert Mermaid",
        }[entry.id],
      );
      expect(dialog.getAttribute("data-profile-feature")).toBe(entry.id);
      entry.configure(dialog);
      if (entry.id === "mermaid") {
        dialog
          .querySelector<HTMLTextAreaElement>('[data-feature-field="body"]')!
          .dispatchEvent(new Event("input", { bubbles: true }));
        await settleMermaidValidation();
      }
      dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
      expect(currentSource(app)).toContain(entry.expected);
      expect(editCount(messages)).toBe(1);
      expect(dialog.hidden).toBe(false);
      expect(dialog.hasAttribute("open")).toBe(false);
    }
  });

  it("inserts GitHub block features directly from a boundary without Enter", async () => {
    const source = "```text\ncode\n```\n\n| A | B |\n| --- | --- |\n| a | b |";
    const cases: Array<{
      id: "alert" | "details" | "math" | "mermaid";
      configure: (dialog: HTMLDialogElement) => void;
      sourcePart: string;
      kind: string;
      nodeType?: string;
    }> = [
      {
        id: "alert",
        configure: (dialog) => {
          dialog.querySelector<HTMLTextAreaElement>(
            '[data-feature-field="body"]',
          )!.value = "Alert from boundary";
        },
        sourcePart: "> [!NOTE]\n> Alert from boundary",
        kind: "alert",
      },
      {
        id: "details",
        configure: (dialog) => {
          dialog.querySelector<HTMLInputElement>(
            '[data-feature-field="title"]',
          )!.value = "More";
          dialog.querySelector<HTMLTextAreaElement>(
            '[data-feature-field="body"]',
          )!.value = "Details from boundary";
        },
        sourcePart:
          "<details>\n<summary>More</summary>\n\nDetails from boundary\n\n</details>",
        kind: "details",
        nodeType: "details",
      },
      {
        id: "math",
        configure: (dialog) => {
          dialog.querySelector<HTMLTextAreaElement>(
            '[data-feature-field="body"]',
          )!.value = "x^2";
        },
        sourcePart: "$$\nx^2\n$$",
        kind: "math-block",
      },
      {
        id: "mermaid",
        configure: (dialog) => {
          dialog.querySelector<HTMLTextAreaElement>(
            '[data-feature-field="body"]',
          )!.value = "graph TD\nA-->B";
        },
        sourcePart: "```mermaid\ngraph TD\nA-->B\n```",
        kind: "protected-fence",
      },
    ];

    for (const entry of cases) {
      const { app, root, messages } = makeApp(source);
      const position = selectBoundaryBetweenFirstTwoBlocks(app);
      expect(app.view.state.selection).toBeInstanceOf(BlockBoundarySelection);
      expect(app.view.state.selection.head).toBe(position);
      const before = currentSource(app);

      featureButton(root, entry.id).click();
      const dialog = root.querySelector<HTMLDialogElement>(
        '[data-feature-dialog="true"]',
      )!;
      entry.configure(dialog);
      if (entry.id === "mermaid") {
        dialog
          .querySelector<HTMLTextAreaElement>('[data-feature-field="body"]')!
          .dispatchEvent(new Event("input", { bubbles: true }));
        await settleMermaidValidation();
      }
      dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();

      expect(currentSource(app)).toContain(entry.sourcePart);
      expect(app.view.state.doc.childCount).toBe(3);
      expect(app.view.state.doc.child(0).type.name).toBe("code_block");
      expect(app.view.state.doc.child(1).type.name).toBe(
        entry.nodeType ?? "raw_block",
      );
      expect(app.view.state.doc.child(1).attrs.kind).toBe(entry.kind);
      expect(app.view.state.doc.child(2).type.name).toBe("table");
      expect(editCount(messages)).toBe(1);
      expect(before).not.toBe(currentSource(app));
    }
  });

  it("cancels a boundary feature dialog without materializing a paragraph", () => {
    const { app, root, messages } = makeApp(
      "```text\ncode\n```\n\n| A | B |\n| --- | --- |\n| a | b |",
    );
    const position = selectBoundaryBetweenFirstTwoBlocks(app);
    const before = currentSource(app);
    const button = featureButton(root, "details");
    button.click();
    const dialog = root.querySelector<HTMLDialogElement>(
      '[data-feature-dialog="true"]',
    )!;
    dialog
      .querySelector<HTMLButtonElement>("button:not([type='submit'])")!
      .click();

    expect(currentSource(app)).toBe(before);
    expect(editCount(messages)).toBe(0);
    expect(app.sync.hasPending).toBe(false);
    expect(app.view.state.doc.childCount).toBe(2);
    expect(app.view.state.selection).toBeInstanceOf(BlockBoundarySelection);
    expect(app.view.state.selection.head).toBe(position);
  });

  it("opens the existing Alert dialog in edit mode with the current values", () => {
    const { app, root } = makeApp("> [!WARNING]\n> Something happened");
    const dialog = root.querySelector<HTMLDialogElement>(
      ".mm-profile-feature-dialog",
    )!;

    doubleClickAlert(root);

    expect(root.querySelectorAll(".mm-profile-feature-dialog")).toHaveLength(1);
    expect(dialog.dataset.profileFeatureMode).toBe("edit");
    expect(dialog.querySelector("h2")?.textContent).toBe("Edit Alert");
    expect(
      dialog.querySelector<HTMLButtonElement>('button[type="submit"]')
        ?.textContent,
    ).toBe("Update");
    expect(
      dialog.querySelector<HTMLSelectElement>(
        '[data-feature-field="alert-type"]',
      )?.value,
    ).toBe("WARNING");
    expect(
      dialog.querySelector<HTMLTextAreaElement>('[data-feature-field="body"]')
        ?.value,
    ).toBe("Something happened");
    app.destroy();
  });

  it("updates only the selected Alert when changing its type", () => {
    const source = "> [!TIP]\n> first\n\n> [!NOTE]\n> second";
    const { app, root } = makeApp(source);
    doubleClickAlert(root, 1);
    const dialog = root.querySelector<HTMLDialogElement>(
      ".mm-profile-feature-dialog",
    )!;
    dialog.querySelector<HTMLSelectElement>(
      '[data-feature-field="alert-type"]',
    )!.value = "WARNING";
    dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();

    expect(currentSource(app)).toBe(
      "> [!TIP]\n> first\n\n> [!WARNING]\n> second",
    );
    expect(root.querySelectorAll(".mm-alert-node-view")).toHaveLength(2);
    app.destroy();
  });

  it("preserves lazy continuation source on a type-only Alert update", () => {
    const source = "> [!TIP]\n> First\ncontinued\n> Last";
    const { app, root } = makeApp(source);
    doubleClickAlert(root);
    const dialog = root.querySelector<HTMLDialogElement>(
      ".mm-profile-feature-dialog",
    )!;
    dialog.querySelector<HTMLSelectElement>(
      '[data-feature-field="alert-type"]',
    )!.value = "WARNING";
    dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();

    expect(currentSource(app)).toBe("> [!WARNING]\n> First\ncontinued\n> Last");
    app.destroy();
  });

  it("updates Alert body and type in place without inserting another node", () => {
    const { app, root } = makeApp("> [!NOTE]\n> Server restarted");
    doubleClickAlert(root);
    const dialog = root.querySelector<HTMLDialogElement>(
      ".mm-profile-feature-dialog",
    )!;
    dialog.querySelector<HTMLSelectElement>(
      '[data-feature-field="alert-type"]',
    )!.value = "WARNING";
    dialog.querySelector<HTMLTextAreaElement>(
      '[data-feature-field="body"]',
    )!.value = "Server restart failed";
    dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();

    expect(currentSource(app)).toBe("> [!WARNING]\n> Server restart failed");
    expect(root.querySelectorAll(".mm-alert-node-view")).toHaveLength(1);
    app.destroy();
  });

  it("cancels Alert editing without changing source and restores the body caret", () => {
    const source = "> [!TIP]\n> Keep this";
    const { app, root } = makeApp(source);
    const bodyEditor = root.querySelector<HTMLTextAreaElement>(
      ".mm-alert-body-editor",
    )!;
    bodyEditor.focus();
    bodyEditor.setSelectionRange(2, 5);
    doubleClickAlert(root);
    const dialog = root.querySelector<HTMLDialogElement>(
      ".mm-profile-feature-dialog",
    )!;
    dialog.querySelector<HTMLSelectElement>(
      '[data-feature-field="alert-type"]',
    )!.value = "WARNING";
    dialog.querySelector<HTMLTextAreaElement>(
      '[data-feature-field="body"]',
    )!.value = "Changed";
    dialog
      .querySelector<HTMLButtonElement>("button:not([type='submit'])")!
      .click();

    expect(currentSource(app)).toBe(source);
    expect(document.activeElement).toBe(bodyEditor);
    expect(bodyEditor.selectionStart).toBe(2);
    expect(bodyEditor.selectionEnd).toBe(5);
    app.destroy();
  });

  it("rejects an Alert update after the authoritative document changes", () => {
    const { app, root } = makeApp("> [!TIP]\n> Original");
    doubleClickAlert(root);
    const dialog = root.querySelector<HTMLDialogElement>(
      ".mm-profile-feature-dialog",
    )!;
    dialog.querySelector<HTMLSelectElement>(
      '[data-feature-field="alert-type"]',
    )!.value = "WARNING";
    app.receiveDocument({
      protocolVersion: 1,
      type: "document",
      markdown: "> [!NOTE]\n> Authoritative update",
      version: 2,
      profile: "github",
      reason: "external",
    });
    dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();

    expect(currentSource(app)).toBe("> [!NOTE]\n> Authoritative update");
    expect(root.querySelector(".mm-status")).toBeNull();
    app.destroy();
  });

  it("keeps Alert header source editing disabled during composition", () => {
    const { app, root } = makeApp("> [!TIP]\n> Original");
    const editor = root.querySelector<HTMLElement>(".ProseMirror")!;
    const alertView = root.querySelector<HTMLElement>(".mm-alert-node-view")!;
    editor.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    alertView.dispatchEvent(
      new MouseEvent("dblclick", { bubbles: true, cancelable: true }),
    );
    expect(
      root
        .querySelector<HTMLDialogElement>(".mm-profile-feature-dialog")!
        .hasAttribute("open"),
    ).toBe(false);
    editor.dispatchEvent(new Event("compositionend", { bubbles: true }));
    app.destroy();
  });

  it("inserts GitLab-only TOC, definition, and inline diff features", () => {
    const toc = makeApp("Heading", "gitlab");
    featureButton(toc.root, "gitlab-toc").click();
    expect(currentSource(toc.app)).toContain("[[_TOC_]]");

    const definition = makeApp("Heading", "gitlab");
    featureButton(definition.root, "gitlab-description-list").click();
    const definitionDialog = definition.root.querySelector<HTMLDialogElement>(
      '[data-feature-dialog="true"]',
    )!;
    definitionDialog.querySelector<HTMLInputElement>(
      '[data-feature-field="term"]',
    )!.value = "Term";
    definitionDialog.querySelector<HTMLTextAreaElement>(
      '[data-feature-field="body"]',
    )!.value = "Description";
    definitionDialog
      .querySelector<HTMLButtonElement>('button[type="submit"]')!
      .click();
    expect(currentSource(definition.app)).toContain("Term\n: Description");

    const added = makeApp("selected text", "gitlab");
    added.app.view.dispatch(
      added.app.view.state.tr.setSelection(
        TextSelection.create(
          added.app.view.state.doc,
          1,
          added.app.view.state.doc.content.size - 1,
        ),
      ),
    );
    featureButton(added.root, "gitlab-diff-added").click();
    const addedDialog = added.root.querySelector<HTMLDialogElement>(
      '[data-feature-dialog="true"]',
    )!;
    expect(
      addedDialog.querySelector<HTMLTextAreaElement>(
        '[data-feature-field="body"]',
      )!.value,
    ).toBe("selected text");
    addedDialog
      .querySelector<HTMLButtonElement>('button[type="submit"]')!
      .click();
    expect(currentSource(added.app)).toContain("{+ selected text +}");

    const removed = makeApp("selected text", "gitlab");
    featureButton(removed.root, "gitlab-diff-removed").click();
    const removedDialog = removed.root.querySelector<HTMLDialogElement>(
      '[data-feature-dialog="true"]',
    )!;
    removedDialog.querySelector<HTMLTextAreaElement>(
      '[data-feature-field="body"]',
    )!.value = "old";
    removedDialog
      .querySelector<HTMLButtonElement>('button[type="submit"]')!
      .click();
    expect(currentSource(removed.app)).toContain("{- old -}");
  });

  it("cancels without editing, rejects stale dialogs, and restores focus", () => {
    const { app, root, messages } = makeApp();
    const button = featureButton(root, "details");
    button.click();
    const dialog = root.querySelector<HTMLDialogElement>(
      '[data-feature-dialog="true"]',
    )!;
    dialog
      .querySelector<HTMLButtonElement>("button:not([type='submit'])")!
      .click();
    expect(editCount(messages)).toBe(0);
    expect(document.activeElement).toBe(button);

    button.click();
    const reopenedDialog = root.querySelector<HTMLDialogElement>(
      '[data-feature-dialog="true"]',
    )!;
    reopenedDialog.dispatchEvent(
      new Event("cancel", { bubbles: true, cancelable: true }),
    );
    expect(editCount(messages)).toBe(0);
    expect(document.activeElement).toBe(button);

    button.click();
    const reopened = root.querySelector<HTMLTextAreaElement>(
      '[data-feature-field="body"]',
    )!;
    reopened.value = "stale body";
    app.view.dispatch(app.view.state.tr.insertText("changed"));
    root
      .querySelector<HTMLButtonElement>(
        '[data-feature-dialog="true"] button[type="submit"]',
      )!
      .click();
    expect(currentSource(app)).not.toContain("<details>");
    expect(root.querySelector(".mm-status")).toBeNull();
  });

  it("keeps invalid values in the dialog until corrected", () => {
    const { app, root } = makeApp();
    featureButton(root, "math").click();
    const dialog = root.querySelector<HTMLDialogElement>(
      '[data-feature-dialog="true"]',
    )!;
    const body = dialog.querySelector<HTMLTextAreaElement>(
      '[data-feature-field="body"]',
    )!;
    body.value = "   ";
    dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(
      dialog.querySelector<HTMLElement>("[data-feature-error]")?.hidden,
    ).toBe(false);
    body.value = "x + y";
    dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    expect(dialog.hasAttribute("open")).toBe(false);
    expect(currentSource(app)).toContain("x + y");
  });

  it("hides and disables feature insertion during preview and composition", () => {
    const preview = makeApp("text");
    const previewButton = featureButton(preview.root, "alert");
    preview.app.receiveDocument({
      protocolVersion: 1,
      type: "document",
      markdown: "text",
      version: 2,
      profile: "github",
      mode: "preview",
      reason: "external",
    });
    expect(
      preview.root.querySelector<HTMLElement>(".mm-profile-toolbar")!.hidden,
    ).toBe(true);
    expect(previewButton.disabled).toBe(true);

    const composing = makeApp("text");
    const composingButton = featureButton(composing.root, "alert");
    composing.root
      .querySelector<HTMLElement>(".ProseMirror")!
      .dispatchEvent(new Event("compositionstart", { bubbles: true }));
    expect(composingButton.disabled).toBe(true);
    expect(
      composing.root
        .querySelector<HTMLDialogElement>('[data-feature-dialog="true"]')!
        .hasAttribute("open"),
    ).toBe(false);
  });
});
