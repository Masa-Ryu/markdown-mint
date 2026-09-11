import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TextSelection } from "prosemirror-state";
import {
  parseMarkdown,
  renderMarkdown,
  schema,
  serializeMarkdown,
} from "../../src/core";
import { PROTOCOL_VERSION } from "../../src/shared/protocol";
import {
  createEditorApp,
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
    expect(toolbar.querySelector(".mm-popup-toggle")).toBeNull();
    for (const element of Array.from(
      toolbar.querySelectorAll<HTMLElement>(
        ".mm-heading-select, .mm-tool-button",
      ),
    ))
      expect(element.closest(".mm-popup-panel")).toBeNull();
    expect(editMessages(messages)).toHaveLength(0);
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
      "divider",
    ]);
    expect(popup.textContent).toContain("List");
    expect(popup.textContent).toContain("Task");
    expect(popup.textContent).toContain("Horizontal rule");
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

  it("toggles block quote with toolbar button", () => {
    const { app, root } = makeApp("hello");
    const quote = root.querySelector<HTMLButtonElement>(
      '[data-testid="toolbar-quote"]',
    )!;

    quote.click();
    expect(app.view.state.doc.firstChild?.type.name).toBe("blockquote");
    expect(serializeMarkdown(app.view.state.doc)).toBe("> hello");

    quote.click();
    expect(app.view.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(serializeMarkdown(app.view.state.doc)).toBe("hello");
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
    expect(floating.getAttribute("aria-label")).toBe("Selection formatting");
    const bold = root.querySelector<HTMLButtonElement>(
      '[data-testid="selection-bold"]',
    )!;
    expect(bold.textContent).toBe("");
    expect(
      bold.querySelector<SVGSVGElement>(".mm-toolbar-icon")?.dataset.icon,
    ).toBe("bold");
    expect(bold.getAttribute("aria-pressed")).toBe("false");

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

  it("opens the selection toolbar with Alt+F10 and keeps GFM-only strike disabled in CommonMark", () => {
    const { app, root } = makeApp("hello world", "commonmark");
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
    const event = new KeyboardEvent("keydown", {
      key: "F10",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    app.view.dom.dispatchEvent(event);
    expect(document.activeElement).toBe(
      floating.querySelector("button:not(:disabled)"),
    );
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
    expect(root.querySelector(".mm-status")?.textContent).toContain(
      "Waiting to open source",
    );

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
