import { afterEach, describe, expect, it, vi } from "vitest";
import { installModalSubmitShortcut } from "../../src/webview/modalSubmitShortcut";

type InsertDialogKind = "link" | "image" | "profile-feature" | "table";

const NON_MAC_PLATFORM = "Linux x86_64";
const MAC_PLATFORM = "MacIntel";

function appendInsertDialog(
  root: HTMLElement,
  kind: InsertDialogKind,
): {
  dialog: HTMLDialogElement;
  form: HTMLFormElement;
  input: HTMLInputElement;
  submit: HTMLButtonElement;
} {
  const dialog = document.createElement("dialog");
  if (kind === "link")
    dialog.setAttribute("aria-labelledby", "mm-link-dialog-title");
  else if (kind === "image")
    dialog.setAttribute("aria-labelledby", "mm-image-dialog-title");
  else if (kind === "profile-feature")
    dialog.className = "mm-input-dialog mm-profile-feature-dialog";
  else dialog.className = "mm-input-dialog mm-table-dialog";
  dialog.setAttribute("open", "");

  const form = document.createElement("form");
  const input = document.createElement("input");
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = kind === "table" ? "Insert table" : "Insert";
  form.append(input, submit);
  dialog.append(form);
  root.append(dialog);
  return { dialog, form, input, submit };
}

function replaceRequestSubmit(form: HTMLFormElement) {
  const requestSubmit = vi.fn();
  Object.defineProperty(form, "requestSubmit", {
    configurable: true,
    value: requestSubmit,
  });
  return requestSubmit;
}

async function flushShortcutSubmit(): Promise<void> {
  await Promise.resolve();
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("installModalSubmitShortcut", () => {
  it("submits each insertion/editing modal with Ctrl+Enter on Windows/Linux", async () => {
    const kinds: InsertDialogKind[] = [
      "link",
      "image",
      "profile-feature",
      "table",
    ];

    for (const kind of kinds) {
      const root = document.createElement("div");
      document.body.append(root);
      const { form, input, submit } = appendInsertDialog(root, kind);
      const requestSubmit = replaceRequestSubmit(form);
      const dispose = installModalSubmitShortcut(root, NON_MAC_PLATFORM);

      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(event);
      await flushShortcutSubmit();

      expect(event.defaultPrevented).toBe(true);
      expect(requestSubmit).toHaveBeenCalledTimes(1);
      expect(requestSubmit).toHaveBeenCalledWith(submit);
      dispose();
      root.remove();
    }
  });

  it("submits with Command+Enter on macOS", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const { form, input, submit } = appendInsertDialog(root, "image");
    const requestSubmit = replaceRequestSubmit(form);
    const dispose = installModalSubmitShortcut(root, MAC_PLATFORM);

    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(event);
    await flushShortcutSubmit();

    expect(event.defaultPrevented).toBe(true);
    expect(requestSubmit).toHaveBeenCalledTimes(1);
    expect(requestSubmit).toHaveBeenCalledWith(submit);
    dispose();
  });

  it("does not treat Ctrl+Enter as the macOS primary shortcut", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const { form, input } = appendInsertDialog(root, "image");
    const requestSubmit = replaceRequestSubmit(form);
    const dispose = installModalSubmitShortcut(root, MAC_PLATFORM);

    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await flushShortcutSubmit();

    expect(requestSubmit).not.toHaveBeenCalled();
    dispose();
  });

  it("submits even when a modal control stops keydown bubbling", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const { form, input, submit } = appendInsertDialog(root, "image");
    const requestSubmit = replaceRequestSubmit(form);
    input.addEventListener("keydown", (event) => event.stopPropagation());
    const dispose = installModalSubmitShortcut(root, NON_MAC_PLATFORM);

    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await flushShortcutSubmit();

    expect(requestSubmit).toHaveBeenCalledTimes(1);
    expect(requestSubmit).toHaveBeenCalledWith(submit);
    dispose();
  });

  it("keeps document-level capture scoped to the supplied editor root", async () => {
    const root = document.createElement("div");
    const otherRoot = document.createElement("div");
    document.body.append(root, otherRoot);
    const { form, input } = appendInsertDialog(otherRoot, "link");
    const requestSubmit = replaceRequestSubmit(form);
    const dispose = installModalSubmitShortcut(root, NON_MAC_PLATFORM);

    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await flushShortcutSubmit();

    expect(requestSubmit).not.toHaveBeenCalled();
    dispose();
  });

  it("does not submit destructive confirmation dialogs", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const dialog = document.createElement("dialog");
    dialog.className = "mm-input-dialog mm-code-language-confirm-dialog";
    dialog.setAttribute("open", "");
    const form = document.createElement("form");
    const input = document.createElement("input");
    const submit = document.createElement("button");
    submit.type = "submit";
    form.append(input, submit);
    dialog.append(form);
    root.append(dialog);
    const requestSubmit = replaceRequestSubmit(form);
    const dispose = installModalSubmitShortcut(root, NON_MAC_PLATFORM);

    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await flushShortcutSubmit();

    expect(requestSubmit).not.toHaveBeenCalled();
    dispose();
  });

  it("ignores non-shortcut, composing, and repeated key events", async () => {
    const ignoredEvents: KeyboardEventInit[] = [
      {},
      { ctrlKey: true, shiftKey: true },
      { ctrlKey: true, altKey: true },
      { metaKey: true },
      { ctrlKey: true, metaKey: true },
      { ctrlKey: true, isComposing: true },
      { ctrlKey: true, repeat: true },
    ];

    for (const modifiers of ignoredEvents) {
      const root = document.createElement("div");
      document.body.append(root);
      const { form, input } = appendInsertDialog(root, "table");
      const requestSubmit = replaceRequestSubmit(form);
      const dispose = installModalSubmitShortcut(root, NON_MAC_PLATFORM);

      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
          ...modifiers,
        }),
      );
      await flushShortcutSubmit();

      expect(requestSubmit).not.toHaveBeenCalled();
      dispose();
      root.remove();
    }
  });

  it("does not submit when the primary action is disabled", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const { form, input, submit } = appendInsertDialog(root, "table");
    submit.disabled = true;
    const requestSubmit = replaceRequestSubmit(form);
    const dispose = installModalSubmitShortcut(root, NON_MAC_PLATFORM);

    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await flushShortcutSubmit();

    expect(requestSubmit).not.toHaveBeenCalled();
    dispose();
  });
});
