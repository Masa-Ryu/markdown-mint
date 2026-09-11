import { beforeEach, describe, expect, it, afterEach } from "vitest";
import { baseKeymap } from "prosemirror-commands";
import { keymap } from "prosemirror-keymap";
import { EditorState, TextSelection } from "prosemirror-state";
import type { Transaction } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import {
  parseMarkdown,
  renderMarkdown,
  schema,
  serializeMarkdown,
} from "../../src/core";
import { PROTOCOL_VERSION } from "../../src/shared/protocol";
import {
  createEditorApp,
  type DocumentMessage,
  type MarkdownEditorApp,
  type VSCodeApiLike,
} from "../../src/webview/editor";
import {
  createStarterPlugin,
  getStarterState,
  isStarterUntouched,
  prepareStarterDocument,
  serializeStarterSource,
  setStarterMeta,
  starterStateFor,
} from "../../src/webview/starter";

const views: EditorView[] = [];
const apps: MarkdownEditorApp[] = [];

function hostDocument(
  markdown: string,
  version: number,
  reason: string,
): DocumentMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "document",
    markdown,
    version,
    profile: "github",
    reason,
  };
}

function messagesOfType(messages: unknown[], type: string): unknown[] {
  return messages.filter(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      (message as { type?: unknown }).type === type,
  );
}

function makeStarterState(source = ""):
  | {
      state: EditorState;
      originalSource: string;
      parsed: ReturnType<typeof parseMarkdown>;
    }
  | undefined {
  const parsed = parseMarkdown(source, "github");
  const prepared = prepareStarterDocument(source, parsed.doc);
  const state = EditorState.create({
    schema,
    doc: prepared.doc,
    plugins: [createStarterPlugin(prepared.state), keymap(baseKeymap)],
  });
  return { state, originalSource: source, parsed };
}

function makeApp(
  markdown = "",
  options: { withHost?: boolean } = {},
): { app: MarkdownEditorApp; root: HTMLElement; messages: unknown[] } {
  const root = document.createElement("div");
  document.body.append(root);
  const messages: unknown[] = [];
  const state: { value: unknown } = { value: undefined };
  const vscode: VSCodeApiLike = {
    postMessage: (message) => messages.push(message),
    getState: () => state.value,
    setState: (value) => {
      state.value = value;
    },
  };
  const app = createEditorApp({
    root,
    ...(options.withHost === false ? {} : { vscode }),
    core: {
      schema,
      parseMarkdown,
      serializeMarkdown,
      renderMarkdown,
    },
    initialDocument: {
      markdown,
      version: 1,
      profile: "github",
    },
  });
  apps.push(app);
  return { app, root, messages };
}

beforeEach(() => {
  document.body.replaceChildren();
  if (typeof Range.prototype.getClientRects !== "function")
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [],
    });
  if (typeof Range.prototype.getBoundingClientRect !== "function")
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
  for (const view of views) view.destroy();
  views.length = 0;
  for (const app of apps) app.destroy();
  apps.length = 0;
  document.body.replaceChildren();
});

describe("blank-document starter", () => {
  it("prepares an empty H1 with a CSS-only Title placeholder", () => {
    const prepared = makeStarterState("")!;
    const mount = document.createElement("div");
    document.body.append(mount);
    const view = new EditorView(mount, { state: prepared.state });
    views.push(view);

    expect(view.state.doc.firstChild?.type.name).toBe("heading");
    expect(view.state.doc.firstChild?.attrs.level).toBe(1);
    const heading = mount.querySelector("h1");
    expect(heading?.textContent).toBe("");
    expect(heading?.classList.contains("mm-starter-title")).toBe(true);
    expect(heading?.getAttribute("data-placeholder")).toBe("Title");
    expect(isStarterUntouched(view.state)).toBe(true);
    expect(
      serializeStarterSource(
        view.state,
        prepared.originalSource,
        serializeMarkdown(view.state.doc, prepared.parsed),
      ),
    ).toBe("");
    expect(
      serializeStarterSource(view.state, prepared.originalSource, () => {
        throw new Error("virtual starter must not be serialized");
      }),
    ).toBe("");
  });

  it("keeps exact whitespace-only source when the parser supplied a blank paragraph", () => {
    const source = " \r\n\t";
    const parsed = parseMarkdown("", "github");
    const prepared = prepareStarterDocument(source, parsed.doc);
    expect(prepared.state).toEqual({ active: true, untouched: true });
    expect(prepared.doc.firstChild?.type.name).toBe("heading");

    const state = EditorState.create({
      schema,
      doc: prepared.doc,
      plugins: [createStarterPlugin(prepared.state)],
    });
    expect(serializeStarterSource(state, source, "# Title")).toBe(source);
  });

  it("does not turn an existing plain document into a starter", () => {
    const parsed = parseMarkdown("Existing text", "github");
    const prepared = prepareStarterDocument("Existing text", parsed.doc);
    expect(prepared.doc.eq(parsed.doc)).toBe(true);
    expect(prepared.state).toEqual({ active: false, untouched: false });
    expect(starterStateFor("Existing text", parsed.doc)).toEqual({
      active: false,
      untouched: false,
    });
  });

  it("emits a heading on first typing and splits to a paragraph on Enter", () => {
    const prepared = makeStarterState("")!;
    const mount = document.createElement("div");
    document.body.append(mount);
    const view = new EditorView(mount, { state: prepared.state });
    views.push(view);

    view.dispatch(
      view.state.tr
        .setSelection(TextSelection.create(view.state.doc, 1))
        .insertText("Title"),
    );
    expect(view.state.doc.firstChild?.type.name).toBe("heading");
    expect(view.state.doc.firstChild?.textContent).toBe("Title");
    expect(isStarterUntouched(view.state)).toBe(false);
    expect(
      serializeStarterSource(
        view.state,
        prepared.originalSource,
        serializeMarkdown(view.state.doc, prepared.parsed),
      ),
    ).toBe("# Title");

    view.dispatch(
      view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)),
    );
    const enterTransactions: Transaction[] = [];
    const dispatch = (transaction: Transaction) =>
      enterTransactions.push(transaction);
    expect(baseKeymap.Enter?.(view.state, dispatch)).toBe(true);
    expect(enterTransactions).toHaveLength(1);
    view.dispatch(enterTransactions[0]!);
    expect(view.state.doc.childCount).toBe(2);
    expect(view.state.doc.child(0).type.name).toBe("heading");
    expect(view.state.doc.child(1).type.name).toBe("paragraph");
  });

  it("honors an explicit Text choice without reactivating the H1", () => {
    const prepared = makeStarterState("")!;
    const mount = document.createElement("div");
    document.body.append(mount);
    const view = new EditorView(mount, { state: prepared.state });
    views.push(view);
    const paragraph = schema.nodes.paragraph!.create();
    const transaction = setStarterMeta(
      view.state.tr.replaceWith(0, view.state.doc.content.size, paragraph),
      { active: false, preserveSource: true },
    );
    view.dispatch(transaction);

    expect(view.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(getStarterState(view.state)).toEqual({
      active: false,
      untouched: true,
    });
    expect(serializeStarterSource(view.state, "", "# ")).toBe("");

    view.dispatch(view.state.tr.insertText("Body", 1));
    expect(view.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(isStarterUntouched(view.state)).toBe(false);
    expect(serializeMarkdown(view.state.doc, parseMarkdown("", "github"))).toBe(
      "Body",
    );
  });

  it("deactivates permanently when another heading level is selected", () => {
    const prepared = makeStarterState("")!;
    const heading = schema.nodes.heading!.create({ level: 2 });
    const state = prepared.state.apply(
      prepared.state.tr.replaceWith(
        0,
        prepared.state.doc.content.size,
        heading,
      ),
    );
    expect(getStarterState(state)).toEqual({
      active: false,
      untouched: false,
    });
    expect(serializeMarkdown(state.doc, parseMarkdown("", "github"))).toContain(
      "##",
    );
  });

  it("integrates first typing as H1 and Enter as a body paragraph", () => {
    const { app, messages, root } = makeApp("");
    expect(root.querySelector("h1.mm-starter-title")).not.toBeNull();

    app.view.dispatch(
      app.view.state.tr
        .setSelection(TextSelection.create(app.view.state.doc, 1))
        .insertText("Title"),
    );
    const edits = messagesOfType(messages, "edit") as Array<{
      markdown?: unknown;
    }>;
    expect(edits.at(-1)?.markdown).toBe("# Title");

    app.view.dispatch(
      app.view.state.tr.setSelection(TextSelection.atEnd(app.view.state.doc)),
    );
    app.view.dom.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(app.view.state.doc.child(0).type.name).toBe("heading");
    expect(app.view.state.doc.child(1).type.name).toBe("paragraph");
  });

  it("lets a blank editor choose Text and then type a plain paragraph", () => {
    const { app, root, messages } = makeApp("");
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, 1),
      ),
    );
    const heading =
      root.querySelector<HTMLSelectElement>(".mm-heading-select")!;
    heading.value = "p";
    heading.dispatchEvent(new Event("change", { bubbles: true }));

    expect(app.view.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(root.querySelector(".mm-starter-title")).toBeNull();
    app.view.dispatch(app.view.state.tr.insertText("Body", 1));
    const edits = messagesOfType(messages, "edit") as Array<{
      markdown?: unknown;
    }>;
    expect(
      edits.at(-1)?.markdown === "Body" ||
        app.sync.queuedEdit?.markdown === "Body",
    ).toBe(true);
  });

  it("leaves an existing nonempty editor document unchanged", () => {
    const { app, root, messages } = makeApp("Existing text");
    expect(app.view.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(root.querySelector(".mm-starter-title")).toBeNull();
    expect(messagesOfType(messages, "edit")).toHaveLength(0);
  });

  it("supports reseeding a reused plugin after a blank document reload", () => {
    const initial = makeStarterState("")!;
    const plugin = createStarterPlugin(getStarterState(initial.state)!);
    let state = EditorState.create({
      schema,
      doc: initial.state.doc,
      plugins: [plugin],
    });
    state = state.apply(state.tr.insertText("Title", 1));
    expect(getStarterState(state)).toEqual({ active: false, untouched: false });

    const reloaded = prepareStarterDocument(
      "",
      parseMarkdown("", "github").doc,
    );
    state = state.apply(
      state.tr.replaceWith(0, state.doc.content.size, reloaded.doc.content),
    );
    expect(getStarterState(state)).toEqual({ active: false, untouched: false });

    state = state.apply(
      setStarterMeta(state.tr, {
        active: reloaded.state.active,
        untouched: reloaded.state.untouched,
      }),
    );
    expect(getStarterState(state)).toEqual(reloaded.state);
    expect(isStarterUntouched(state)).toBe(true);
  });

  it("does not create a transaction during an IME composition on the blank starter", () => {
    const { app, messages, root } = makeApp("");
    const editor = app.view.dom;
    editor.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    editor.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true }),
    );
    expect(root.querySelector("h1.mm-starter-title")).not.toBeNull();
    expect(messagesOfType(messages, "edit")).toHaveLength(0);
  });

  it("keeps blank source through dedicated preview, Source, formatting, and Save", async () => {
    const { app, root, messages } = makeApp("");
    root
      .querySelector<HTMLButtonElement>('[aria-label="Format Markdown"]')!
      .click();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(messagesOfType(messages, "format")).toHaveLength(1);
    app.receiveDocument(hostDocument("", 2, "format"));

    app.receiveDocument({
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      markdown: "",
      version: 3,
      profile: "github",
      mode: "preview",
      reason: "external",
    });
    expect(app.mode).toBe("preview");
    expect(root.querySelector("[data-testid=preview-content] h1")).toBeNull();
    expect(
      root.querySelector<HTMLElement>("[data-testid=preview-content]")
        ?.textContent,
    ).toBe("");

    root.querySelector<HTMLButtonElement>('[data-mode="source"]')!.click();
    expect(messagesOfType(messages, "source")).toHaveLength(1);
    expect(
      root.querySelector<HTMLTextAreaElement>(".mm-source-textarea")?.value,
    ).toBe("");

    app.receiveDocument({
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      markdown: "",
      version: 4,
      profile: "github",
      mode: "editor",
      reason: "external",
    });
    const save = new KeyboardEvent("keydown", {
      key: "s",
      ctrlKey: true,
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    app.view.dom.dispatchEvent(save);
    expect(messagesOfType(messages, "edit")).toHaveLength(0);
    expect(messagesOfType(messages, "save")).toHaveLength(1);
    expect(
      root.querySelector<HTMLTextAreaElement>(".mm-source-textarea")?.value,
    ).toBe("");
  });

  it("starts a blank external or undo document with the virtual H1", () => {
    const external = makeApp("Existing");
    external.app.receiveDocument(hostDocument("", 2, "external"));
    expect(external.root.querySelector("h1.mm-starter-title")).not.toBeNull();
    external.app.destroy();
    apps.splice(apps.indexOf(external.app), 1);

    const undone = makeApp("Existing");
    undone.app.receiveDocument(hostDocument("", 2, "undo"));
    expect(undone.root.querySelector("h1.mm-starter-title")).not.toBeNull();
  });

  it("keeps the starter visual while a blank document is only reloaded", () => {
    const { app, root, messages } = makeApp("");
    app.receiveDocument(hostDocument("", 2, "external"));
    expect(root.querySelector("h1.mm-starter-title")).not.toBeNull();
    expect(messagesOfType(messages, "edit")).toHaveLength(0);
  });
});
