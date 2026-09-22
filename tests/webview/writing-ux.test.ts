import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Node as PMNode } from "prosemirror-model";
import { CellSelection } from "prosemirror-tables";
import { NodeSelection, TextSelection } from "prosemirror-state";
import {
  parseMarkdown,
  renderMarkdown,
  schema,
  serializeMarkdown,
} from "../../src/core";
import { BlockBoundarySelection } from "../../src/webview/blockBoundary";
import { PROTOCOL_VERSION } from "../../src/shared/protocol";
import {
  createEditorApp,
  type DocumentMessage,
  type MarkdownEditorApp,
} from "../../src/webview/editor";

const apps: MarkdownEditorApp[] = [];

function makeApp(
  markdown = "hello world",
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

function editMessages(messages: unknown[]): Array<Record<string, unknown>> {
  return messages.filter(
    (message): message is Record<string, unknown> =>
      typeof message === "object" &&
      message !== null &&
      (message as { type?: unknown }).type === "edit",
  );
}

function messagesOfType(
  messages: unknown[],
  type: string,
): Array<Record<string, unknown>> {
  return messages.filter(
    (message): message is Record<string, unknown> =>
      typeof message === "object" &&
      message !== null &&
      (message as { type?: unknown }).type === type,
  );
}

function quoteButton(root: HTMLElement): HTMLButtonElement {
  return root.querySelector<HTMLButtonElement>(
    '[data-testid="toolbar-quote"]',
  )!;
}

function clickToolbarButton(button: HTMLButtonElement): MouseEvent {
  const mousedown = new MouseEvent("mousedown", {
    bubbles: true,
    cancelable: true,
  });
  button.dispatchEvent(mousedown);
  button.click();
  return mousedown;
}

function emptyParagraphCount(doc: PMNode): number {
  let count = 0;
  doc.descendants((node) => {
    if (node.type.name === "paragraph" && node.content.size === 0) count += 1;
  });
  return count;
}

function paragraphTextPosition(
  doc: PMNode,
  paragraphIndex: number,
  offset: number,
): number {
  let position = 0;
  for (let index = 0; index < paragraphIndex; index += 1)
    position += doc.child(index).nodeSize;
  return position + 1 + offset;
}

function topLevelNodeStart(doc: PMNode, index: number): number {
  let position = 0;
  for (let childIndex = 0; childIndex < index; childIndex += 1)
    position += doc.child(childIndex).nodeSize;
  return position;
}

function firstTextRange(
  doc: PMNode,
  predicate: (node: PMNode) => boolean,
): { from: number; to: number } {
  let range: { from: number; to: number } | undefined;
  doc.descendants((node, position) => {
    if (!range && node.isText && node.text && predicate(node))
      range = { from: position, to: position + node.nodeSize };
  });
  if (!range) throw new Error("Expected a matching text node");
  return range;
}

function firstNodePosition(doc: PMNode, nodeName: string): number {
  let position: number | undefined;
  doc.descendants((node, nodePosition) => {
    if (position === undefined && node.type.name === nodeName)
      position = nodePosition;
  });
  if (position === undefined) throw new Error(`Missing ${nodeName} node`);
  return position;
}

function selectTrailingEmptyParagraph(app: MarkdownEditorApp): void {
  const end = TextSelection.atEnd(app.view.state.doc);
  app.view.dispatch(app.view.state.tr.setSelection(end).split(end.from));
  focusTrailingEmptyParagraph(app);
}

function focusTrailingEmptyParagraph(app: MarkdownEditorApp): void {
  const paragraphIndex = app.view.state.doc.childCount - 1;
  const position = paragraphTextPosition(app.view.state.doc, paragraphIndex, 0);
  app.view.dispatch(
    app.view.state.tr.setSelection(
      TextSelection.create(app.view.state.doc, position),
    ),
  );
}

function settleLastEdit(
  app: MarkdownEditorApp,
  messages: unknown[],
  version = 2,
): void {
  acknowledgeLastEdit(app, messages, version);
}

function prepareTrailingEmptyParagraph(
  app: MarkdownEditorApp,
  messages: unknown[],
): void {
  selectTrailingEmptyParagraph(app);
  settleLastEdit(app, messages);
  focusTrailingEmptyParagraph(app);
}

function insertPopupItems(root: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    root.querySelectorAll<HTMLButtonElement>(
      ".mm-empty-line-popup button[role='menuitem']",
    ),
  ).filter((item) => !item.dataset.insertProfileFeature);
}

function visibleInsertPopupItems(root: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    root.querySelectorAll<HTMLButtonElement>(
      ".mm-empty-line-popup button[role='menuitem']",
    ),
  ).filter((item) => !item.hidden && !item.disabled);
}

function openEmptyLinePopup(root: HTMLElement): {
  panel: HTMLElement;
  plus: HTMLButtonElement;
} {
  const plus = root.querySelector<HTMLButtonElement>(".mm-empty-line-insert")!;
  plus.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
  );
  plus.click();
  return {
    panel: root.querySelector<HTMLElement>(".mm-empty-line-popup")!,
    plus,
  };
}

function dispatchPopupKey(panel: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  panel.dispatchEvent(event);
  return event;
}

function dispatchTextInput(app: MarkdownEditorApp, text: string): boolean {
  const { from, to } = app.view.state.selection;
  const fallback = () => app.view.state.tr.insertText(text, from, to);
  const handled = app.view.someProp("handleTextInput", (handler) =>
    handler(app.view, from, to, text, fallback),
  );
  if (!handled) app.view.dispatch(fallback());
  return handled === true;
}

function dispatchEditorKey(
  app: MarkdownEditorApp,
  key: string,
  options: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    ...options,
    bubbles: true,
    cancelable: true,
  });
  app.view.dom.dispatchEvent(event);
  return event;
}

function dispatchFocusedKey(
  key: string,
  options: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    ...options,
    bubbles: true,
    cancelable: true,
  });
  document.activeElement?.dispatchEvent(event);
  return event;
}

function hostDocument(
  markdown: string,
  version: number,
  options: { operationId?: string; reason?: string } = {},
): DocumentMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "document",
    markdown,
    version,
    profile: "github",
    ...options,
  };
}

function acknowledgeLastEdit(
  app: MarkdownEditorApp,
  messages: unknown[],
  version: number,
): void {
  const edit = editMessages(messages).at(-1);
  if (!edit) throw new Error("Expected a pending edit");
  app.receiveDocument(
    hostDocument(String(edit.markdown), version, {
      operationId: String(edit.operationId),
      reason: "ack",
    }),
  );
}

function rejectLastEdit(
  messages: unknown[],
  currentMarkdown = "authoritative",
  currentVersion = 2,
): void {
  const edit = editMessages(messages).at(-1);
  if (!edit) throw new Error("Expected a pending edit");
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        protocolVersion: PROTOCOL_VERSION,
        type: "edit-rejected",
        operationId: String(edit.operationId),
        reason: "invalid",
        message: "The edit could not be applied.",
        currentMarkdown,
        currentVersion,
        draftMarkdown: String(edit.markdown),
      },
    }),
  );
}

function setSelectionGeometry(app: MarkdownEditorApp): void {
  Object.defineProperty(app.view, "coordsAtPos", {
    configurable: true,
    value: (position: number) => ({
      top: 30,
      bottom: 50,
      left: 12 + position * 2,
      right: 14 + position * 2,
    }),
  });
}

function setElementRect(
  element: Element,
  rect: { top: number; bottom: number; left: number; width?: number },
): void {
  const width = rect.width ?? 640;
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.left + width,
      width,
      height: rect.bottom - rect.top,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    }),
  });
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
  for (const app of apps) app.destroy();
  apps.length = 0;
  document.body.replaceChildren();
});

describe("bounded writing controls", () => {
  it("keeps every writing command visible in the requested toolbar order", () => {
    const { root, messages } = makeApp();
    const toolbar = root.querySelector<HTMLElement>(".mm-toolbar")!;

    expect(toolbar.querySelector('[data-mode="rich"]')).toBeNull();
    expect(toolbar.querySelector('[data-mode="preview"]')).toBeNull();
    const sourceButton = toolbar.querySelector<HTMLButtonElement>(
      '[data-mode="source"]',
    );
    expect(sourceButton).not.toBeNull();
    expect(toolbar.querySelector(".mm-toolbar-primary")?.lastElementChild).toBe(
      sourceButton,
    );
    const exportButton = toolbar.querySelector<HTMLButtonElement>(
      '[data-testid="toolbar-export-html"]',
    );
    expect(exportButton?.getAttribute("aria-label")).toBe("Export as HTML");
    expect(exportButton?.nextElementSibling).toBe(sourceButton);
    expect(sourceButton?.style.marginLeft).toBe("");
    expect(
      toolbar.querySelector<HTMLSelectElement>(".mm-profile-select")?.value,
    ).toBe("github");
    expect(
      toolbar.querySelector<HTMLOptionElement>('option[value="commonmark"]')
        ?.disabled,
    ).toBe(false);

    const labels = Array.from(
      toolbar.querySelectorAll<HTMLElement>(
        ".mm-heading-select, .mm-tool-button",
      ),
    ).map((element) => element.getAttribute("aria-label"));
    expect(labels).toEqual([
      "Heading level",
      "Bold",
      "Italic",
      "Strikethrough",
      "Inline code",
      "Insert link",
      "Insert image",
      "Bullet list",
      "Ordered list",
      "Task list",
      "Block quote",
      "Code block",
      "Insert table",
      "Horizontal rule",
      "Format Markdown",
    ]);
    expect(
      toolbar.querySelector<HTMLButtonElement>('[data-testid="toolbar-image"]')
        ?.dataset.tooltip,
    ).toBe("Insert image; Shift + drag an image to import");
    expect(toolbar.querySelector(".mm-popup-toggle")).toBeNull();
    for (const element of Array.from(
      toolbar.querySelectorAll<HTMLElement>(
        ".mm-heading-select, .mm-tool-button",
      ),
    ))
      expect(element.closest(".mm-popup-panel")).toBeNull();
    expect(editMessages(messages)).toHaveLength(0);
  });

  it("waits for the latest edit acknowledgement before requesting HTML export", () => {
    const { app, root, messages } = makeApp("hello world");
    const end = app.view.state.doc.content.size - 1;
    app.view.dispatch(app.view.state.tr.insertText(" updated", end));
    const pendingEdit = editMessages(messages).at(-1);
    expect(pendingEdit?.markdown).toContain("hello world updated");

    const exportButton = root.querySelector<HTMLButtonElement>(
      '[data-testid="toolbar-export-html"]',
    )!;
    clickToolbarButton(exportButton);
    expect(messagesOfType(messages, "export-html")).toHaveLength(0);

    acknowledgeLastEdit(app, messages, 2);
    expect(messagesOfType(messages, "export-html")).toContainEqual(
      expect.objectContaining({
        type: "export-html",
        baseVersion: 2,
      }),
    );
  });

  it("uses every supplied SVG asset in the toolbar and contextual menus", () => {
    const { root } = makeApp();
    const mainIcons: Array<[string, string]> = [
      ["toolbar-bold", "bold"],
      ["toolbar-italic", "italic"],
      ["toolbar-strike", "strikethrough"],
      ["toolbar-code", "inline-code"],
      ["toolbar-link", "link"],
      ["toolbar-image", "image"],
      ["toolbar-bullet-list", "bullet-list"],
      ["toolbar-ordered-list", "ordered-list"],
      ["toolbar-task-list", "checklist"],
      ["toolbar-quote", "blockquote"],
      ["toolbar-code-block", "code-block"],
      ["toolbar-table", "table"],
      ["toolbar-horizontal-rule", "divider"],
      ["toolbar-format", "format"],
    ];
    for (const [testId, iconName] of mainIcons) {
      const icon = root.querySelector<SVGSVGElement>(
        '[data-testid="' + testId + '"] .mm-toolbar-icon',
      );
      expect(icon).not.toBeNull();
      expect(icon?.dataset.icon).toBe(iconName);
      expect(icon?.getAttribute("width")).toBe("20");
      expect(icon?.getAttribute("height")).toBe("20");
      expect(icon?.outerHTML).not.toContain("#111827");
    }

    const selectionIcons: Array<[string, string]> = [
      ["selection-bold", "bold"],
      ["selection-italic", "italic"],
      ["selection-strike", "strikethrough"],
      ["selection-code", "inline-code"],
      ["selection-link", "link"],
    ];
    for (const [testId, iconName] of selectionIcons)
      expect(
        root.querySelector<SVGSVGElement>(
          '[data-testid="' + testId + '"] .mm-toolbar-icon',
        )?.dataset.icon,
      ).toBe(iconName);

    const popup = root.querySelector<HTMLElement>(".mm-empty-line-popup")!;
    expect(
      Array.from(popup.querySelectorAll<SVGSVGElement>(".mm-toolbar-icon")).map(
        (icon) => icon.dataset.icon,
      ),
    ).toEqual([
      "bullet-list",
      "ordered-list",
      "checklist",
      "blockquote",
      "code-block",
      "table",
      "image",
      "divider",
    ]);
    const menuItems = Array.from(
      popup.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'),
    ).filter((item) => !item.dataset.insertProfileFeature);
    expect(menuItems.every((item) => !item.hasAttribute("data-tooltip"))).toBe(
      true,
    );
    expect(menuItems.map((item) => item.getAttribute("aria-label"))).toEqual([
      "Bullet list",
      "Ordered list",
      "Task list",
      "Block quote",
      "Code block",
      "Insert table",
      "Insert image",
      "Horizontal rule",
    ]);
    expect(
      menuItems.map(
        (item) =>
          item
            .querySelector<HTMLElement>(".mm-toolbar-button-label")
            ?.textContent?.trim() ?? item.textContent?.trim(),
      ),
    ).toEqual([
      "Bullet list",
      "Ordered list",
      "Task",
      "Quote",
      "Code",
      "Table",
      "Image",
      "Horizontal rule",
    ]);
  });

  it("uses one stable tooltip for SVG hover, focus, and disabled menu items", () => {
    const { root, app } = makeApp("one", "commonmark");
    const tooltip = root.querySelector<HTMLElement>(".mm-tooltip")!;
    const bold = root.querySelector<HTMLButtonElement>(
      '[data-testid="toolbar-bold"]',
    )!;
    const icon = bold.querySelector<SVGElement>(".mm-toolbar-icon")!;

    expect(bold.getAttribute("title")).toBeNull();
    expect(bold.dataset.tooltip).toBe("Bold");
    icon.dispatchEvent(new Event("pointerover", { bubbles: true }));
    expect(tooltip.hidden).toBe(false);
    expect(tooltip.textContent).toBe("Bold");
    icon.dispatchEvent(new Event("pointerout", { bubbles: true }));
    expect(tooltip.hidden).toBe(true);

    bold.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(tooltip.textContent).toBe("Bold");
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(tooltip.hidden).toBe(true);

    const disabledTask = root.querySelector<HTMLButtonElement>(
      '[data-testid="toolbar-task-list"]',
    )!;
    expect(disabledTask.disabled).toBe(true);
    expect(disabledTask.getAttribute("title")).toBeNull();
    disabledTask.dispatchEvent(new Event("pointerover", { bubbles: true }));
    expect(tooltip.textContent).toBe("Task list");
    disabledTask.dispatchEvent(new Event("click", { bubbles: true }));
    expect(tooltip.hidden).toBe(true);
    app.destroy();
  });

  it("lets CommonMark be selected through the synchronized profile path", () => {
    const { app, root, messages } = makeApp("base");
    const profile =
      root.querySelector<HTMLSelectElement>(".mm-profile-select")!;
    const option = root.querySelector<HTMLOptionElement>(
      'option[value="commonmark"]',
    )!;
    expect(option.disabled).toBe(false);
    profile.value = "commonmark";
    profile.dispatchEvent(new Event("change", { bubbles: true }));
    const request = messagesOfType(messages, "set-profile")[0]!;
    expect(request).toMatchObject({
      profile: "commonmark",
      baseVersion: 1,
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(app.profile).toBe("github");
    app.receiveDocument({
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      markdown: "base",
      version: 2,
      profile: "commonmark",
      operationId: String(request.operationId),
      reason: "ack",
    });
    expect(app.profile).toBe("commonmark");
    expect(profile.value).toBe("commonmark");
    expect(option.disabled).toBe(false);
  });

  it("applies and removes the same list with a second toolbar click", () => {
    const { app, root, messages } = makeApp("one");
    const bullet = root.querySelector<HTMLButtonElement>(
      '[data-testid="toolbar-bullet-list"]',
    )!;
    bullet.click();
    expect(app.view.state.doc.firstChild?.type.name).toBe("bullet_list");
    expect(bullet.getAttribute("aria-pressed")).toBe("true");
    bullet.click();
    expect(app.view.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(bullet.getAttribute("aria-pressed")).toBe("false");
    expect(editMessages(messages)).toHaveLength(1);
  });

  it("keeps list active states exclusive as the selection changes list kind", () => {
    const { root } = makeApp("one");
    const bullet = root.querySelector<HTMLButtonElement>(
      '[data-testid="toolbar-bullet-list"]',
    )!;
    const ordered = root.querySelector<HTMLButtonElement>(
      '[data-testid="toolbar-ordered-list"]',
    )!;
    const task = root.querySelector<HTMLButtonElement>(
      '[data-testid="toolbar-task-list"]',
    )!;

    bullet.click();
    expect(bullet.getAttribute("aria-pressed")).toBe("true");
    expect(ordered.getAttribute("aria-pressed")).toBe("false");
    expect(task.getAttribute("aria-pressed")).toBe("false");

    ordered.click();
    expect(bullet.getAttribute("aria-pressed")).toBe("false");
    expect(ordered.getAttribute("aria-pressed")).toBe("true");
    expect(task.getAttribute("aria-pressed")).toBe("false");

    task.click();
    expect(bullet.getAttribute("aria-pressed")).toBe("false");
    expect(ordered.getAttribute("aria-pressed")).toBe("false");
    expect(task.getAttribute("aria-pressed")).toBe("true");

    task.click();
    expect(bullet.getAttribute("aria-pressed")).toBe("false");
    expect(ordered.getAttribute("aria-pressed")).toBe("false");
    expect(task.getAttribute("aria-pressed")).toBe("false");
  });

  it("synchronizes main and selection toolbar active states for inline marks", () => {
    const { app, root } = makeApp(
      "plain **bold** plain *italic* plain ~~strike~~ plain `code` plain [link](https://example.com) plain",
    );
    setSelectionGeometry(app);
    const marks = [
      ["strong", "toolbar-bold", "selection-bold"],
      ["em", "toolbar-italic", "selection-italic"],
      ["strike", "toolbar-strike", "selection-strike"],
      ["code", "toolbar-code", "selection-code"],
      ["link", "toolbar-link", "selection-link"],
    ] as const;
    const plainRange = firstTextRange(
      app.view.state.doc,
      (node) => node.marks.length === 0,
    );

    for (const [markName, mainTestId, selectionTestId] of marks) {
      const range = firstTextRange(app.view.state.doc, (node) =>
        node.marks.some((mark) => mark.type.name === markName),
      );
      const main = root.querySelector<HTMLButtonElement>(
        `[data-testid="${mainTestId}"]`,
      )!;
      const selectionButton = root.querySelector<HTMLButtonElement>(
        `[data-testid="${selectionTestId}"]`,
      )!;

      app.view.dispatch(
        app.view.state.tr.setSelection(
          TextSelection.create(app.view.state.doc, range.from + 1),
        ),
      );
      expect(main.getAttribute("aria-pressed")).toBe("true");
      expect(main.classList.contains("is-active")).toBe(true);
      expect(selectionButton.getAttribute("aria-pressed")).toBe("true");

      app.view.dispatch(
        app.view.state.tr.setSelection(
          TextSelection.create(app.view.state.doc, range.from, range.to),
        ),
      );
      expect(main.getAttribute("aria-pressed")).toBe("true");
      expect(selectionButton.getAttribute("aria-pressed")).toBe("true");

      app.view.dispatch(
        app.view.state.tr.setSelection(
          TextSelection.create(app.view.state.doc, plainRange.from + 1),
        ),
      );
      expect(main.getAttribute("aria-pressed")).toBe("false");
      expect(main.classList.contains("is-active")).toBe(false);
      expect(selectionButton.getAttribute("aria-pressed")).toBe("false");
    }

    expect(
      root
        .querySelector<HTMLButtonElement>('[data-testid="toolbar-format"]')
        ?.hasAttribute("aria-pressed"),
    ).toBe(false);
    expect(
      root
        .querySelector<HTMLButtonElement>('[data-testid="toolbar-emoji"]')
        ?.hasAttribute("aria-pressed"),
    ).toBe(false);

    const strong = app.schema.marks.strong;
    app.view.dispatch(
      app.view.state.tr.setStoredMarks(strong ? [strong.create()] : null),
    );
    expect(
      root
        .querySelector<HTMLButtonElement>('[data-testid="toolbar-bold"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      root
        .querySelector<HTMLButtonElement>('[data-testid="selection-bold"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    app.view.dispatch(app.view.state.tr.setStoredMarks(null));
    expect(
      root
        .querySelector<HTMLButtonElement>('[data-testid="toolbar-bold"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("marks block context active and only activates image and rule NodeSelections", () => {
    const { app, root } = makeApp(
      "before\n\n> quoted\n\n```ts\ncode\n```\n\nafter",
    );
    const quote = root.querySelector<HTMLButtonElement>(
      '[data-testid="toolbar-quote"]',
    )!;
    const code = root.querySelector<HTMLButtonElement>(
      '[data-testid="toolbar-code-block"]',
    )!;
    const image = root.querySelector<HTMLButtonElement>(
      '[data-testid="toolbar-image"]',
    )!;
    const rule = root.querySelector<HTMLButtonElement>(
      '[data-testid="toolbar-horizontal-rule"]',
    )!;
    const doc = app.view.state.doc;
    expect(image.getAttribute("aria-pressed")).toBe("false");
    expect(rule.getAttribute("aria-pressed")).toBe("false");

    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(doc, topLevelNodeStart(doc, 1) + 3),
      ),
    );
    expect(quote.getAttribute("aria-pressed")).toBe("true");
    expect(code.getAttribute("aria-pressed")).toBe("false");

    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, topLevelNodeStart(doc, 2) + 2),
      ),
    );
    expect(quote.getAttribute("aria-pressed")).toBe("false");
    expect(code.getAttribute("aria-pressed")).toBe("true");

    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, topLevelNodeStart(doc, 3) + 2),
      ),
    );
    expect(quote.getAttribute("aria-pressed")).toBe("false");
    expect(code.getAttribute("aria-pressed")).toBe("false");

    const nodeApp = makeApp("before\n\n![alt](image.png)\n\n---\n\nafter");
    const nodeDoc = nodeApp.app.view.state.doc;
    nodeApp.app.view.dispatch(
      nodeApp.app.view.state.tr.setSelection(
        NodeSelection.create(nodeDoc, firstNodePosition(nodeDoc, "image")),
      ),
    );
    expect(
      nodeApp.root
        .querySelector<HTMLButtonElement>('[data-testid="toolbar-image"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      nodeApp.root
        .querySelector<HTMLButtonElement>(
          '[data-testid="toolbar-horizontal-rule"]',
        )
        ?.getAttribute("aria-pressed"),
    ).toBe("false");

    nodeApp.app.view.dispatch(
      nodeApp.app.view.state.tr.setSelection(
        NodeSelection.create(
          nodeApp.app.view.state.doc,
          firstNodePosition(nodeApp.app.view.state.doc, "horizontal_rule"),
        ),
      ),
    );
    expect(
      nodeApp.root
        .querySelector<HTMLButtonElement>('[data-testid="toolbar-image"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("false");
    expect(
      nodeApp.root
        .querySelector<HTMLButtonElement>(
          '[data-testid="toolbar-horizontal-rule"]',
        )
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    nodeApp.app.destroy();
  });

  it("requires a shared blockquote ancestor for range active state", () => {
    const sameBlock = makeApp("> first line\n> second line");
    const sameDoc = sameBlock.app.view.state.doc;
    const firstLine = firstTextRange(
      sameDoc,
      (node) => node.text?.includes("first line") ?? false,
    );
    const secondLine = firstTextRange(
      sameDoc,
      (node) => node.text?.includes("second line") ?? false,
    );
    sameBlock.app.view.dispatch(
      sameBlock.app.view.state.tr.setSelection(
        TextSelection.create(sameDoc, firstLine.from, secondLine.to),
      ),
    );
    expect(quoteButton(sameBlock.root).getAttribute("aria-pressed")).toBe(
      "true",
    );

    const separateBlocks = makeApp("> quote A\n\nnormal\n\n> quote B");
    const separateDoc = separateBlocks.app.view.state.doc;
    const quoteA = firstTextRange(
      separateDoc,
      (node) => node.text === "quote A",
    );
    const quoteB = firstTextRange(
      separateDoc,
      (node) => node.text === "quote B",
    );
    separateBlocks.app.view.dispatch(
      separateBlocks.app.view.state.tr.setSelection(
        TextSelection.create(separateDoc, quoteA.from, quoteB.to),
      ),
    );
    expect(quoteButton(separateBlocks.root).getAttribute("aria-pressed")).toBe(
      "false",
    );

    const quoteToNormal = makeApp("> quote\n\nnormal");
    const quoteToNormalDoc = quoteToNormal.app.view.state.doc;
    const quote = firstTextRange(
      quoteToNormalDoc,
      (node) => node.text === "quote",
    );
    const normal = firstTextRange(
      quoteToNormalDoc,
      (node) => node.text === "normal",
    );
    quoteToNormal.app.view.dispatch(
      quoteToNormal.app.view.state.tr.setSelection(
        TextSelection.create(quoteToNormalDoc, quote.from, normal.to),
      ),
    );
    expect(quoteButton(quoteToNormal.root).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("requires a shared code block ancestor for range active state", () => {
    const sameBlock = makeApp("```text\nfirst line\nsecond line\n```");
    const sameDoc = sameBlock.app.view.state.doc;
    const firstLine = firstTextRange(
      sameDoc,
      (node) => node.text?.includes("first line") ?? false,
    );
    const secondLine = firstTextRange(
      sameDoc,
      (node) => node.text?.includes("second line") ?? false,
    );
    sameBlock.app.view.dispatch(
      sameBlock.app.view.state.tr.setSelection(
        TextSelection.create(sameDoc, firstLine.from, secondLine.to),
      ),
    );
    expect(
      sameBlock.root
        .querySelector<HTMLButtonElement>('[data-testid="toolbar-code-block"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");

    const separateBlocks = makeApp(
      "```text\ncode A\n```\n\nnormal\n\n```text\ncode B\n```",
    );
    const separateDoc = separateBlocks.app.view.state.doc;
    const codeA = firstTextRange(
      separateDoc,
      (node) => node.text?.includes("code A") ?? false,
    );
    const codeB = firstTextRange(
      separateDoc,
      (node) => node.text?.includes("code B") ?? false,
    );
    separateBlocks.app.view.dispatch(
      separateBlocks.app.view.state.tr.setSelection(
        TextSelection.create(separateDoc, codeA.from, codeB.to),
      ),
    );
    expect(
      separateBlocks.root
        .querySelector<HTMLButtonElement>('[data-testid="toolbar-code-block"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("keeps blockquote active when a range shares an outer nested blockquote", () => {
    const { app, root } = makeApp("> outer\n>\n> > inner A\n>\n> > inner B");
    const doc = app.view.state.doc;
    const innerA = firstTextRange(doc, (node) => node.text === "inner A");
    const innerB = firstTextRange(doc, (node) => node.text === "inner B");

    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(doc, innerA.from, innerB.to),
      ),
    );
    expect(quoteButton(root).getAttribute("aria-pressed")).toBe("true");
  });

  it("toggles block quote through mousedown and click while preserving the cursor", () => {
    const { app, root } = makeApp("hello");
    const quote = quoteButton(root);
    const originalDoc = app.view.state.doc;
    const originalSelection = TextSelection.create(originalDoc, 4);
    app.view.dispatch(app.view.state.tr.setSelection(originalSelection));

    expect(clickToolbarButton(quote).defaultPrevented).toBe(true);
    expect(app.view.state.doc.firstChild?.type.name).toBe("blockquote");
    expect(serializeMarkdown(app.view.state.doc)).toBe("> hello");
    expect(app.view.state.doc.childCount).toBe(1);
    expect(emptyParagraphCount(app.view.state.doc)).toBe(0);

    expect(clickToolbarButton(quote).defaultPrevented).toBe(true);
    expect(app.view.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(serializeMarkdown(app.view.state.doc)).toBe("hello");
    expect(app.view.state.doc.eq(originalDoc)).toBe(true);
    expect(app.view.state.doc.childCount).toBe(originalDoc.childCount);
    expect(emptyParagraphCount(app.view.state.doc)).toBe(0);
    expect(app.view.state.selection.from).toBe(originalSelection.from);
    expect(app.view.state.selection.to).toBe(originalSelection.to);
  });

  it("round-trips a quoted paragraph without changing surrounding paragraphs", () => {
    const source = "before\n\nhello\n\nafter";
    const { app, root } = makeApp(source);
    const originalDoc = app.view.state.doc;
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(
          originalDoc,
          paragraphTextPosition(originalDoc, 1, 3),
        ),
      ),
    );
    const quote = quoteButton(root);

    clickToolbarButton(quote);
    expect(app.view.state.doc.childCount).toBe(3);
    expect(app.view.state.doc.child(1).type.name).toBe("blockquote");
    clickToolbarButton(quote);

    expect(app.view.state.doc.eq(originalDoc)).toBe(true);
    expect(app.view.state.doc.childCount).toBe(3);
    expect(
      Array.from(
        { length: app.view.state.doc.childCount },
        (_, index) => app.view.state.doc.child(index).type.name,
      ),
    ).toEqual(["paragraph", "paragraph", "paragraph"]);
    expect(emptyParagraphCount(app.view.state.doc)).toBe(0);
    expect(serializeMarkdown(app.view.state.doc)).toBe(source);
  });

  it("round-trips multiple selected paragraphs without changing block structure", () => {
    const source = "first\n\nsecond\n\nthird";
    const { app, root } = makeApp(source);
    const originalDoc = app.view.state.doc;
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(originalDoc, 1, originalDoc.content.size - 1),
      ),
    );
    const quote = quoteButton(root);

    clickToolbarButton(quote);
    expect(app.view.state.doc.childCount).toBe(1);
    expect(app.view.state.doc.firstChild?.type.name).toBe("blockquote");
    expect(app.view.state.doc.firstChild?.childCount).toBe(3);
    clickToolbarButton(quote);

    expect(app.view.state.doc.eq(originalDoc)).toBe(true);
    expect(app.view.state.doc.childCount).toBe(3);
    expect(emptyParagraphCount(app.view.state.doc)).toBe(0);
    expect(serializeMarkdown(app.view.state.doc)).toBe(source);
  });

  it("does not add a paragraph when toggling an existing empty paragraph", () => {
    const { app, root } = makeApp("one");
    const end = TextSelection.atEnd(app.view.state.doc);
    app.view.dispatch(app.view.state.tr.setSelection(end).split(end.from));
    const originalDoc = app.view.state.doc;
    const originalSelection = app.view.state.selection;
    expect(originalDoc.childCount).toBe(2);
    expect(emptyParagraphCount(originalDoc)).toBe(1);

    const quote = quoteButton(root);
    clickToolbarButton(quote);
    expect(app.view.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(app.view.state.doc.lastChild?.type.name).toBe("blockquote");
    clickToolbarButton(quote);

    expect(app.view.state.doc.eq(originalDoc)).toBe(true);
    expect(app.view.state.doc.childCount).toBe(originalDoc.childCount);
    expect(emptyParagraphCount(app.view.state.doc)).toBe(1);
    expect(app.view.state.selection.from).toBe(originalSelection.from);
    expect(app.view.state.selection.to).toBe(originalSelection.to);
  });

  it("keeps quote structure correct across host undo and redo snapshots", () => {
    const { app, root, messages } = makeApp("hello");
    const originalDoc = app.view.state.doc;
    const quote = quoteButton(root);

    clickToolbarButton(quote);
    expect(editMessages(messages)).toHaveLength(1);
    acknowledgeLastEdit(app, messages, 2);
    clickToolbarButton(quote);
    expect(editMessages(messages)).toHaveLength(2);
    acknowledgeLastEdit(app, messages, 3);
    expect(app.view.state.doc.eq(originalDoc)).toBe(true);

    const undo = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: "z",
    });
    app.view.dom.dispatchEvent(undo);
    expect(undo.defaultPrevented).toBe(true);
    const undoRequest = messages.at(-1) as Record<string, unknown>;
    expect(undoRequest).toMatchObject({ type: "undo" });
    app.receiveDocument(
      hostDocument("> hello", 4, {
        operationId: String(undoRequest.operationId),
        reason: "undo",
      }),
    );
    expect(app.view.state.doc.eq(parseMarkdown("> hello", "github").doc)).toBe(
      true,
    );
    expect(app.view.state.doc.childCount).toBe(1);
    expect(app.view.state.doc.firstChild?.type.name).toBe("blockquote");
    expect(emptyParagraphCount(app.view.state.doc)).toBe(0);

    const redo = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: "y",
    });
    app.view.dom.dispatchEvent(redo);
    expect(redo.defaultPrevented).toBe(true);
    const redoRequest = messages.at(-1) as Record<string, unknown>;
    expect(redoRequest).toMatchObject({ type: "redo" });
    app.receiveDocument(
      hostDocument("hello", 5, {
        operationId: String(redoRequest.operationId),
        reason: "redo",
      }),
    );
    expect(app.view.state.doc.eq(originalDoc)).toBe(true);
    expect(app.view.state.doc.childCount).toBe(1);
    expect(app.view.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(emptyParagraphCount(app.view.state.doc)).toBe(0);
  });

  it("reflects the host profile and drains an edit before changing it", () => {
    const { app, root, messages } = makeApp("base");
    const profile =
      root.querySelector<HTMLSelectElement>(".mm-profile-select")!;
    profile.value = "gitlab";
    profile.dispatchEvent(new Event("change", { bubbles: true }));

    expect(messagesOfType(messages, "set-profile")).toHaveLength(1);
    const profileRequest = messagesOfType(messages, "set-profile")[0]!;
    expect(profileRequest).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      type: "set-profile",
      profile: "gitlab",
      baseVersion: 1,
    });
    expect(app.profile).toBe("github");

    app.receiveDocument({
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      markdown: "base",
      version: 2,
      profile: "gitlab",
      operationId: String(profileRequest.operationId),
      reason: "ack",
    });
    expect(app.profile).toBe("gitlab");
    expect(profile.value).toBe("gitlab");
    expect(
      root.querySelector<HTMLOptionElement>('option[value="commonmark"]')
        ?.disabled,
    ).toBe(false);

    const queued = makeApp("base");
    queued.app.view.dispatch(queued.app.view.state.tr.insertText(" one"));
    const edit = editMessages(queued.messages)[0]!;
    const queuedProfile =
      queued.root.querySelector<HTMLSelectElement>(".mm-profile-select")!;
    queuedProfile.value = "gitlab";
    queuedProfile.dispatchEvent(new Event("change", { bubbles: true }));
    expect(messagesOfType(queued.messages, "set-profile")).toHaveLength(0);

    queued.app.receiveDocument({
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      markdown: String(edit.markdown),
      version: 2,
      profile: "github",
      operationId: String(edit.operationId),
      reason: "ack",
    });
    expect(messagesOfType(queued.messages, "set-profile")).toHaveLength(1);
    const queuedProfileRequest = messagesOfType(
      queued.messages,
      "set-profile",
    )[0]!;
    expect(queuedProfileRequest).toMatchObject({
      profile: "gitlab",
      baseVersion: 2,
    });

    queued.app.receiveDocument({
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      markdown: String(edit.markdown),
      version: 3,
      profile: "gitlab",
      operationId: String(queuedProfileRequest.operationId),
      reason: "ack",
    });
    expect(queued.app.profile).toBe("gitlab");
    expect(queuedProfile.value).toBe("gitlab");
  });

  it("shows a clamped selection toolbar and applies one mark transaction with its saved selection", () => {
    const { app, root, messages } = makeApp();
    setSelectionGeometry(app);
    const selection = TextSelection.create(app.view.state.doc, 1, 6);
    app.view.dispatch(app.view.state.tr.setSelection(selection));
    const floating = root.querySelector<HTMLElement>(".mm-selection-toolbar")!;
    expect(floating.hidden).toBe(false);
    expect(floating.getAttribute("aria-hidden")).toBe("false");
    expect(floating.getAttribute("aria-label")).toBe("Selection formatting");
    const bold = root.querySelector<HTMLButtonElement>(
      '[data-testid="selection-bold"]',
    )!;
    expect(bold.textContent).toBe("");
    expect(
      bold.querySelector<SVGSVGElement>(".mm-toolbar-icon")?.dataset.icon,
    ).toBe("bold");
    expect(bold.getAttribute("aria-pressed")).toBe("false");
    const selectionButtons = Array.from(
      floating.querySelectorAll<HTMLButtonElement>("button[data-mark]"),
    );
    expect(
      selectionButtons.every((button) => !button.hasAttribute("data-tooltip")),
    ).toBe(true);
    expect(
      selectionButtons.map((button) => button.getAttribute("aria-label")),
    ).toEqual([
      "Bold selection",
      "Italic selection",
      "Strike selection",
      "Inline code selection",
      "Link selection",
    ]);
    expect(selectionButtons.map((button) => button.dataset.testid)).toEqual([
      "selection-bold",
      "selection-italic",
      "selection-strike",
      "selection-code",
      "selection-link",
    ]);
    const tooltip = root.querySelector<HTMLElement>(".mm-tooltip")!;
    bold.dispatchEvent(new Event("pointerover", { bubbles: true }));
    expect(tooltip.hidden).toBe(true);
    bold.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(tooltip.hidden).toBe(true);

    const down = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    bold.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    bold.click();

    expect(editMessages(messages)).toHaveLength(1);
    expect(
      (editMessages(messages)[0] as { markdown: string }).markdown,
    ).toContain("**hello**");
    expect(app.view.state.selection.from).toBe(selection.from);
    expect(app.view.state.selection.to).toBe(selection.to);
  });

  it("shows the Selection Toolbar for text selected within one table cell", () => {
    const { app, root } = makeApp(
      "| A | B |\n| --- | --- |\n| hello world | value |",
    );
    setSelectionGeometry(app);
    const range = firstTextRange(
      app.view.state.doc,
      (node) => node.text === "hello world",
    );
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, range.from, range.from + 5),
      ),
    );

    const floating = root.querySelector<HTMLElement>(".mm-selection-toolbar")!;
    expect(floating.hidden).toBe(false);
    expect(floating.getAttribute("aria-hidden")).toBe("false");
  });

  it("applies Bold to text selected within one table cell", () => {
    const { app, root, messages } = makeApp(
      "| A | B |\n| --- | --- |\n| hello world | value |",
    );
    setSelectionGeometry(app);
    const range = firstTextRange(
      app.view.state.doc,
      (node) => node.text === "hello world",
    );
    const selection = TextSelection.create(
      app.view.state.doc,
      range.from,
      range.from + 5,
    );
    app.view.dispatch(app.view.state.tr.setSelection(selection));

    clickToolbarButton(
      root.querySelector<HTMLButtonElement>('[data-testid="selection-bold"]')!,
    );

    let selectedText = "";
    let selectedTextIsStrong = false;
    let unselectedTextIsStrong = false;
    let otherCellText = "";
    let otherCellIsStrong = false;
    app.view.state.doc.descendants((node) => {
      if (!node.isText) return;
      if (node.text?.includes("hello")) {
        selectedText += node.text;
        selectedTextIsStrong ||= node.marks.some(
          (mark) => mark.type.name === "strong",
        );
      }
      if (node.text?.includes("world"))
        unselectedTextIsStrong ||= node.marks.some(
          (mark) => mark.type.name === "strong",
        );
      if (node.text === "value") {
        otherCellText = node.text;
        otherCellIsStrong = node.marks.some(
          (mark) => mark.type.name === "strong",
        );
      }
    });

    expect(selectedText).toContain("hello");
    expect(selectedTextIsStrong).toBe(true);
    expect(unselectedTextIsStrong).toBe(false);
    expect(otherCellText).toBe("value");
    expect(otherCellIsStrong).toBe(false);
    expect(editMessages(messages)).toHaveLength(1);
  });

  it("opens the Link picker for text selected within one table cell", () => {
    const { app, root } = makeApp(
      "| A | B |\n| --- | --- |\n| hello world | value |",
    );
    setSelectionGeometry(app);
    const range = firstTextRange(
      app.view.state.doc,
      (node) => node.text === "hello world",
    );
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, range.from, range.from + 5),
      ),
    );

    clickToolbarButton(
      root.querySelector<HTMLButtonElement>('[data-testid="selection-link"]')!,
    );

    const picker = root.querySelector<HTMLElement>(
      '[data-testid="link-selection-picker"]',
    )!;
    expect(picker.hidden).toBe(false);
    expect(picker.getAttribute("aria-hidden")).toBe("false");
  });

  it("hides the Selection Toolbar for table-spanning and CellSelection states", () => {
    const { app, root } = makeApp(
      "| A | B |\n| --- | --- |\n| hello world | value |",
    );
    setSelectionGeometry(app);
    const cells = root.querySelectorAll<HTMLTableCellElement>("tbody td");
    const hello = firstTextRange(
      app.view.state.doc,
      (node) => node.text === "hello world",
    );
    const value = firstTextRange(
      app.view.state.doc,
      (node) => node.text === "value",
    );
    const floating = root.querySelector<HTMLElement>(".mm-selection-toolbar")!;

    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, hello.from, value.to),
      ),
    );
    expect(floating.hidden).toBe(true);
    expect(floating.getAttribute("aria-hidden")).toBe("true");

    app.view.dispatch(
      app.view.state.tr.setSelection(
        CellSelection.create(
          app.view.state.doc,
          app.view.posAtDOM(cells[0]!, 0) - 1,
          app.view.posAtDOM(cells[1]!, 0) - 1,
        ),
      ),
    );
    expect(floating.hidden).toBe(true);
    expect(floating.getAttribute("aria-hidden")).toBe("true");
  });

  it("hides the Selection Toolbar for a collapsed cursor within a table cell", () => {
    const { app, root } = makeApp(
      "| A | B |\n| --- | --- |\n| hello world | value |",
    );
    const cell = root.querySelector<HTMLTableCellElement>("tbody td")!;
    const cellPosition = app.view.posAtDOM(cell, 0);
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.near(app.view.state.doc.resolve(cellPosition + 1)),
      ),
    );

    const floating = root.querySelector<HTMLElement>(".mm-selection-toolbar")!;
    expect(app.view.state.selection.empty).toBe(true);
    expect(floating.hidden).toBe(true);
    expect(floating.getAttribute("aria-hidden")).toBe("true");
  });

  it("does not reshow a collapsed Selection Toolbar after an Enter ACK", () => {
    const { app, root, messages } = makeApp("aa");
    setSelectionGeometry(app);
    const floating = root.querySelector<HTMLElement>(".mm-selection-toolbar")!;
    const selected = TextSelection.create(app.view.state.doc, 1, 3);
    app.view.dispatch(app.view.state.tr.setSelection(selected));
    expect(floating.hidden).toBe(false);
    expect(floating.getAttribute("aria-hidden")).toBe("false");

    const left = floating.style.left;
    const top = floating.style.top;
    expect(left).not.toBe("");
    expect(top).not.toBe("");
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, 3),
      ),
    );
    expect(app.view.state.selection.empty).toBe(true);
    expect(floating.hidden).toBe(true);
    expect(floating.getAttribute("aria-hidden")).toBe("true");

    app.view.focus();
    dispatchEditorKey(app, "Enter");
    expect(app.view.state.selection.empty).toBe(true);
    expect(editMessages(messages)).toHaveLength(1);

    acknowledgeLastEdit(app, messages, 2);

    expect(app.view.state.selection.empty).toBe(true);
    expect(floating.hidden).toBe(true);
    expect(floating.getAttribute("aria-hidden")).toBe("true");
    expect(floating.style.left).toBe(left);
    expect(floating.style.top).toBe(top);
  });

  it("keeps stale Selection Toolbar coordinates hidden during an editing refresh", () => {
    const { app, root } = makeApp("aa");
    setSelectionGeometry(app);
    const floating = root.querySelector<HTMLElement>(".mm-selection-toolbar")!;
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, 1, 3),
      ),
    );
    expect(floating.hidden).toBe(false);
    const left = floating.style.left;
    const top = floating.style.top;
    expect(left).not.toBe("");
    expect(top).not.toBe("");

    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, 3),
      ),
    );
    expect(floating.hidden).toBe(true);
    expect(floating.getAttribute("aria-hidden")).toBe("true");

    app.receiveDocument(hostDocument("aa", 2, { reason: "external" }));

    expect(floating.hidden).toBe(true);
    expect(floating.getAttribute("aria-hidden")).toBe("true");
    expect(floating.style.left).toBe(left);
    expect(floating.style.top).toBe(top);
  });

  it("keeps an eligible non-empty Selection Toolbar visible during a control refresh", () => {
    const { app, root } = makeApp("hello world");
    const floating = root.querySelector<HTMLElement>(".mm-selection-toolbar")!;
    const internal = app as unknown as {
      updateEditingControlState: () => void;
    };
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, 1, 6),
      ),
    );
    expect(floating.hidden).toBe(false);
    expect(floating.getAttribute("aria-hidden")).toBe("false");

    internal.updateEditingControlState();

    expect(floating.hidden).toBe(false);
    expect(floating.getAttribute("aria-hidden")).toBe("false");
  });

  it("hides and clears the Selection Toolbar through the conflict rejection path", () => {
    const { app, root, messages } = makeApp("hello world");
    const floating = root.querySelector<HTMLElement>(".mm-selection-toolbar")!;
    const internal = app as unknown as {
      conflict: boolean;
      selectionToolbarSelection: unknown;
      syncPaused: boolean;
    };
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, 1, 6),
      ),
    );
    expect(floating.hidden).toBe(false);
    expect(internal.selectionToolbarSelection).not.toBeNull();

    app.view.dispatch(
      app.view.state.tr.insertText("!", app.view.state.doc.content.size - 1),
    );
    rejectLastEdit(messages);

    expect(internal.conflict).toBe(true);
    expect(internal.syncPaused).toBe(true);
    expect(floating.hidden).toBe(true);
    expect(floating.getAttribute("aria-hidden")).toBe("true");
    expect(internal.selectionToolbarSelection).toBeNull();
  });

  it("force-hides a visible Selection Toolbar during a sync-paused control refresh", () => {
    const { app, root } = makeApp("hello world");
    const floating = root.querySelector<HTMLElement>(".mm-selection-toolbar")!;
    const internal = app as unknown as {
      selectionToolbarSelection: unknown;
      syncPaused: boolean;
      updateEditingControlState: () => void;
    };
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, 1, 6),
      ),
    );
    expect(floating.hidden).toBe(false);
    expect(internal.selectionToolbarSelection).not.toBeNull();

    internal.syncPaused = true;
    internal.updateEditingControlState();

    expect(floating.hidden).toBe(true);
    expect(floating.getAttribute("aria-hidden")).toBe("true");
    expect(internal.selectionToolbarSelection).toBeNull();
  });

  it("hides and clears the Selection Toolbar during composition and stays hidden after a collapsed composition", () => {
    const { app, root } = makeApp("hello world");
    const floating = root.querySelector<HTMLElement>(".mm-selection-toolbar")!;
    const internal = app as unknown as {
      selectionToolbarSelection: unknown;
      updateEditingControlState: () => void;
    };
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, 1, 6),
      ),
    );
    expect(floating.hidden).toBe(false);
    expect(internal.selectionToolbarSelection).not.toBeNull();

    app.view.dom.dispatchEvent(
      new Event("compositionstart", { bubbles: true }),
    );
    internal.updateEditingControlState();

    expect(floating.hidden).toBe(true);
    expect(floating.getAttribute("aria-hidden")).toBe("true");
    expect(internal.selectionToolbarSelection).toBeNull();

    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, 3),
      ),
    );
    app.view.dom.dispatchEvent(new Event("compositionend", { bubbles: true }));

    expect(app.view.state.selection.empty).toBe(true);
    expect(floating.hidden).toBe(true);
    expect(floating.getAttribute("aria-hidden")).toBe("true");
    expect(internal.selectionToolbarSelection).toBeNull();
  });

  it("hides and clears the Selection Toolbar when editing is disabled", () => {
    const { app, root } = makeApp("hello world");
    const floating = root.querySelector<HTMLElement>(".mm-selection-toolbar")!;
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, 1, 6),
      ),
    );
    expect(floating.hidden).toBe(false);
    const internal = app as unknown as {
      selectionToolbarSelection: unknown;
    };
    expect(internal.selectionToolbarSelection).not.toBeNull();

    app.receiveDocument({
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      markdown: "hello world",
      version: 2,
      profile: "github",
      mode: "preview",
      reason: "external",
    });

    expect(floating.hidden).toBe(true);
    expect(floating.getAttribute("aria-hidden")).toBe("true");
    expect(internal.selectionToolbarSelection).toBeNull();
  });

  it("moves focus to the visible selection toolbar with Tab without editing", () => {
    const { app, root, messages } = makeApp("hello world");
    const selection = TextSelection.create(app.view.state.doc, 1, 6);
    app.view.dispatch(app.view.state.tr.setSelection(selection));
    const floating = root.querySelector<HTMLElement>(".mm-selection-toolbar")!;
    const bold = root.querySelector<HTMLButtonElement>(
      '[data-testid="selection-bold"]',
    )!;
    expect(floating.hidden).toBe(false);

    app.view.focus();
    const tab = dispatchEditorKey(app, "Tab");

    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(bold);
    expect(app.view.state.selection.from).toBe(selection.from);
    expect(app.view.state.selection.to).toBe(selection.to);
    expect(editMessages(messages)).toHaveLength(0);
  });

  it("applies Bold to the saved text selection after Tab focus", () => {
    const { app, root, messages } = makeApp("hello world");
    const selection = TextSelection.create(app.view.state.doc, 1, 6);
    app.view.dispatch(app.view.state.tr.setSelection(selection));
    app.view.focus();
    dispatchEditorKey(app, "Tab");

    root
      .querySelector<HTMLButtonElement>('[data-testid="selection-bold"]')!
      .click();

    expect(editMessages(messages)).toHaveLength(1);
    expect(editMessages(messages)[0]?.markdown).toMatch(
      /^\*\*hello\*\*(?: |&#32;)world$/,
    );
    expect(app.view.state.selection.from).toBe(selection.from);
    expect(app.view.state.selection.to).toBe(selection.to);
  });

  it("collapses the forward selection to its head with Escape", () => {
    const { app, root, messages } = makeApp("hello world");
    const selection = TextSelection.create(app.view.state.doc, 1, 6);
    const documentBefore = app.view.state.doc;
    app.view.dispatch(app.view.state.tr.setSelection(selection));
    app.view.focus();
    dispatchEditorKey(app, "Tab");
    const floating = root.querySelector<HTMLElement>(".mm-selection-toolbar")!;

    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    floating.dispatchEvent(escape);

    expect(escape.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(app.view.dom);
    expect(app.view.state.selection).toBeInstanceOf(TextSelection);
    expect(app.view.state.selection.empty).toBe(true);
    expect(app.view.state.selection.from).toBe(selection.head);
    expect(app.view.state.selection.to).toBe(selection.head);
    expect(app.view.state.doc).toBe(documentBefore);
    expect(floating.hidden).toBe(true);
    expect(floating.getAttribute("aria-hidden")).toBe("true");
    expect(editMessages(messages)).toHaveLength(0);
  });

  it("collapses the backward selection to its head with Escape", () => {
    const { app, root, messages } = makeApp("hello world");
    const selection = TextSelection.create(app.view.state.doc, 6, 1);
    app.view.dispatch(app.view.state.tr.setSelection(selection));
    app.view.focus();
    dispatchEditorKey(app, "Tab");
    const floating = root.querySelector<HTMLElement>(".mm-selection-toolbar")!;

    const escape = dispatchFocusedKey("Escape");

    expect(escape.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(app.view.dom);
    expect(app.view.state.selection.empty).toBe(true);
    expect(app.view.state.selection.from).toBe(selection.head);
    expect(app.view.state.selection.to).toBe(selection.head);
    expect(floating.hidden).toBe(true);
    expect(editMessages(messages)).toHaveLength(0);
  });

  it("skips disabled Strike when Tab enters the CommonMark selection toolbar", () => {
    const { app, root, messages } = makeApp("hello world", "commonmark");
    const selection = TextSelection.create(app.view.state.doc, 1, 6);
    app.view.dispatch(app.view.state.tr.setSelection(selection));
    const floating = root.querySelector<HTMLElement>(".mm-selection-toolbar")!;
    const strike = root.querySelector<HTMLButtonElement>(
      '[data-testid="selection-strike"]',
    )!;
    const bold = root.querySelector<HTMLButtonElement>(
      '[data-testid="selection-bold"]',
    )!;
    expect(strike.disabled).toBe(true);
    expect(floating.hidden).toBe(false);

    app.view.focus();
    dispatchEditorKey(app, "Tab");

    expect(document.activeElement).toBe(bold);
    expect(document.activeElement).not.toBe(strike);
    expect(editMessages(messages)).toHaveLength(0);
    strike.click();
    expect(editMessages(messages)).toHaveLength(0);
  });

  it.each(["github", "gitlab"] as const)(
    "cycles through every enabled Selection Toolbar button for %s",
    (profile) => {
      const { app, root, messages } = makeApp("hello world", profile);
      const selection = TextSelection.create(app.view.state.doc, 1, 6);
      app.view.dispatch(app.view.state.tr.setSelection(selection));
      const floating = root.querySelector<HTMLElement>(
        ".mm-selection-toolbar",
      )!;
      const buttons = Array.from(
        floating.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
      );
      expect(buttons.map((button) => button.dataset.testid)).toEqual([
        "selection-bold",
        "selection-italic",
        "selection-strike",
        "selection-code",
        "selection-link",
      ]);

      app.view.focus();
      const firstTab = dispatchEditorKey(app, "Tab");
      expect(firstTab.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(buttons[0]);

      for (let index = 0; index < buttons.length; index += 1) {
        const tab = dispatchFocusedKey("Tab");
        expect(tab.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(
          buttons[(index + 1) % buttons.length],
        );
        expect(floating.contains(document.activeElement)).toBe(true);
        expect(app.view.state.selection.from).toBe(selection.from);
        expect(app.view.state.selection.to).toBe(selection.to);
      }

      expect(document.activeElement).toBe(buttons[0]);
      const backward = dispatchFocusedKey("Tab", { shiftKey: true });
      expect(backward.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(buttons[buttons.length - 1]);
      expect(app.view.state.selection.from).toBe(selection.from);
      expect(app.view.state.selection.to).toBe(selection.to);
      expect(editMessages(messages)).toHaveLength(0);
    },
  );

  it("cycles around disabled Strike in the CommonMark Selection Toolbar", () => {
    const { app, root, messages } = makeApp("hello world", "commonmark");
    const selection = TextSelection.create(app.view.state.doc, 1, 6);
    app.view.dispatch(app.view.state.tr.setSelection(selection));
    const floating = root.querySelector<HTMLElement>(".mm-selection-toolbar")!;
    const strike = root.querySelector<HTMLButtonElement>(
      '[data-testid="selection-strike"]',
    )!;
    const enabledButtons = Array.from(
      floating.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
    );
    expect(strike.disabled).toBe(true);
    expect(enabledButtons.map((button) => button.dataset.testid)).toEqual([
      "selection-bold",
      "selection-italic",
      "selection-code",
      "selection-link",
    ]);

    app.view.focus();
    dispatchEditorKey(app, "Tab");
    expect(document.activeElement).toBe(enabledButtons[0]);

    const expectedForward = [
      "selection-italic",
      "selection-code",
      "selection-link",
      "selection-bold",
    ];
    for (const testId of expectedForward) {
      const tab = dispatchFocusedKey("Tab");
      expect(tab.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(
        floating.querySelector(`[data-testid="${testId}"]`),
      );
      expect(document.activeElement).not.toBe(strike);
      expect(floating.contains(document.activeElement)).toBe(true);
    }

    const backward = dispatchFocusedKey("Tab", { shiftKey: true });
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(
      floating.querySelector('[data-testid="selection-link"]'),
    );
    expect(document.activeElement).not.toBe(strike);
    expect(app.view.state.selection.from).toBe(selection.from);
    expect(app.view.state.selection.to).toBe(selection.to);
    expect(editMessages(messages)).toHaveLength(0);
  });

  it("keeps Tab list indentation when the selection toolbar is hidden", () => {
    const { app, root, messages } = makeApp("- one\n- two");
    const secondItemParagraph = root.querySelectorAll("li p")[1]!;
    const position = app.view.posAtDOM(secondItemParagraph, 0) + 1;
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, position),
      ),
    );
    const floating = root.querySelector<HTMLElement>(".mm-selection-toolbar")!;
    expect(floating.hidden).toBe(true);
    app.view.focus();
    const before = editMessages(messages).length;

    const tab = dispatchEditorKey(app, "Tab");

    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(app.view.dom);
    expect(
      app.view.state.doc.firstChild?.firstChild?.childCount,
    ).toBeGreaterThan(1);
    expect(editMessages(messages)).toHaveLength(before + 1);
  });

  it("keeps Tab table navigation when the selection toolbar is hidden", () => {
    const { app, root, messages } = makeApp(
      "| A | B |\n| --- | --- |\n| C | D |",
    );
    const firstCell = root.querySelector<HTMLTableCellElement>("thead th")!;
    const cellPosition = app.view.posAtDOM(firstCell, 0);
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.near(app.view.state.doc.resolve(cellPosition + 1)),
      ),
    );
    const floating = root.querySelector<HTMLElement>(".mm-selection-toolbar")!;
    expect(floating.hidden).toBe(true);
    app.view.focus();
    const before = editMessages(messages).length;

    const tab = dispatchEditorKey(app, "Tab");

    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(app.view.dom);
    expect(app.view.state.selection.$from.parent.textContent).toBe("B");
    expect(editMessages(messages)).toHaveLength(before);
  });

  it("does not intercept Alt+F10 or move focus into the selection toolbar", () => {
    const { app, root, messages } = makeApp("hello world", "commonmark");
    setSelectionGeometry(app);
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, 1, 6),
      ),
    );
    const floating = root.querySelector<HTMLElement>(".mm-selection-toolbar")!;
    const strike = root.querySelector<HTMLButtonElement>(
      '[data-testid="selection-strike"]',
    )!;
    expect(strike.disabled).toBe(true);
    expect(floating.hidden).toBe(false);
    app.view.focus();
    const firstEnabled = floating.querySelector("button:not(:disabled)");
    const event = new KeyboardEvent("keydown", {
      key: "F10",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    app.view.dom.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(app.view.dom);
    expect(document.activeElement).not.toBe(firstEnabled);
    expect(editMessages(messages)).toHaveLength(0);
  });

  it("navigates the Insert block popup as a wrapping two-column grid", () => {
    const { app, root } = makeApp("one");
    selectTrailingEmptyParagraph(app);
    const { panel } = openEmptyLinePopup(root);
    const items = Array.from(
      panel.querySelectorAll<HTMLButtonElement>(
        'button[role="menuitem"]:not([hidden])',
      ),
    );

    expect(document.activeElement).toBe(items[0]);
    expect(items).toHaveLength(12);

    dispatchPopupKey(panel, "ArrowRight");
    expect(document.activeElement).toBe(items[1]);
    dispatchPopupKey(panel, "ArrowRight");
    expect(document.activeElement).toBe(items[2]);

    items[7]!.focus();
    dispatchPopupKey(panel, "ArrowDown");
    expect(document.activeElement).toBe(items[9]);

    items[6]!.focus();
    dispatchPopupKey(panel, "ArrowDown");
    expect(document.activeElement).toBe(items[8]);

    items[8]!.focus();
    dispatchPopupKey(panel, "ArrowUp");
    expect(document.activeElement).toBe(items[6]);

    items[0]!.focus();
    dispatchPopupKey(panel, "ArrowLeft");
    expect(document.activeElement).toBe(items[11]);
    dispatchPopupKey(panel, "ArrowRight");
    expect(document.activeElement).toBe(items[0]);
  });

  it("cycles through visible Insert block items with Tab without consuming slash", () => {
    const { app, root, messages } = makeApp("one");
    prepareTrailingEmptyParagraph(app, messages);
    const beforeMarkdown = app.view.state.doc;
    const beforeEdits = editMessages(messages).length;

    expect(dispatchTextInput(app, "/")).toBe(true);
    const panel = root.querySelector<HTMLElement>(".mm-empty-line-popup")!;
    const items = visibleInsertPopupItems(root);
    expect(items[0]).toBe(document.activeElement);
    expect(items.at(-1)?.dataset.insertProfileFeature).toBe("mermaid");

    for (let index = 1; index < items.length; index += 1) {
      const tab = dispatchFocusedKey("Tab");
      expect(tab.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(items[index]);
      expect(panel.hidden).toBe(false);
    }

    const wrapped = dispatchFocusedKey("Tab");
    expect(wrapped.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(items[0]);
    const backward = dispatchFocusedKey("Tab", { shiftKey: true });
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(items.at(-1));
    expect(panel.hidden).toBe(false);
    expect(app.view.state.doc).toBe(beforeMarkdown);
    expect(app.view.state.doc.textContent).toBe("one");
    expect(editMessages(messages)).toHaveLength(beforeEdits);
  });

  it("cycles the shared Insert block popup with Tab when opened from plus", () => {
    const { app, root, messages } = makeApp("one");
    prepareTrailingEmptyParagraph(app, messages);
    const beforeEdits = editMessages(messages).length;
    const { panel } = openEmptyLinePopup(root);
    const items = visibleInsertPopupItems(root);

    expect(document.activeElement).toBe(items[0]);
    const tab = dispatchFocusedKey("Tab");
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(items[1]);
    const backward = dispatchFocusedKey("Tab", { shiftKey: true });
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(items[0]);
    expect(panel.hidden).toBe(false);
    expect(editMessages(messages)).toHaveLength(beforeEdits);
  });

  it("exposes GitHub block profile features in the Insert block popup", () => {
    const { app, root, messages } = makeApp("one");
    prepareTrailingEmptyParagraph(app, messages);
    const beforeEdits = editMessages(messages).length;
    const { panel } = openEmptyLinePopup(root);
    const profileItems = visibleInsertPopupItems(root).filter(
      (item) => item.dataset.insertProfileFeature,
    );

    expect(profileItems.map((item) => item.textContent)).toEqual([
      "Alert",
      "Details",
      "Math",
      "Mermaid diagram",
    ]);
    expect(
      profileItems.every(
        (item) => item.getAttribute("aria-hidden") === "false",
      ),
    ).toBe(true);
    expect(panel.hidden).toBe(false);
    expect(editMessages(messages)).toHaveLength(beforeEdits);
    app.view.focus();
  });

  it("opens the existing Alert dialog from a slash profile feature item", () => {
    const { app, root, messages } = makeApp("one");
    prepareTrailingEmptyParagraph(app, messages);
    const before = editMessages(messages).length;

    expect(dispatchTextInput(app, "/")).toBe(true);
    const alert = root.querySelector<HTMLButtonElement>(
      '.mm-empty-line-popup [data-insert-profile-feature="alert"]',
    )!;
    alert.focus();
    dispatchFocusedKey("Enter");
    alert.click();

    const dialog = root.querySelector<HTMLDialogElement>(
      ".mm-profile-feature-dialog",
    )!;
    expect(dialog.open).toBe(true);
    expect(dialog.dataset.profileFeature).toBe("alert");
    expect(
      root.querySelector<HTMLElement>(".mm-empty-line-popup")?.hidden,
    ).toBe(true);
    expect(app.view.state.doc.textContent).not.toContain("/");
    expect(editMessages(messages)).toHaveLength(before);

    dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();

    const alertNode = app.view.state.doc.child(1);
    expect(alertNode?.type.name).toBe("raw_block");
    expect(alertNode?.attrs.kind).toBe("alert");
    expect(alertNode?.attrs.source).toBe("> [!NOTE]\n> Alert details");
    expect(app.view.state.doc.textContent).not.toContain("/");
    expect(editMessages(messages)).toHaveLength(before + 1);
  });

  it.each(["escape", "cancel"] as const)(
    "returns editor focus when a slash Alert dialog closes with %s",
    (closeMethod) => {
      const { app, root, messages } = makeApp("one");
      prepareTrailingEmptyParagraph(app, messages);
      const before = editMessages(messages).length;

      expect(dispatchTextInput(app, "/")).toBe(true);
      const alert = root.querySelector<HTMLButtonElement>(
        '.mm-empty-line-popup [data-insert-profile-feature="alert"]',
      )!;
      alert.focus();
      alert.click();

      const panel = root.querySelector<HTMLElement>(".mm-empty-line-popup")!;
      const dialog = root.querySelector<HTMLDialogElement>(
        ".mm-profile-feature-dialog",
      )!;
      expect(dialog.open).toBe(true);

      if (closeMethod === "escape") {
        dialog.dispatchEvent(
          new Event("cancel", { bubbles: true, cancelable: true }),
        );
      } else {
        dialog
          .querySelector<HTMLButtonElement>("button:not([type='submit'])")!
          .click();
      }

      expect(dialog.open).toBe(false);
      expect(panel.hidden).toBe(true);
      expect(document.activeElement).toBe(app.view.dom);
      expect(document.activeElement).not.toBe(alert);
      expect(app.view.state.doc.textContent).toBe("one");
      expect(editMessages(messages)).toHaveLength(before);
    },
  );

  it("updates Insert block profile items when the profile changes", () => {
    const { app, root } = makeApp("one", "github");
    const profileItems = (): HTMLButtonElement[] =>
      Array.from(
        root.querySelectorAll<HTMLButtonElement>(
          ".mm-empty-line-popup button[role='menuitem']",
        ),
      ).filter((item) => item.dataset.insertProfileFeature);
    const visibleProfileItems = (): HTMLButtonElement[] =>
      profileItems().filter((item) => !item.hidden && !item.disabled);

    expect(
      visibleProfileItems().map((item) => item.dataset.insertProfileFeature),
    ).toEqual(["alert", "details", "math", "mermaid"]);

    app.receiveDocument({
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      markdown: "one",
      version: 2,
      profile: "commonmark",
      reason: "external",
    });
    expect(visibleProfileItems()).toHaveLength(0);
    expect(
      profileItems().every(
        (item) =>
          item.hidden &&
          item.disabled &&
          item.getAttribute("aria-hidden") === "true",
      ),
    ).toBe(true);

    app.receiveDocument({
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      markdown: "one",
      version: 3,
      profile: "gitlab",
      reason: "external",
    });
    expect(
      visibleProfileItems().map((item) => item.dataset.insertProfileFeature),
    ).toEqual([
      "alert",
      "details",
      "math",
      "mermaid",
      "gitlab-toc",
      "gitlab-description-list",
    ]);
  });

  it("uses keyboard modality for navigation and restores hover on pointermove", () => {
    const { app, root } = makeApp("one");
    selectTrailingEmptyParagraph(app);
    const { panel } = openEmptyLinePopup(root);
    const items = insertPopupItems(root);

    expect(panel.dataset.inputModality).toBe("pointer");
    items[0]!.focus();
    dispatchPopupKey(panel, "ArrowDown");

    expect(document.activeElement).toBe(items[2]);
    expect(panel.dataset.inputModality).toBe("keyboard");
    expect(panel.matches('[data-input-modality="keyboard"]')).toBe(true);

    items[5]!.dispatchEvent(new Event("pointermove", { bubbles: true }));

    expect(panel.dataset.inputModality).toBe("pointer");
    expect(document.activeElement).toBe(items[2]);
  });

  it("opens the Insert block popup in keyboard modality from ArrowDown", () => {
    const { app, root } = makeApp("one");
    selectTrailingEmptyParagraph(app);
    const plus = root.querySelector<HTMLButtonElement>(
      ".mm-empty-line-insert",
    )!;
    const panel = root.querySelector<HTMLElement>(".mm-empty-line-popup")!;
    plus.focus();

    const event = dispatchFocusedKey("ArrowDown");

    expect(event.defaultPrevented).toBe(true);
    expect(panel.hidden).toBe(false);
    expect(panel.dataset.inputModality).toBe("keyboard");
    expect(document.activeElement).toBe(insertPopupItems(root)[0]);
  });

  it("keeps keyboard modality for Enter and Space activation of the plus button", () => {
    const { app, root } = makeApp("one");
    selectTrailingEmptyParagraph(app);
    const plus = root.querySelector<HTMLButtonElement>(
      ".mm-empty-line-insert",
    )!;
    const panel = root.querySelector<HTMLElement>(".mm-empty-line-popup")!;

    for (const key of ["Enter", " "]) {
      plus.focus();
      plus.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
      plus.click();
      expect(panel.dataset.inputModality).toBe("keyboard");
      plus.click();
    }
  });

  it("resets popup modality when it is closed and reopened with the pointer", () => {
    const { app, root } = makeApp("one");
    selectTrailingEmptyParagraph(app);
    const { panel, plus } = openEmptyLinePopup(root);

    dispatchPopupKey(panel, "ArrowRight");
    expect(panel.dataset.inputModality).toBe("keyboard");

    plus.click();
    expect(panel.hidden).toBe(true);
    expect(panel.hasAttribute("data-input-modality")).toBe(false);

    openEmptyLinePopup(root);
    expect(panel.hidden).toBe(false);
    expect(panel.dataset.inputModality).toBe("pointer");
  });

  it("moves Ordered list to Task with ArrowRight", () => {
    const { app, root } = makeApp("one");
    selectTrailingEmptyParagraph(app);
    const { panel } = openEmptyLinePopup(root);
    const items = insertPopupItems(root);

    items[1]!.focus();
    dispatchPopupKey(panel, "ArrowRight");
    expect(document.activeElement).toBe(items[2]);
  });

  it("moves down by two visual columns and wraps from Horizontal rule", () => {
    const { app, root } = makeApp("one");
    selectTrailingEmptyParagraph(app);
    const { panel } = openEmptyLinePopup(root);
    const items = Array.from(
      panel.querySelectorAll<HTMLButtonElement>(
        'button[role="menuitem"]:not([hidden])',
      ),
    );

    for (const [from, to] of [
      [0, 2],
      [1, 3],
      [2, 4],
      [3, 5],
      [4, 6],
      [5, 7],
      [6, 8],
      [7, 9],
      [8, 10],
      [9, 11],
      [10, 0],
      [11, 1],
    ] as Array<[number, number]>) {
      items[from]!.focus();
      dispatchPopupKey(panel, "ArrowDown");
      expect(document.activeElement).toBe(items[to]);
    }

    for (const [from, to] of [
      [0, 10],
      [1, 11],
      [2, 0],
      [3, 1],
      [4, 2],
      [5, 3],
      [6, 4],
      [7, 5],
      [8, 6],
      [9, 7],
      [10, 8],
      [11, 9],
    ] as Array<[number, number]>) {
      items[from]!.focus();
      dispatchPopupKey(panel, "ArrowUp");
      expect(document.activeElement).toBe(items[to]);
    }
  });

  it("skips disabled Insert block items with the same navigation step", () => {
    const { app, root } = makeApp("one", "commonmark");
    selectTrailingEmptyParagraph(app);
    const { panel } = openEmptyLinePopup(root);
    const items = insertPopupItems(root);

    expect(items[2]?.disabled).toBe(true);
    expect(items[5]?.disabled).toBe(true);

    items[1]!.focus();
    dispatchPopupKey(panel, "ArrowRight");
    expect(document.activeElement).toBe(items[3]);
    expect((document.activeElement as HTMLButtonElement).disabled).toBe(false);

    items[0]!.focus();
    dispatchPopupKey(panel, "ArrowDown");
    expect(document.activeElement).toBe(items[4]);

    dispatchPopupKey(panel, "Home");
    expect(document.activeElement).toBe(items[0]);
    dispatchPopupKey(panel, "End");
    expect(document.activeElement).toBe(items[7]);
  });

  it("opens the existing Image dialog from the plus popup and applies at the saved position", () => {
    const { app, root, messages } = makeApp("one");
    prepareTrailingEmptyParagraph(app, messages);
    const before = editMessages(messages).length;
    const { panel } = openEmptyLinePopup(root);
    const imageButton = insertPopupItems(root)[6]!;

    imageButton.click();

    const dialog = root.querySelector<HTMLDialogElement>(
      '[aria-labelledby="mm-image-dialog-title"]',
    )!;
    expect(dialog.open).toBe(true);
    expect(panel.hidden).toBe(true);
    expect(editMessages(messages)).toHaveLength(before);
    expect(imageButton.getAttribute("aria-label")).toBe("Insert image");
    expect(imageButton.hasAttribute("data-tooltip")).toBe(false);

    const [pathInput, altInput] = Array.from(
      dialog.querySelectorAll<HTMLInputElement>("input"),
    );
    pathInput!.value = "./images/from-plus.png";
    altInput!.value = "from plus";
    dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();

    expect(app.view.state.doc.lastChild?.firstChild?.type.name).toBe("image");
    expect(app.view.state.doc.lastChild?.firstChild?.attrs).toMatchObject({
      src: "./images/from-plus.png",
      alt: "from plus",
    });
    expect(editMessages(messages)).toHaveLength(before + 1);
    expect(editMessages(messages).at(-1)?.markdown).toBe(
      "one\n\n![from plus](./images/from-plus.png)",
    );
  });

  it("opens Image from slash, consumes the trigger, and applies at the saved position", () => {
    const { app, root, messages } = makeApp("one");
    prepareTrailingEmptyParagraph(app, messages);
    const before = editMessages(messages).length;

    expect(dispatchTextInput(app, "/")).toBe(true);
    const items = insertPopupItems(root);
    items[6]!.click();

    const dialog = root.querySelector<HTMLDialogElement>(
      '[aria-labelledby="mm-image-dialog-title"]',
    )!;
    expect(dialog.open).toBe(true);
    expect(app.view.state.doc.textContent).toBe("one");
    expect(app.view.state.doc.textContent).not.toContain("/");
    expect(editMessages(messages)).toHaveLength(before);

    const [pathInput, altInput] = Array.from(
      dialog.querySelectorAll<HTMLInputElement>("input"),
    );
    pathInput!.value = "https://example.com/from-slash.png";
    altInput!.value = "from slash";
    dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();

    expect(app.view.state.doc.lastChild?.firstChild?.type.name).toBe("image");
    expect(app.view.state.doc.lastChild?.firstChild?.attrs).toMatchObject({
      src: "https://example.com/from-slash.png",
      alt: "from slash",
    });
    expect(app.view.state.doc.textContent).not.toContain("/");
    expect(editMessages(messages)).toHaveLength(before + 1);
    expect(editMessages(messages).at(-1)?.markdown).toBe(
      "one\n\n![from slash](https://example.com/from-slash.png)",
    );
  });

  it("cancels the Image dialog without creating an unnecessary edit", () => {
    const { app, root, messages } = makeApp("one");
    prepareTrailingEmptyParagraph(app, messages);
    const before = editMessages(messages).length;
    expect(dispatchTextInput(app, "/")).toBe(true);
    insertPopupItems(root)[6]!.click();

    const dialog = root.querySelector<HTMLDialogElement>(
      '[aria-labelledby="mm-image-dialog-title"]',
    )!;
    dialog.querySelector<HTMLButtonElement>('button[type="button"]')!.click();

    expect(dialog.open).toBe(false);
    expect(app.view.state.doc.textContent).toBe("one");
    expect(app.view.state.doc.textContent).not.toContain("/");
    expect(editMessages(messages)).toHaveLength(before);
  });

  it("opens the same Insert block popup from slash without editing first", () => {
    const { app, root, messages } = makeApp("one");
    prepareTrailingEmptyParagraph(app, messages);
    const before = editMessages(messages).length;

    expect(dispatchTextInput(app, "/")).toBe(true);

    const panel = root.querySelector<HTMLElement>(".mm-empty-line-popup")!;
    const items = insertPopupItems(root);
    expect(panel.hidden).toBe(false);
    expect(panel.dataset.inputModality).toBe("keyboard");
    expect(document.activeElement).toBe(items[0]);
    expect(app.view.state.doc.textContent).toBe("one");
    expect(editMessages(messages)).toHaveLength(before);
  });

  it("keeps slash popup focus in keyboard modality and restores hover on pointermove", () => {
    const { app, root, messages } = makeApp("one");
    prepareTrailingEmptyParagraph(app, messages);

    expect(dispatchTextInput(app, "/")).toBe(true);

    const panel = root.querySelector<HTMLElement>(".mm-empty-line-popup")!;
    const items = insertPopupItems(root);

    expect(panel.dataset.inputModality).toBe("keyboard");
    expect(document.activeElement).toBe(items[0]);

    dispatchPopupKey(panel, "ArrowDown");

    expect(panel.dataset.inputModality).toBe("keyboard");
    expect(document.activeElement).toBe(items[2]);

    items[5]!.dispatchEvent(new Event("pointermove", { bubbles: true }));

    expect(panel.dataset.inputModality).toBe("pointer");
    expect(document.activeElement).toBe(items[2]);
  });

  it("consumes slash when a shared Insert block command is committed", () => {
    const { app, root, messages } = makeApp("one");
    prepareTrailingEmptyParagraph(app, messages);
    const before = editMessages(messages).length;
    expect(dispatchTextInput(app, "/")).toBe(true);

    const items = insertPopupItems(root);
    items[0]!.click();

    expect(app.view.state.doc.lastChild?.type.name).toBe("bullet_list");
    expect(app.view.state.doc.textContent).not.toContain("/");
    expect(editMessages(messages)).toHaveLength(before + 1);
    expect(editMessages(messages).at(-1)?.markdown).not.toBe("/");
    expect(
      root.querySelector<HTMLElement>(".mm-empty-line-popup")?.hidden,
    ).toBe(true);
  });

  it("materializes slash once on Escape and returns focus to the editor", () => {
    const { app, root, messages } = makeApp("one");
    prepareTrailingEmptyParagraph(app, messages);
    const before = editMessages(messages).length;
    expect(dispatchTextInput(app, "/")).toBe(true);
    const panel = root.querySelector<HTMLElement>(".mm-empty-line-popup")!;

    const escape = dispatchPopupKey(panel, "Escape");

    expect(escape.defaultPrevented).toBe(true);
    expect(panel.hidden).toBe(true);
    expect(app.view.state.doc.textContent).toBe("one/");
    expect(editMessages(messages)).toHaveLength(before + 1);
    expect(document.activeElement).toBe(app.view.dom);
  });

  it("discards a pending slash when an external document makes it stale", () => {
    const { app, root, messages } = makeApp("one");
    prepareTrailingEmptyParagraph(app, messages);
    const before = editMessages(messages).length;
    expect(dispatchTextInput(app, "/")).toBe(true);
    const panel = root.querySelector<HTMLElement>(".mm-empty-line-popup")!;

    app.receiveDocument(hostDocument("external", 3, { reason: "external" }));

    expect(panel.hidden).toBe(true);
    expect(app.view.state.doc.textContent).toBe("external");
    expect(editMessages(messages)).toHaveLength(before);
  });

  it("keeps slash as ordinary text outside an eligible empty paragraph", () => {
    const start = makeApp("hello");
    start.app.view.dispatch(
      start.app.view.state.tr.setSelection(
        TextSelection.create(start.app.view.state.doc, 1),
      ),
    );
    expect(dispatchTextInput(start.app, "/")).toBe(false);
    expect(start.app.view.state.doc.textContent).toBe("/hello");
    expect(
      start.root.querySelector<HTMLElement>(".mm-empty-line-popup")?.hidden,
    ).toBe(true);

    const middle = makeApp("hello");
    middle.app.view.dispatch(
      middle.app.view.state.tr.setSelection(
        TextSelection.create(
          middle.app.view.state.doc,
          paragraphTextPosition(middle.app.view.state.doc, 0, 2),
        ),
      ),
    );
    expect(dispatchTextInput(middle.app, "/")).toBe(false);
    expect(middle.app.view.state.doc.textContent).toBe("he/llo");

    const code = makeApp("```js\ncode\n```");
    code.app.view.dispatch(
      code.app.view.state.tr.setSelection(
        TextSelection.atEnd(code.app.view.state.doc),
      ),
    );
    expect(dispatchTextInput(code.app, "/")).toBe(false);
    expect(code.app.view.state.doc.textContent).toContain("code/");
    expect(
      code.root.querySelector<HTMLElement>(".mm-empty-line-popup")?.hidden,
    ).toBe(true);

    const table = makeApp("| A | B |\n| --- | --- |\n| C | D |");
    expect(dispatchTextInput(table.app, "/")).toBe(false);
    expect(table.app.view.state.doc.textContent).toContain("/");
    expect(
      table.root.querySelector<HTMLElement>(".mm-empty-line-popup")?.hidden,
    ).toBe(true);

    const selected = makeApp("hello");
    selected.app.view.dispatch(
      selected.app.view.state.tr.setSelection(
        TextSelection.create(selected.app.view.state.doc, 1, 2),
      ),
    );
    expect(dispatchTextInput(selected.app, "/")).toBe(false);
    expect(selected.app.view.state.doc.textContent).toBe("/ello");
  });

  it("keeps slash ordinary during IME composition", () => {
    const { app, root, messages } = makeApp("one");
    prepareTrailingEmptyParagraph(app, messages);
    app.view.dom.dispatchEvent(
      new Event("compositionstart", { bubbles: true }),
    );
    const before = editMessages(messages).length;

    expect(dispatchTextInput(app, "/")).toBe(false);
    expect(app.view.state.doc.textContent).toBe("one/");
    expect(
      root.querySelector<HTMLElement>(".mm-empty-line-popup")?.hidden,
    ).toBe(true);
    expect(editMessages(messages)).toHaveLength(before + 1);
    app.view.dom.dispatchEvent(new Event("compositionend", { bubbles: true }));
  });

  it("shows one reusable top-level block-gap button without shifting blocks", () => {
    const { app, root, messages } = makeApp("one\n\ntwo\n\nthree");
    const stage = root.querySelector<HTMLElement>(".mm-stage")!;
    const blocks = Array.from(
      root.querySelectorAll<HTMLElement>(".ProseMirror > *"),
    );
    expect(blocks).toHaveLength(3);
    setElementRect(stage, { top: 0, bottom: 500, left: 0, width: 800 });
    setElementRect(blocks[0]!, { top: 20, bottom: 40, left: 60 });
    setElementRect(blocks[1]!, { top: 80, bottom: 100, left: 60 });
    setElementRect(blocks[2]!, { top: 140, bottom: 160, left: 60 });
    const before = blocks.map((block) => {
      const { top, bottom, left } = block.getBoundingClientRect();
      return { top, bottom, left };
    });
    const scrollHeight = stage.scrollHeight;

    const move = (clientY: number): void => {
      stage.dispatchEvent(
        new MouseEvent("pointermove", {
          bubbles: true,
          cancelable: true,
          clientX: 100,
          clientY,
        }),
      );
    };
    const gap = root.querySelector<HTMLButtonElement>(".mm-block-gap-insert")!;
    expect(gap.hidden).toBe(true);
    move(60);
    expect(gap.hidden).toBe(false);
    expect(gap.dataset.position).toBe(
      String(topLevelNodeStart(app.view.state.doc, 1)),
    );
    expect(root.querySelectorAll(".mm-block-gap-insert")).toHaveLength(1);

    app.view.dispatch(
      app.view.state.tr.setSelection(
        new BlockBoundarySelection(
          app.view.state.doc.resolve(topLevelNodeStart(app.view.state.doc, 1)),
        ),
      ),
    );
    expect(gap.hidden).toBe(true);

    app.view.dispatch(
      app.view.state.tr.setSelection(TextSelection.atStart(app.view.state.doc)),
    );
    move(120);
    expect(gap.hidden).toBe(false);
    expect(gap.dataset.position).toBe(
      String(topLevelNodeStart(app.view.state.doc, 2)),
    );
    expect(
      blocks.map((block) => {
        const { top, bottom, left } = block.getBoundingClientRect();
        return { top, bottom, left };
      }),
    ).toEqual(before);
    expect(stage.scrollHeight).toBe(scrollHeight);
    expect(editMessages(messages)).toHaveLength(0);
  });

  it("opens the existing Insert block popup from a gap without sending an edit", () => {
    const source = "one\n\ntwo";
    const { app, root, messages } = makeApp(source);
    const stage = root.querySelector<HTMLElement>(".mm-stage")!;
    const blocks = Array.from(
      root.querySelectorAll<HTMLElement>(".ProseMirror > *"),
    );
    expect(blocks).toHaveLength(2);
    setElementRect(stage, { top: 0, bottom: 500, left: 0, width: 800 });
    setElementRect(blocks[0]!, { top: 20, bottom: 40, left: 60 });
    setElementRect(blocks[1]!, { top: 80, bottom: 100, left: 60 });
    stage.dispatchEvent(
      new MouseEvent("pointermove", {
        bubbles: true,
        cancelable: true,
        clientX: 100,
        clientY: 60,
      }),
    );
    const gap = root.querySelector<HTMLButtonElement>(".mm-block-gap-insert")!;
    const panel = root.querySelector<HTMLElement>(".mm-empty-line-popup")!;
    const beforeEdits = editMessages(messages).length;
    gap.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );
    gap.click();

    expect(root.querySelector<HTMLElement>(".mm-empty-line-popup")).toBe(panel);
    expect(panel.hidden).toBe(false);
    expect(gap.getAttribute("aria-expanded")).toBe("false");
    expect(
      root.querySelector<HTMLButtonElement>(".mm-empty-line-insert")?.hidden,
    ).toBe(false);
    expect(
      root
        .querySelector<HTMLButtonElement>(".mm-empty-line-insert")
        ?.getAttribute("aria-expanded"),
    ).toBe("true");
    expect(root.querySelectorAll(".mm-block-gap-insert")).toHaveLength(1);
    expect(app.view.state.doc.childCount).toBe(3);
    expect(app.view.state.doc.child(1)?.type.name).toBe("paragraph");
    expect(app.view.state.doc.child(1)?.content.size).toBe(0);
    expect(app.view.state.selection.empty).toBe(true);
    expect(app.view.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(
      (app as unknown as { currentMarkdown: () => string }).currentMarkdown(),
    ).toBe(source);
    expect((app as unknown as { dirty: boolean }).dirty).toBe(false);
    expect(editMessages(messages)).toHaveLength(beforeEdits);

    const code = insertPopupItems(root)[4]!;
    code.click();
    expect(editMessages(messages)).toHaveLength(beforeEdits + 1);
    expect(editMessages(messages).at(-1)?.markdown).toContain("```");
  });

  it("only detects gaps between direct document children", () => {
    const { root } = makeApp("> inner one\n>\n> inner two\n\nafter");
    const stage = root.querySelector<HTMLElement>(".mm-stage")!;
    const topLevel = Array.from(
      root.querySelectorAll<HTMLElement>(".ProseMirror > *"),
    );
    const nested = Array.from(
      root.querySelectorAll<HTMLElement>(".ProseMirror blockquote > p"),
    );
    expect(topLevel).toHaveLength(2);
    expect(nested).toHaveLength(2);
    setElementRect(stage, { top: 0, bottom: 500, left: 0, width: 800 });
    setElementRect(topLevel[0]!, { top: 20, bottom: 160, left: 60 });
    setElementRect(topLevel[1]!, { top: 220, bottom: 240, left: 60 });
    setElementRect(nested[0]!, { top: 40, bottom: 60, left: 80 });
    setElementRect(nested[1]!, { top: 100, bottom: 120, left: 80 });
    const gap = root.querySelector<HTMLButtonElement>(".mm-block-gap-insert")!;

    stage.dispatchEvent(
      new MouseEvent("pointermove", {
        bubbles: true,
        cancelable: true,
        clientY: 80,
      }),
    );
    expect(gap.hidden).toBe(true);
    stage.dispatchEvent(
      new MouseEvent("pointermove", {
        bubbles: true,
        cancelable: true,
        clientY: 180,
      }),
    );
    expect(gap.hidden).toBe(false);
  });

  it("offers Insert beside a top-level empty paragraph without mutating Markdown until a command is committed", () => {
    const { app, root, messages } = makeApp("one");
    const end = TextSelection.atEnd(app.view.state.doc);
    app.view.dispatch(app.view.state.tr.setSelection(end).split(end.from));
    const emptyParagraph =
      root.querySelectorAll<HTMLElement>(".ProseMirror p")[1]!;
    const position = app.view.posAtDOM(emptyParagraph, 0);
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, position),
      ),
    );
    const plus = root.querySelector<HTMLButtonElement>(
      ".mm-empty-line-insert",
    )!;
    expect(plus.hidden).toBe(false);
    const before = editMessages(messages).length;
    plus.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );
    plus.click();
    expect(editMessages(messages)).toHaveLength(before);
    expect(plus.getAttribute("aria-expanded")).toBe("true");
    const panel = root.querySelector<HTMLElement>(
      ".mm-popup-panel[data-floating='true']",
    )!;
    expect(panel.hidden).toBe(false);

    const tableButton = root.querySelector<HTMLButtonElement>(
      '[data-testid="toolbar-table"]',
    )!;
    tableButton.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );
    tableButton.click();
    expect(
      root.querySelector<HTMLDialogElement>(".mm-table-dialog")?.open,
    ).toBe(true);
    expect(editMessages(messages)).toHaveLength(before);
    Array.from(
      root.querySelectorAll<HTMLButtonElement>(".mm-table-dialog button"),
    )
      .find((button) => button.textContent === "Cancel")
      ?.click();
    expect(editMessages(messages)).toHaveLength(before);
  });

  it("keeps Source available in preview and closes the contextual insert popup safely", () => {
    const preview = makeApp("hello");
    preview.app.receiveDocument({
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      markdown: "hello",
      version: 2,
      profile: "github",
      mode: "preview",
      reason: "external",
    });
    const source = preview.root.querySelector<HTMLButtonElement>(
      '[data-mode="source"]',
    )!;
    source.click();
    expect(
      preview.messages.filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          (message as { type?: unknown }).type === "source",
      ),
    ).toHaveLength(1);
    expect(preview.app.mode).toBe("preview");

    const { app, root } = makeApp("one");
    const end = TextSelection.atEnd(app.view.state.doc);
    app.view.dispatch(app.view.state.tr.setSelection(end).split(end.from));
    const emptyParagraph =
      root.querySelectorAll<HTMLElement>(".ProseMirror p")[1]!;
    const position = app.view.posAtDOM(emptyParagraph, 0);
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, position),
      ),
    );
    const plus = root.querySelector<HTMLButtonElement>(
      ".mm-empty-line-insert",
    )!;
    plus.click();
    const panel = root.querySelector<HTMLElement>(".mm-empty-line-popup")!;
    expect(panel.hidden).toBe(false);

    app.view.dom.dispatchEvent(
      new Event("compositionstart", { bubbles: true }),
    );
    expect(panel.hidden).toBe(true);
    app.view.dom.dispatchEvent(new Event("compositionend", { bubbles: true }));
    plus.click();
    expect(panel.hidden).toBe(false);
    app.receiveDocument({
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      markdown: "external",
      version: 2,
      profile: "github",
      reason: "external",
    });
    expect(panel.hidden).toBe(true);
  });

  it("waits for a pending edit before opening the native Source editor", () => {
    const { app, root, messages } = makeApp("base");
    app.view.dispatch(app.view.state.tr.insertText(" changed"));
    const edit = editMessages(messages)[0]!;

    root.querySelector<HTMLButtonElement>('[data-mode="source"]')!.click();
    expect(messagesOfType(messages, "source")).toHaveLength(0);
    expect(root.querySelector(".mm-statusbar")).toBeNull();
    expect(root.querySelector(".mm-status")).toBeNull();

    app.receiveDocument({
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      markdown: String(edit.markdown),
      version: 2,
      profile: "github",
      operationId: String(edit.operationId),
      reason: "ack",
    });
    expect(messagesOfType(messages, "source")).toHaveLength(1);
    expect(app.mode).toBe("rich");
  });
});
