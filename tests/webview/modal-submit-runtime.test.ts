import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { installModalSubmitShortcut } from "../../src/webview/modalSubmitShortcut";

const apps: MarkdownEditorApp[] = [];
const disposers: Array<() => void> = [];

function makeApp(
  markdown = "before",
  platform = "Linux x86_64",
): {
  app: MarkdownEditorApp;
  root: HTMLElement;
  messages: unknown[];
} {
  const root = document.createElement("div");
  document.body.append(root);
  const messages: unknown[] = [];
  const app = createEditorApp({
    root,
    vscode: { postMessage: (message) => messages.push(message) },
    core: { schema, parseMarkdown, serializeMarkdown, renderMarkdown },
    initialDocument: { markdown, version: 1, profile: "github" },
  });
  apps.push(app);
  disposers.push(installModalSubmitShortcut(root, platform));
  return { app, root, messages };
}

function editMessages(messages: unknown[]): Array<Record<string, unknown>> {
  return messages.filter(
    (message): message is Record<string, unknown> =>
      typeof message === "object" &&
      message !== null &&
      (message as { type?: unknown }).type === "edit",
  );
}

function openToolbarDialog(root: HTMLElement, testId: string): void {
  const button = root.querySelector<HTMLButtonElement>(
    `[data-testid="${testId}"]`,
  )!;
  button.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
  );
  button.click();
}

async function pressShortcutEnter(
  target: HTMLElement,
  modifiers: Pick<KeyboardEventInit, "ctrlKey" | "metaKey">,
): Promise<void> {
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      ...modifiers,
      bubbles: true,
      cancelable: true,
    }),
  );
  await Promise.resolve();
}

beforeEach(() => {
  document.body.replaceChildren();
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
  if (typeof Text !== "undefined" && !("getClientRects" in Text.prototype))
    Object.defineProperty(Text.prototype, "getClientRects", {
      configurable: true,
      value: () => [],
    });
});

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const app of apps.splice(0)) app.destroy();
  document.body.replaceChildren();
});

describe("modal primary-modifier Enter runtime integration", () => {
  it("submits the real image dialog with Command+Enter on macOS", async () => {
    const { root, messages } = makeApp("before", "MacIntel");
    openToolbarDialog(root, "toolbar-image");

    const dialog = root.querySelector<HTMLDialogElement>(
      'dialog[aria-labelledby="mm-image-dialog-title"]',
    )!;
    const inputs = dialog.querySelectorAll<HTMLInputElement>("input");
    expect(dialog.open).toBe(true);
    expect(inputs).toHaveLength(2);
    inputs[0]!.value = "./images/example.png";
    inputs[1]!.value = "Example";

    await pressShortcutEnter(inputs[1]!, { metaKey: true });

    expect(dialog.open).toBe(false);
    expect(editMessages(messages)).toHaveLength(1);
    expect(String(editMessages(messages)[0]?.markdown)).toContain(
      "![Example](./images/example.png)",
    );
  });

  it("submits the real table dialog with Ctrl+Enter on Windows/Linux", async () => {
    const { app, root, messages } = makeApp();
    openToolbarDialog(root, "toolbar-table");

    const dialog = root.querySelector<HTMLDialogElement>(".mm-table-dialog")!;
    const inputs = dialog.querySelectorAll<HTMLInputElement>(
      'input[type="number"]',
    );
    expect(dialog.open).toBe(true);
    expect(inputs).toHaveLength(2);
    inputs[0]!.value = "2";
    inputs[0]!.dispatchEvent(new Event("input", { bubbles: true }));
    inputs[1]!.value = "3";
    inputs[1]!.dispatchEvent(new Event("input", { bubbles: true }));

    await pressShortcutEnter(inputs[1]!, { ctrlKey: true });

    let tableRows: number | undefined;
    let tableColumns: number | undefined;
    app.view.state.doc.descendants((node) => {
      if (node.type.spec.tableRole !== "table") return true;
      tableRows = node.childCount;
      tableColumns = node.firstChild?.childCount;
      return false;
    });
    expect(dialog.open).toBe(false);
    expect(editMessages(messages)).toHaveLength(1);
    expect(tableRows).toBe(3);
    expect(tableColumns).toBe(2);
  });
});
