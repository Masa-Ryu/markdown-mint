import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextSelection } from "prosemirror-state";
import {
  schema,
  parseMarkdown,
  renderMarkdown,
  serializeMarkdown,
} from "../../src/core";
import {
  createEditorApp,
  type MarkdownEditorApp,
} from "../../src/webview/editor";

let app: MarkdownEditorApp;
let root: HTMLElement;
let messages: Array<{ type?: string }>;
const globals = globalThis as unknown as Record<string, unknown>;
const button = (name: string) =>
  Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
    (item) => item.textContent === name && item.closest("dialog")?.open,
  )!;
const dialog = () =>
  root.querySelector<HTMLDialogElement>(".mm-profile-feature-dialog")!;
const input = () =>
  dialog().querySelector<HTMLTextAreaElement>('[data-feature-field="body"]')!;
const editCount = () =>
  messages.filter((message) => message.type === "edit").length;
const submit = () =>
  dialog()
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(320);
}

beforeEach(() => {
  vi.useFakeTimers();
  if (!Range.prototype.getClientRects)
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [],
    });
  if (!Range.prototype.getBoundingClientRect)
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(),
    });
  root = document.createElement("div");
  document.body.append(root);
  messages = [];
  globals.markdownMintMermaid = {
    parse: async () => ({ diagramType: "flowchart" }),
    render: () => "<svg><text>diagram</text></svg>",
  };
  app = createEditorApp({
    root,
    core: { schema, parseMarkdown, renderMarkdown, serializeMarkdown },
    vscode: {
      postMessage: (message) => messages.push(message as { type?: string }),
    },
    initialDocument: { markdown: "Before", version: 1, profile: "github" },
  });
});
afterEach(async () => {
  app?.destroy();
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  delete globals.markdownMintMermaid;
  document.body.replaceChildren();
});
const open = () =>
  root
    .querySelector<HTMLButtonElement>('button[data-profile-feature="mermaid"]')!
    .click();

describe("Mermaid modal integration guards", () => {
  it("keeps candidate validation separate from draft commit and dirty state", async () => {
    open();
    await settle();
    expect(
      dialog().querySelector<HTMLButtonElement>('button[type="submit"]')!
        .disabled,
    ).toBe(true);
    submit();
    expect(editCount()).toBe(0);
    root
      .querySelector<HTMLElement>('[data-template-id="sequence-alternative"]')!
      .click();
    await settle();
    expect(input().value).toBe("flowchart TD\n    A[Start] --> B[End]");
    button("Cancel").click();
    expect(dialog().open).toBe(false);
    expect(root.querySelector(".mm-discard-changes-dialog")).toBeNull();
    expect(editCount()).toBe(0);
  });

  it("confirms loss against the opening snapshot across multiple pristine replacements", async () => {
    open();
    button("Next: Edit code").click();
    button("← Templates").click();
    root
      .querySelector<HTMLElement>('[data-template-id="state-workflow"]')!
      .click();
    button("Next: Edit code").click();
    expect(
      root.querySelector<HTMLElement>(".mm-mermaid-replacement-confirmation")!
        .hidden,
    ).toBe(true);
    button("Cancel").click();
    expect(root.querySelector(".mm-discard-changes-dialog")).not.toBeNull();
    expect(editCount()).toBe(0);
    button("Discard").click();
    open();
    expect(input().value).toContain("A[Start] --> B[End]");
    expect(
      dialog().querySelector<HTMLButtonElement>(
        '[aria-label="Back to Mermaid templates"]',
      )!.hidden,
    ).toBe(true);
    expect(
      Array.from(dialog().querySelectorAll("button")).some((item) =>
        item.textContent?.includes("Undo replacement"),
      ),
    ).toBe(false);
  });

  it("shows template navigation only in the active editor and guards confirmation and IME", async () => {
    open();
    const templates = dialog().querySelector<HTMLButtonElement>(
      '[aria-label="Back to Mermaid templates"]',
    )!;
    expect(templates.hidden).toBe(true);
    button("Next: Edit code").click();
    await settle();
    expect(templates.hidden).toBe(false);
    expect(templates.textContent).toBe("← Templates");
    expect(editCount()).toBe(0);
    templates.click();
    expect(
      root.querySelector<HTMLElement>(".mm-mermaid-template-picker")!.hidden,
    ).toBe(false);
    expect(templates.hidden).toBe(true);
    button("Back to code").click();
    expect(templates.hidden).toBe(false);
    input().value += "\n%% edited in the code editor";
    input().dispatchEvent(new Event("input", { bubbles: true }));
    await settle();

    input().dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    expect(templates.disabled).toBe(true);
    templates.click();
    expect(
      root.querySelector<HTMLElement>(".mm-mermaid-template-picker")!.hidden,
    ).toBe(true);
    input().dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true }),
    );
    await vi.advanceTimersByTimeAsync(60);

    templates.click();
    root
      .querySelector<HTMLElement>('[data-template-id="state-workflow"]')!
      .click();
    button("Next: Edit code").click();
    expect(
      root.querySelector<HTMLElement>(".mm-mermaid-replacement-confirmation")!
        .hidden,
    ).toBe(false);
    expect(templates.hidden).toBe(true);
    button("Keep current code").click();
    expect(templates.hidden).toBe(true);
    expect(editCount()).toBe(0);
  });

  it("preserves selected Unicode code and requires confirmation before replacing it", () => {
    app.view.dispatch(
      app.view.state.tr.insertText(
        "日本語の図",
        1,
        app.view.state.doc.content.size - 1,
      ),
    );
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(
          app.view.state.doc,
          1,
          app.view.state.doc.content.size - 1,
        ),
      ),
    );
    const before = editCount();
    open();
    expect(input().value).toBe("日本語の図");
    expect(
      root.querySelector<HTMLElement>(".mm-mermaid-template-picker")!.hidden,
    ).toBe(true);
    button("← Templates").click();
    button("Next: Edit code").click();
    expect(input().value).toBe("日本語の図");
    expect(
      root.querySelector<HTMLElement>(".mm-mermaid-replacement-confirmation")!
        .hidden,
    ).toBe(false);
    button("Keep current code").click();
    expect(input().value).toBe("日本語の図");
    expect(editCount()).toBe(before);
  });

  it("allows syntactically valid source when only rendering fails", async () => {
    globals.markdownMintMermaid = {
      parse: async () => ({ diagramType: "flowchart" }),
      render: () => {
        throw new Error("render failed");
      },
    };
    open();
    button("Next: Edit code").click();
    await settle();
    expect(
      root.querySelector<HTMLElement>(".mm-mermaid-preview")!.dataset
        .previewState,
    ).toBe("failed");
    expect(
      root.querySelector<HTMLElement>(".mm-mermaid-validation-status")!.dataset
        .validationState,
    ).toBe("valid");
    button("Insert diagram").click();
    expect(editCount()).toBe(1);
    expect(dialog().open).toBe(false);
  });

  it("deduplicates validation submits and ignores the result of a closed session", async () => {
    let resolveParse!: (value: { diagramType: string }) => void;
    const parse = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveParse = resolve;
        }),
    );
    globals.markdownMintMermaid = { parse, render: () => "<svg />" };
    open();
    button("Next: Edit code").click();
    submit();
    submit();
    expect(parse).toHaveBeenCalledTimes(1);
    button("Cancel").click();
    open();
    resolveParse({ diagramType: "flowchart" });
    await vi.advanceTimersByTimeAsync(0);
    expect(editCount()).toBe(0);
    expect(
      root.querySelector<HTMLElement>(".mm-mermaid-template-picker")!.hidden,
    ).toBe(false);
    expect(input().value).toBe("flowchart TD\n    A[Start] --> B[End]");
  });

  it("blocks composition commits and revalidates after composition ends", async () => {
    open();
    button("Next: Edit code").click();
    await settle();
    input().dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    submit();
    expect(editCount()).toBe(0);
    input().dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true }),
    );
    await settle();
    expect(button("Insert diagram").disabled).toBe(false);
    button("Insert diagram").click();
    expect(editCount()).toBe(1);
  });
});
