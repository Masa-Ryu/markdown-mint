import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TextSelection,
  type EditorState,
  type Transaction,
} from "prosemirror-state";
import { Fragment } from "prosemirror-model";
import {
  createEditorApp,
  type MarkdownEditorApp,
} from "../../src/webview/editor";
import { getStarterState } from "../../src/webview/starter";
import {
  parseMarkdown,
  renderMarkdown,
  schema,
  serializeMarkdown,
} from "../../src/core";

const apps: MarkdownEditorApp[] = [];

function makeApp(
  markdown = "hello world",
  profile: "github" | "gitlab" = "github",
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
    initialDocument: { markdown, version: 1, profile },
  });
  apps.push(app);
  return { app, root, messages };
}

function edits(messages: unknown[]): Array<Record<string, unknown>> {
  return messages.filter(
    (message): message is Record<string, unknown> =>
      typeof message === "object" &&
      message !== null &&
      (message as { type?: unknown }).type === "edit",
  );
}

function rect(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    left: 0,
    right: 640,
    width: 640,
    height: bottom - top,
  } as DOMRect;
}

function clickBlank(stage: HTMLElement, clientY: number): void {
  stage.dispatchEvent(
    new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      clientY,
    }),
  );
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
});

afterEach(() => {
  for (const app of apps) app.destroy();
  apps.length = 0;
  document.body.replaceChildren();
});

describe("table exit and blank-space editing", () => {
  it("leaves a final table through ArrowDown without serializing its trailing target", () => {
    const { app, root, messages } = makeApp("Before");
    app.view.dispatch(
      app.view.state.tr.setSelection(TextSelection.atEnd(app.view.state.doc)),
    );
    const tableButton = root.querySelector<HTMLButtonElement>(
      '[data-testid="toolbar-table"]',
    )!;
    tableButton.click();
    const dialog = root.querySelector<HTMLDialogElement>(".mm-table-dialog")!;
    dialog.querySelector<HTMLButtonElement>(".mm-dialog-primary")!.click();

    const table = root.querySelector<HTMLTableElement>("table")!;
    const finalCell = table.querySelector<HTMLTableCellElement>(
      "tbody tr:last-child td:last-child",
    )!;
    const cellPos = app.view.posAtDOM(finalCell, 0);
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.near(
          app.view.state.doc.resolve(
            cellPos + app.view.state.doc.nodeAt(cellPos)!.nodeSize - 1,
          ),
          -1,
        ),
      ),
    );
    const tableEdit = edits(messages).at(-1);
    app.receiveDocument({
      protocolVersion: 1,
      type: "document",
      markdown: String(tableEdit?.markdown ?? ""),
      version: 2,
      profile: "github",
      operationId: String(tableEdit?.operationId ?? ""),
      reason: "ack",
    });
    const beforeArrow = edits(messages).length;
    app.view.dom.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(edits(messages)).toHaveLength(beforeArrow);
    expect(app.view.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(app.view.state.selection.$from.node(-1).type.name).toBe("doc");
    expect(app.view.state.doc.lastChild?.type.name).toBe("paragraph");
    const source = root.querySelector<HTMLTextAreaElement>(
      ".mm-source-textarea",
    )!;
    expect(source.value).not.toMatch(/\n\s*$/);

    app.view.dispatch(app.view.state.tr.insertText("After table"));
    expect(edits(messages)).toHaveLength(beforeArrow + 1);
    expect(String(edits(messages).at(-1)?.markdown)).toContain("After table");
  });

  it("does not leave a multi-paragraph cell from its first paragraph", () => {
    const { app, root } = makeApp("| A |\n| --- |\n| B |");
    const cell = root.querySelector<HTMLTableCellElement>("tbody td")!;
    const cellPos = app.view.posAtDOM(cell, 0) - 1;
    const cellNode = app.view.state.doc.nodeAt(cellPos)!;
    const paragraph = schema.nodes.paragraph!;
    const replacement = Fragment.fromArray([
      paragraph.create(null, schema.text("first")),
      paragraph.create(null, schema.text("last")),
    ]);
    const replacementCell = schema.nodes.table_cell!.create(
      cellNode.attrs,
      replacement,
    );
    app.view.dispatch(
      app.view.state.tr.replaceWith(
        cellPos,
        cellPos + cellNode.nodeSize,
        replacementCell,
      ),
    );
    const updatedCell = root.querySelector<HTMLTableCellElement>("tbody td")!;
    const paragraphs = updatedCell.querySelectorAll<HTMLParagraphElement>("p");
    const firstPos = app.view.posAtDOM(paragraphs[0]!, 0);
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(
          app.view.state.doc,
          app.view.state.doc.resolve(firstPos).end(),
        ),
      ),
    );
    type ExitCommand = (
      state: EditorState,
      dispatch?: (transaction: Transaction) => void,
    ) => boolean;
    const exitAtEnd = (
      app as unknown as {
        exitTableAtEnd: ExitCommand;
      }
    ).exitTableAtEnd.bind(app);
    expect(exitAtEnd(app.view.state)).toBe(false);
    expect(app.view.state.selection.$from.parent.textContent).toBe("first");

    const lastPos = app.view.posAtDOM(paragraphs[1]!, 0);
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(
          app.view.state.doc,
          app.view.state.doc.resolve(lastPos).end(),
        ),
      ),
    );
    expect(
      exitAtEnd(app.view.state, (transaction) =>
        app.view.dispatch(transaction),
      ),
    ).toBe(true);
    expect(app.view.state.selection.$from.node(-1).type.name).toBe("doc");
    expect(app.view.state.doc.lastChild?.type.name).toBe("paragraph");
  });

  it("places temporary blank lines below content without an edit and discards them on a return click", () => {
    const { app, root, messages } = makeApp("Body");
    const editor = root.querySelector<HTMLElement>(".ProseMirror")!;
    const body = editor.querySelector<HTMLElement>("p")!;
    body.getBoundingClientRect = () => rect(100, 124);
    const stage = root.querySelector<HTMLElement>(".mm-stage")!;

    clickBlank(stage, 220);
    expect(app.view.state.doc.childCount).toBeGreaterThan(1);
    expect(edits(messages)).toHaveLength(0);
    expect(
      root.querySelector<HTMLTextAreaElement>(".mm-source-textarea")!.value,
    ).toBe("Body");

    const bodyPos = app.view.posAtDOM(body, 0);
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.near(app.view.state.doc.resolve(bodyPos + 1), 1),
      ),
    );
    expect(app.view.state.doc.childCount).toBe(1);
    expect(edits(messages)).toHaveLength(0);
    expect(
      root.querySelector<HTMLTextAreaElement>(".mm-source-textarea")!.value,
    ).toBe("Body");
  });

  it("commits temporary blank space when the first character is typed", () => {
    const { app, root, messages } = makeApp("Body");
    const editor = root.querySelector<HTMLElement>(".ProseMirror")!;
    const body = editor.querySelector<HTMLElement>("p")!;
    body.getBoundingClientRect = () => rect(100, 124);
    const stage = root.querySelector<HTMLElement>(".mm-stage")!;

    clickBlank(stage, 220);
    expect(edits(messages)).toHaveLength(0);

    app.view.dispatch(app.view.state.tr.insertText("typed"));

    expect(edits(messages)).toHaveLength(1);
    expect(String(edits(messages)[0]?.markdown)).toContain("Body");
    expect(String(edits(messages)[0]?.markdown)).toContain("typed");
    expect(
      root.querySelector<HTMLTextAreaElement>(".mm-source-textarea")!.value,
    ).toContain("typed");
  });

  it("preserves an untouched blank starter source when temporary space is cancelled", () => {
    const { app, root, messages } = makeApp("");
    const editor = root.querySelector<HTMLElement>(".ProseMirror")!;
    const heading = editor.querySelector<HTMLElement>("h1")!;
    heading.getBoundingClientRect = () => rect(100, 142);
    const stage = root.querySelector<HTMLElement>(".mm-stage")!;

    clickBlank(stage, 240);
    expect(app.view.state.doc.childCount).toBeGreaterThan(1);
    expect(getStarterState(app.view.state)).toMatchObject({
      active: true,
      untouched: true,
    });
    expect(
      root.querySelector<HTMLTextAreaElement>(".mm-source-textarea")!.value,
    ).toBe("");
    expect(edits(messages)).toHaveLength(0);

    const headingPos = app.view.posAtDOM(heading, 0);
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.near(app.view.state.doc.resolve(headingPos), 1),
      ),
    );
    expect(app.view.state.doc.childCount).toBe(1);
    expect(getStarterState(app.view.state)).toMatchObject({
      active: true,
      untouched: true,
    });
    expect(root.querySelector("h1.mm-starter-title")).not.toBeNull();
    expect(
      root.querySelector<HTMLTextAreaElement>(".mm-source-textarea")!.value,
    ).toBe("");
    expect(edits(messages)).toHaveLength(0);
  });
});

describe("emoji picker", () => {
  it("searches common emoji and inserts at the saved selection", () => {
    const { app, root, messages } = makeApp("hello");
    app.view.dispatch(
      app.view.state.tr.setSelection(TextSelection.atEnd(app.view.state.doc)),
    );
    const button = root.querySelector<HTMLButtonElement>(
      '[data-testid="toolbar-emoji"]',
    )!;
    button.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );
    button.click();
    const dialog = root.querySelector<HTMLDialogElement>(".mm-emoji-dialog")!;
    expect(dialog.open || dialog.hasAttribute("open")).toBe(true);
    const search = dialog.querySelector<HTMLInputElement>(".mm-emoji-search")!;
    search.value = "rocket";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    const rocket =
      dialog.querySelector<HTMLButtonElement>('[data-emoji="🚀"]')!;
    expect(rocket.getAttribute("aria-label")).toContain("rocket");
    rocket.click();
    expect(edits(messages)).toHaveLength(1);
    expect(String(edits(messages)[0]?.markdown)).toContain("hello🚀");
    expect(dialog.open || dialog.hasAttribute("open")).toBe(false);
  });

  it("cancels without editing and rejects a stale saved selection", () => {
    const { root, messages } = makeApp("hello");
    const button = root.querySelector<HTMLButtonElement>(
      '[data-testid="toolbar-emoji"]',
    )!;
    button.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );
    button.click();
    const dialog = root.querySelector<HTMLDialogElement>(".mm-emoji-dialog")!;
    dialog.querySelector<HTMLButtonElement>('[data-emoji="😀"]')!.click();
    expect(edits(messages)).toHaveLength(1);

    const second = makeApp("hello");
    const secondButton = second.root.querySelector<HTMLButtonElement>(
      '[data-testid="toolbar-emoji"]',
    )!;
    secondButton.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );
    secondButton.click();
    const secondDialog =
      second.root.querySelector<HTMLDialogElement>(".mm-emoji-dialog")!;
    second.app.view.dispatch(second.app.view.state.tr.insertText("!"));
    secondDialog.querySelector<HTMLButtonElement>('[data-emoji="🚀"]')!.click();
    expect(edits(second.messages)).toHaveLength(1);
    expect(second.root.querySelector(".mm-status")?.textContent).toContain(
      "document changed",
    );
    expect(document.activeElement).toBe(secondButton);
  });
});

describe("task and image presentation", () => {
  it("renders a GitLab mixed task as an indeterminate checkbox and resolves it", async () => {
    const { app, root, messages } = makeApp("- [~] partially done", "gitlab");
    const checkbox = root.querySelector<HTMLInputElement>(".mm-task-checkbox")!;
    const source = root.querySelector<HTMLTextAreaElement>(
      ".mm-source-textarea",
    )!;
    const initialSource = source.value;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(source.value).toBe(initialSource);
    expect(checkbox.indeterminate).toBe(true);
    expect(checkbox.dataset.taskState).toBe("mixed");
    expect(checkbox.getAttribute("aria-checked")).toBe("mixed");

    checkbox.click();

    expect(app.view.state.doc.firstChild?.firstChild?.attrs.checked).toBe(true);
    expect(String(edits(messages).at(-1)?.markdown)).toContain("- [x]");
  });

  it("applies parsed image dimensions to the editable image node", () => {
    const { app, root } = makeApp(
      "![diagram](https://example.test/diagram.png){width=300px height=120px}",
      "gitlab",
    );
    const image = root.querySelector<HTMLImageElement>(".ProseMirror img")!;

    expect(image.getAttribute("width")).toBe("300px");
    expect(image.getAttribute("height")).toBe("120px");
    expect(image.style.width).toBe("300px");
    expect(image.style.height).toBe("120px");
    expect(app.view.state.doc.firstChild?.firstChild?.attrs).toMatchObject({
      width: "300px",
      height: "120px",
    });
  });
});

describe("toolbar affordances", () => {
  it("uses distinct SVG shapes for image and table insertion", () => {
    const { root } = makeApp();
    const image = root.querySelector<SVGSVGElement>(
      '[data-testid="toolbar-image"] .mm-toolbar-icon',
    )!;
    const table = root.querySelector<SVGSVGElement>(
      '[data-testid="toolbar-table"] .mm-toolbar-icon',
    )!;
    expect(image).not.toBeNull();
    expect(table).not.toBeNull();
    expect(image.innerHTML).not.toBe(table.innerHTML);
  });
});
