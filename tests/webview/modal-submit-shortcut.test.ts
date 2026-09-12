import { afterEach, describe, expect, it, vi } from "vitest";
import { installModalSubmitShortcut } from "../../src/webview/modalSubmitShortcut";

type InsertDialogKind = "link" | "image" | "profile-feature" | "table";

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

afterEach(() => {
  document.body.replaceChildren();
});

describe("installModalSubmitShortcut", () => {
  it.each<InsertDialogKind>([
    "link",
    "image",
    "profile-feature",
    "table",
  ])("submits the %s modal with Ctrl+Enter", (kind) => {
    const root = document.createElement("div");
    document.body.append(root);
    const { form, input, submit } = appendInsertDialog(root, kind);
    const requestSubmit = vi.fn();
    Object.defineProperty(form, "requestSubmit", {
      configurable: true,
      value: requestSubmit,
    });
    const dispose = installModalSubmitShortcut(root);

    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(requestSubmit).toHaveBeenCalledTimes(1);
    expect(requestSubmit).toHaveBeenCalledWith(submit);
    dispose();
  });

  it("does not submit destructive confirmation dialogs", () => {
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
    const requestSubmit = vi.fn();
    Object.defineProperty(form, "requestSubmit", {
      configurable: true,
      value: requestSubmit,
    });
    const dispose = installModalSubmitShortcut(root);

    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(requestSubmit).not.toHaveBeenCalled();
    dispose();
  });

  it.each([
    ["plain Enter", {}],
    ["Ctrl+Shift+Enter", { ctrlKey: true, shiftKey: true }],
    ["Ctrl+Alt+Enter", { ctrlKey: true, altKey: true }],
    ["Command+Enter", { metaKey: true }],
    ["IME composition", { ctrlKey: true, isComposing: true }],
    ["key repeat", { ctrlKey: true, repeat: true }],
  ] as const)("ignores %s", (_label, modifiers) => {
    const root = document.createElement("div");
    document.body.append(root);
    const { form, input } = appendInsertDialog(root, "table");
    const requestSubmit = vi.fn();
    Object.defineProperty(form, "requestSubmit", {
      configurable: true,
      value: requestSubmit,
    });
    const dispose = installModalSubmitShortcut(root);

    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
        ...modifiers,
      }),
    );

    expect(requestSubmit).not.toHaveBeenCalled();
    dispose();
  });

  it("does not submit when the primary action is disabled", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const { form, input, submit } = appendInsertDialog(root, "table");
    submit.disabled = true;
    const requestSubmit = vi.fn();
    Object.defineProperty(form, "requestSubmit", {
      configurable: true,
      value: requestSubmit,
    });
    const dispose = installModalSubmitShortcut(root);

    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(requestSubmit).not.toHaveBeenCalled();
    dispose();
  });
});
