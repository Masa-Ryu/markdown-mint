import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AiSuggestionRequest,
  AiSuggestionResult,
  AiWebviewMessage,
} from "../../src/shared/aiSuggestions";
import { MermaidAiSuggestionsController } from "../../src/webview/mermaidAiSuggestions";

const source = "flowchart TD\n  A[Start] -->";

function makeHarness() {
  const container = document.createElement("div");
  const input = document.createElement("textarea");
  container.append(input);
  document.body.append(container);
  input.value = source;
  input.setSelectionRange(source.length, source.length);
  input.focus();
  let version = 3;
  let markdown = "# Diagram\n";
  let synced = true;
  let documentId: string | undefined = "file:///diagram.md";
  let dialogGeneration = 7;
  const messages: AiWebviewMessage[] = [];
  const status: string[] = [];
  const inputEvents = vi.fn();
  input.addEventListener("input", inputEvents);
  const controller = new MermaidAiSuggestionsController({
    input,
    canSuggest: () => true,
    synced: () => synced,
    version: () => version,
    documentId: () => documentId,
    markdown: () => markdown,
    dialogGeneration: () => dialogGeneration,
    post: (message) => messages.push(message),
    reportStatus: (message) => status.push(message),
  });
  controller.attach();
  controller.surfaceStateChanged({
    screen: "editor",
    pickerOrigin: null,
    confirmation: null,
    imeActive: false,
  });
  controller.handleMessage({
    protocolVersion: 1,
    type: "ai-suggestion-state",
    sessionId: "s1",
    settingsGeneration: 2,
    autoTrigger: true,
    availability: "ready",
    active: true,
  });

  return {
    container,
    input,
    controller,
    messages,
    status,
    inputEvents,
    async manual(): Promise<AiSuggestionRequest> {
      controller.handleMessage({
        protocolVersion: 1,
        type: "ai-suggestion-trigger",
        sessionId: "s1",
        settingsGeneration: 2,
        invocationId: "manual-1",
      });
      await vi.advanceTimersByTimeAsync(0);
      const request = messages
        .filter(
          (message): message is AiSuggestionRequest =>
            message.type === "ai-suggestion-request",
        )
        .at(-1);
      if (!request) throw new Error("Mermaid request was not posted");
      return request;
    },
    respond(request: AiSuggestionRequest, text: string): void {
      const result: AiSuggestionResult = {
        protocolVersion: 1,
        type: "ai-suggestion-result",
        requestId: request.requestId,
        sessionId: request.sessionId,
        documentId: request.documentId,
        baseVersion: request.baseVersion,
        editorRevision: request.editorRevision,
        settingsGeneration: request.settingsGeneration,
        position: request.position,
        targetKind: request.targetKind,
        text,
        reason: "ready",
      };
      controller.handleMessage(result);
    },
    setSynced(value: boolean): void {
      synced = value;
    },
    setVersion(value: number): void {
      version = value;
    },
    setMarkdown(value: string): void {
      markdown = value;
    },
    setDocumentId(value: string | undefined): void {
      documentId = value;
    },
    setDialogGeneration(value: number): void {
      dialogGeneration = value;
    },
    dispose(): void {
      controller.dispose();
      container.remove();
    },
  };
}

function fakeRuntime(parse: (source: string) => unknown) {
  Object.defineProperty(globalThis, "markdownMintMermaid", {
    configurable: true,
    value: { render: () => "<svg></svg>", parse: vi.fn(parse) },
  });
  return (
    globalThis as typeof globalThis & {
      markdownMintMermaid: { parse: ReturnType<typeof vi.fn> };
    }
  ).markdownMintMermaid.parse;
}

function displayState(
  screen: "closed" | "picker" | "editor",
  confirmation: "apply" | null = null,
  imeActive = false,
) {
  return {
    screen,
    pickerOrigin: screen === "picker" ? ("editor" as const) : null,
    confirmation,
    imeActive,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  delete (globalThis as typeof globalThis & { markdownMintMermaid?: unknown })
    .markdownMintMermaid;
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("Mermaid textarea Copilot ghost", () => {
  it("validates the full proposal and accepts into the dialog draft only", async () => {
    const parse = fakeRuntime(() => ({ diagramType: "flowchart-v2" }));
    const f = makeHarness();
    const request = await f.manual();
    expect(request).toMatchObject({
      targetKind: "mermaid",
      surfaceText: source,
      surfacePosition: source.length,
    });

    f.respond(request, " B[End]");
    await vi.waitFor(() => expect(parse).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(f.container.querySelector(".mm-ai-suggestion")?.textContent).toBe(
        " B[End]",
      ),
    );
    expect(f.status).not.toContain(
      "Suggestion available. Press Tab to accept or Escape to dismiss.",
    );
    expect(parse).toHaveBeenCalledWith(`${source} B[End]`);
    expect(f.input.value).toBe(source);
    expect(
      f.container
        .querySelector(".mm-ai-textarea-ghost-overlay")
        ?.getAttribute("aria-hidden"),
    ).toBe("true");

    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    f.input.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(f.input.value).toBe(source);
    expect(f.container.querySelector(".mm-ai-suggestion")).toBeNull();

    const nextRequest = await f.manual();
    f.respond(nextRequest, " B[End]");
    await vi.waitFor(() =>
      expect(f.container.querySelector(".mm-ai-suggestion")).not.toBeNull(),
    );
    const tab = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    f.input.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(f.input.value).toBe(`${source} B[End]`);
    expect(f.inputEvents).toHaveBeenCalledOnce();
    expect(f.messages.at(-1)).toMatchObject({
      type: "ai-suggestion-cancel",
      requestId: nextRequest.requestId,
    });
    f.dispose();
  });

  it("rejects syntax errors and a missing local Mermaid runtime", async () => {
    const parse = fakeRuntime(() => {
      throw new Error("Syntax error");
    });
    const f = makeHarness();
    const request = await f.manual();
    f.respond(request, " )");
    await vi.waitFor(() => expect(parse).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(f.status).toContain(
        "The Mermaid suggestion was skipped because it would make the diagram invalid.",
      ),
    );
    expect(f.container.querySelector(".mm-ai-suggestion")).toBeNull();
    f.dispose();

    delete (globalThis as typeof globalThis & { markdownMintMermaid?: unknown })
      .markdownMintMermaid;
    const offline = makeHarness();
    const offlineRequest = await offline.manual();
    offline.respond(offlineRequest, " B[End]");
    await Promise.resolve();
    await Promise.resolve();
    expect(offline.container.querySelector(".mm-ai-suggestion")).toBeNull();
    expect(offline.input.value).toBe(source);
    offline.dispose();
  });

  it("preserves a matching typed prefix and uses one 300ms auto debounce after mismatch", async () => {
    fakeRuntime(() => ({ diagramType: "flowchart-v2" }));
    const f = makeHarness();
    const request = await f.manual();
    f.respond(request, " B[End]");
    await vi.waitFor(() =>
      expect(f.container.querySelector(".mm-ai-suggestion")).not.toBeNull(),
    );
    f.input.setRangeText(" B", source.length, source.length, "end");
    f.input.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: " B",
      }),
    );
    expect(f.container.querySelector(".mm-ai-suggestion")?.textContent).toBe(
      "[End]",
    );

    f.input.setRangeText(
      "x",
      f.input.selectionStart,
      f.input.selectionEnd,
      "end",
    );
    f.input.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: "x",
      }),
    );
    expect(f.container.querySelector(".mm-ai-suggestion")).toBeNull();
    await vi.advanceTimersByTimeAsync(299);
    expect(
      f.messages.filter((message) => message.type === "ai-suggestion-request"),
    ).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(
      f.messages.filter((message) => message.type === "ai-suggestion-request"),
    ).toHaveLength(2);
    f.dispose();
  });

  it("keeps a same-version request current during save sync and rejects a newer document version", async () => {
    fakeRuntime(() => ({ diagramType: "flowchart-v2" }));
    const f = makeHarness();
    const request = await f.manual();
    f.setSynced(false);
    f.respond(request, " B[End]");
    await vi.waitFor(() =>
      expect(f.container.querySelector(".mm-ai-suggestion")).not.toBeNull(),
    );
    expect(f.input.value).toBe(source);
    f.controller.onNativeDocumentChanged(
      "file:///diagram.md",
      4,
      "# Diagram\n",
    );
    expect(f.container.querySelector(".mm-ai-suggestion")).toBeNull();
    f.setSynced(true);
    f.dispose();
  });

  it("cancels off-surface work and leaves IME Tab and Escape to the editor", async () => {
    fakeRuntime(() => ({ diagramType: "flowchart-v2" }));
    const f = makeHarness();
    const request = await f.manual();
    f.controller.surfaceStateChanged(displayState("picker"));
    expect(f.messages.at(-1)).toMatchObject({
      type: "ai-suggestion-cancel",
      requestId: request.requestId,
    });
    f.respond(request, " B[End]");
    await Promise.resolve();
    expect(f.container.querySelector(".mm-ai-suggestion")).toBeNull();

    f.controller.surfaceStateChanged(displayState("editor", null, true));
    for (const key of ["Tab", "Escape"]) {
      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, "keyCode", { value: 229 });
      f.input.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    f.controller.surfaceStateChanged(displayState("closed"));
    f.setVersion(4);
    f.setMarkdown("# changed\n");
    f.setDocumentId(undefined);
    f.setDialogGeneration(8);
    f.dispose();
  });
});
