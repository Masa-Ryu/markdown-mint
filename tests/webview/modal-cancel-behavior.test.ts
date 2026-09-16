import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import {
  isPointerOutsideDialog,
  ModalCancelBehavior,
} from "../../src/webview/modalCancelBehavior";

const apps: MarkdownEditorApp[] = [];

function makeApp(
  markdown = "Before",
  profile: "github" | "gitlab" = "github",
): { app: MarkdownEditorApp; root: HTMLElement } {
  const root = document.createElement("div");
  document.body.append(root);
  const app = createEditorApp({
    root,
    vscode: { postMessage: () => undefined },
    core: { schema, parseMarkdown, serializeMarkdown, renderMarkdown },
    initialDocument: { markdown, version: 1, profile },
  });
  apps.push(app);
  return { app, root };
}

function setDialogRect(dialog: HTMLDialogElement): void {
  vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue({
    left: 100,
    top: 100,
    right: 400,
    bottom: 300,
    width: 300,
    height: 200,
    x: 100,
    y: 100,
    toJSON: () => ({}),
  });
}

function pointerEvent(
  type: "pointerdown" | "pointerup",
  clientX: number,
  clientY: number,
): MouseEvent {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX,
    clientY,
  });
}

function clickBackdrop(): void {
  document.dispatchEvent(pointerEvent("pointerdown", 40, 40));
  document.dispatchEvent(pointerEvent("pointerup", 40, 40));
}

function changeInput(
  input: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function confirmation(root: HTMLElement): HTMLDialogElement | null {
  return root.querySelector<HTMLDialogElement>(
    ".mm-discard-changes-dialog[open]",
  );
}

function discard(root: HTMLElement): void {
  root
    .querySelector<HTMLButtonElement>(
      ".mm-discard-changes-dialog button[type=submit]",
    )
    ?.click();
}

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  for (const app of apps) app.destroy();
  apps.length = 0;
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("ModalCancelBehavior", () => {
  it("compares snapshots, handles Escape, and rejects an inside-to-outside drag", () => {
    const dialog = document.createElement("dialog");
    const input = document.createElement("input");
    dialog.append(input);
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    setDialogRect(dialog);
    let value = "initial";
    const requests: string[] = [];
    const behavior = new ModalCancelBehavior({
      dialog,
      getSnapshot: () => [value],
      onCancelRequest: (reason) => requests.push(reason),
    });
    behavior.install();
    behavior.captureSnapshot();
    expect(behavior.isDirty()).toBe(false);
    value = "changed";
    expect(behavior.isDirty()).toBe(true);

    document.dispatchEvent(pointerEvent("pointerdown", 200, 200));
    document.dispatchEvent(pointerEvent("pointerup", 40, 40));
    expect(requests).toEqual([]);

    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    const cancel = new Event("cancel", { bubbles: true, cancelable: true });
    dialog.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(requests).toEqual(["escape"]);
    behavior.dispose();
  });

  it("uses the dialog rectangle instead of the event target", () => {
    const dialog = document.createElement("dialog");
    setDialogRect(dialog);
    expect(isPointerOutsideDialog(dialog, { clientX: 99, clientY: 200 })).toBe(
      true,
    );
    expect(isPointerOutsideDialog(dialog, { clientX: 200, clientY: 200 })).toBe(
      false,
    );
  });

  it("does not turn composing Escape into a dialog cancellation", async () => {
    const dialog = document.createElement("dialog");
    const input = document.createElement("input");
    dialog.append(input);
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    const requests: string[] = [];
    const behavior = new ModalCancelBehavior({
      dialog,
      getSnapshot: () => "value",
      onCancelRequest: (reason) => requests.push(reason),
    });
    behavior.install();

    const composingEscape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(composingEscape, "isComposing", { value: true });
    input.dispatchEvent(composingEscape);
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));

    const keyCodeEscape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(keyCodeEscape, "keyCode", { value: 229 });
    input.dispatchEvent(keyCodeEscape);
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));

    expect(requests).toEqual([]);
    await Promise.resolve();
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(requests).toEqual(["escape"]);
    behavior.dispose();
  });
});

describe("input dialog cancellation", () => {
  it("keeps clean Link dialogs dismissible and confirms dirty backdrop/Cancel requests", () => {
    const { root } = makeApp();
    const button = root.querySelector<HTMLButtonElement>(
      '[data-testid="toolbar-link"]',
    )!;
    button.click();
    const dialog = root.querySelector<HTMLDialogElement>(
      'dialog[aria-labelledby="mm-link-dialog-title"]',
    )!;
    setDialogRect(dialog);
    const [url, text] = Array.from(
      dialog.querySelectorAll<HTMLInputElement>("input"),
    );
    expect(dialog.open).toBe(true);

    dialog.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        clientX: 200,
        clientY: 200,
      }),
    );
    expect(dialog.open).toBe(true);
    changeInput(url!, "./changed.md");
    changeInput(text!, "Changed text");
    clickBackdrop();
    expect(dialog.open).toBe(true);
    expect(confirmation(root)).not.toBeNull();

    root
      .querySelector<HTMLButtonElement>(
        ".mm-discard-changes-dialog button:not([type=submit])",
      )
      ?.click();
    expect(dialog.open).toBe(true);
    expect(url!.value).toBe("./changed.md");
    expect(document.activeElement).toBe(url);
    expect(confirmation(root)).toBeNull();

    dialog
      .querySelector<HTMLButtonElement>(
        ".mm-dialog-actions button:not([type=submit])",
      )
      ?.click();
    expect(confirmation(root)).not.toBeNull();
    discard(root);
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(button);

    button.click();
    const cleanDialog = root.querySelector<HTMLDialogElement>(
      'dialog[aria-labelledby="mm-link-dialog-title"]',
    )!;
    cleanDialog
      .querySelector<HTMLButtonElement>(
        ".mm-dialog-actions button:not([type=submit])",
      )
      ?.click();
    expect(cleanDialog.open).toBe(false);
    expect(confirmation(root)).toBeNull();
  });

  it("uses the same dirty policy for Image Escape and lets confirmation Escape keep editing", () => {
    const { root } = makeApp();
    const button = root.querySelector<HTMLButtonElement>(
      '[data-testid="toolbar-image"]',
    )!;
    button.click();
    const dialog = root.querySelector<HTMLDialogElement>(
      'dialog[aria-labelledby="mm-image-dialog-title"]',
    )!;
    setDialogRect(dialog);
    const inputs = dialog.querySelectorAll<HTMLInputElement>("input");
    changeInput(inputs[1]!, "Changed alt");
    inputs[1]!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    const pending = confirmation(root);
    expect(pending).not.toBeNull();
    pending!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(dialog.open).toBe(true);
    expect(inputs[1]!.value).toBe("Changed alt");
    expect(confirmation(root)).toBeNull();
    dialog
      .querySelector<HTMLButtonElement>(
        ".mm-dialog-actions button:not([type=submit])",
      )
      ?.click();
    expect(confirmation(root)).not.toBeNull();
    discard(root);
  });

  it("snapshots Profile Feature defaults and changed fields", () => {
    const { root } = makeApp();
    const mathButton = root.querySelector<HTMLButtonElement>(
      '[data-profile-feature="math"]',
    )!;
    mathButton.click();
    const dialog = root.querySelector<HTMLDialogElement>(
      ".mm-profile-feature-dialog",
    )!;
    setDialogRect(dialog);
    const body = dialog.querySelector<HTMLTextAreaElement>(
      '[data-feature-field="body"]',
    )!;
    expect(body.value).toBe("x = y");
    clickBackdrop();
    expect(dialog.open).toBe(false);
    expect(confirmation(root)).toBeNull();

    mathButton.click();
    changeInput(body, "x = z");
    clickBackdrop();
    expect(confirmation(root)).not.toBeNull();
    discard(root);

    root
      .querySelector<HTMLButtonElement>('[data-profile-feature="mermaid"]')!
      .click();
    const mermaid = root.querySelector<HTMLDialogElement>(
      ".mm-profile-feature-dialog",
    )!;
    setDialogRect(mermaid);
    clickBackdrop();
    expect(mermaid.open).toBe(false);
    expect(confirmation(root)).toBeNull();
  });

  it("compares Table dimensions semantically when a selection returns to 3x3", () => {
    const { root } = makeApp();
    const button = root.querySelector<HTMLButtonElement>(
      '[data-testid="toolbar-table"]',
    )!;
    button.click();
    const dialog = root.querySelector<HTMLDialogElement>(".mm-table-dialog")!;
    setDialogRect(dialog);
    const [columns, rows] = Array.from(
      dialog.querySelectorAll<HTMLInputElement>('input[type="number"]'),
    );
    changeInput(columns!, "4");
    changeInput(rows!, "4");
    changeInput(columns!, "3");
    changeInput(rows!, "3");
    dialog
      .querySelector<HTMLButtonElement>(
        ".mm-dialog-actions button:not([type=submit])",
      )
      ?.click();
    expect(dialog.open).toBe(false);
    expect(confirmation(root)).toBeNull();

    button.click();
    const dirtyDialog =
      root.querySelector<HTMLDialogElement>(".mm-table-dialog")!;
    setDialogRect(dirtyDialog);
    const dirtyColumns = dirtyDialog.querySelector<HTMLInputElement>(
      'input[type="number"]',
    )!;
    changeInput(dirtyColumns, "4");
    dirtyDialog
      .querySelector<HTMLButtonElement>(
        ".mm-dialog-actions button:not([type=submit])",
      )
      ?.click();
    expect(confirmation(root)).not.toBeNull();
    discard(root);
  });

  it("does not add backdrop cancellation to the Emoji picker", () => {
    const { root } = makeApp();
    root
      .querySelector<HTMLButtonElement>('[data-testid="toolbar-emoji"]')!
      .click();
    const dialog = root.querySelector<HTMLDialogElement>(".mm-emoji-dialog")!;
    setDialogRect(dialog);
    clickBackdrop();
    expect(dialog.open).toBe(true);
    expect(confirmation(root)).toBeNull();
    dialog
      .querySelector<HTMLButtonElement>(
        ".mm-dialog-actions button:not([type=submit])",
      )
      ?.click();
  });
});
