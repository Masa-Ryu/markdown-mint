import assert from "node:assert/strict";
import * as vscode from "vscode";
import {
  EditorState,
  TextSelection,
  type Transaction,
} from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { buildMarkdownPositionMap } from "../../../src/core/markdownPositionMap";
import { parseMarkdown, serializeMarkdown } from "../../../src/core";
import type { CopilotLanguageServer } from "../../../src/extension/copilotLanguageServer";
import { MarkdownMintEditorProvider } from "../../../src/extension/extension";
import type { AiSuggestionsEnvironment } from "../../../src/extension/aiSuggestions";
import { isHostMessage } from "../../../src/shared/protocol";
import { AiSuggestionsController } from "../../../src/webview/aiSuggestions";
import { SyncController } from "../../../src/webview/editor";

/** Native TextDocument/history with the production provider and fake LSP transport. */
export async function runAiSuggestionAcceptance(
  extensionUri: vscode.Uri,
  documentUri: vscode.Uri,
): Promise<void> {
  const document = await vscode.workspace.openTextDocument(documentUri);
  await vscode.window.showTextDocument(document, { preview: false });
  const input = new vscode.EventEmitter<unknown>();
  const disposal = new vscode.EventEmitter<void>();
  let modelCalls = 0;
  let editMessages = 0;
  let suggestionReady = false;
  const server = {
    currentStatus: {
      kind: "Normal",
      busy: false,
      message: "Copilot signed in (fake server)",
    },
    isRunning: true,
    start: async () => undefined,
    synchronizeDocument: async () => undefined,
    focusDocument: async () => undefined,
    requestInlineCompletion: async () => {
      modelCalls += 1;
      return { items: [{ insertText: " continues🌿" }] };
    },
    reportShown: () => undefined,
    reportPartiallyAccepted: () => undefined,
    reportAccepted: async () => undefined,
    closeDocument: async () => undefined,
    dispose: () => undefined,
  } as unknown as CopilotLanguageServer;
  const environment: AiSuggestionsEnvironment = {
    server,
    supported: () => true,
    trusted: () => true,
    settings: () => ({ autoTrigger: false }),
    notify: (message) => assert.fail("Unexpected AI status: " + message),
    tokenSource: () => new vscode.CancellationTokenSource(),
  };
  const sync = new SyncController(
    document.version,
    {
      postMessage: (message) => {
        if ((message as { type?: string }).type === "edit") editMessages += 1;
        input.fire(message);
      },
    },
    document.getText(),
  );
  let state!: EditorState;
  let version = document.version;
  let source = document.getText();
  let snapshot = parseMarkdown(source, "github");
  const controller = new AiSuggestionsController({
    view: () => ({ state, focus: () => undefined }) as unknown as EditorView,
    canSuggest: () => true,
    synced: () => !sync.hasPending,
    version: () => version,
    documentId: () => documentUri.toString(),
    markdown: () => source,
    profile: () => "github",
    sourceOffset: (current, position) =>
      buildMarkdownPositionMap(
        source,
        current.doc,
        "github",
        {
          parseMarkdown: (value, profile) => parseMarkdown(value, profile),
          serializeMarkdown,
        },
        snapshot,
      ).pmPositionToSourceOffset(position),
    parseMarkdown: (markdown, profile) => parseMarkdown(markdown, profile),
    post: (message) => input.fire(message),
    dispatch: (transaction: Transaction) => {
      const previous = state;
      state = state.apply(transaction);
      controller.transactionApplied(
        transaction.docChanged,
        !previous.selection.eq(state.selection),
        transaction.storedMarksSet,
      );
      if (transaction.docChanged) {
        source = serializeMarkdown(state.doc, snapshot);
        snapshot = parseMarkdown(source, "github");
        sync.enqueue(source);
      }
      return true;
    },
  });
  const setSource = (next: string): void => {
    source = next;
    snapshot = parseMarkdown(source, "github");
    const doc = snapshot.doc;
    state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, doc.content.size - 1),
      plugins: [controller.plugin],
    });
  };
  setSource(document.getText());
  const panel = {
    active: true,
    visible: true,
    viewColumn: vscode.ViewColumn.One,
    reveal: () => undefined,
    onDidDispose: disposal.event,
    webview: {
      html: "",
      options: {},
      cspSource: "https://acceptance.invalid",
      asWebviewUri: (uri: vscode.Uri) => uri,
      onDidReceiveMessage: input.event,
      postMessage: async (message: unknown) => {
        assert.ok(isHostMessage(message));
        if (message.type === "document") {
          version = message.version;
          sync.acknowledge(
            message.operationId,
            message.version,
            message.markdown,
          );
          sync.noteAuthoritative(message.version, message.markdown);
          if (message.reason !== "ack") {
            controller.invalidate();
            setSource(message.markdown);
          }
          controller.syncChanged();
        } else if (
          message.type === "ai-suggestion-state" ||
          message.type === "ai-suggestion-trigger" ||
          message.type === "ai-suggestion-result"
        ) {
          controller.handleMessage(message);
          if (
            message.type === "ai-suggestion-result" &&
            message.reason === "ready"
          )
            suggestionReady = true;
        }
        return true;
      },
    },
  } as unknown as vscode.WebviewPanel;
  const provider = new MarkdownMintEditorProvider(
    { extensionUri, subscriptions: [] } as unknown as vscode.ExtensionContext,
    environment,
  );
  try {
    await provider.resolveCustomTextEditor(
      document,
      panel,
      new vscode.CancellationTokenSource().token,
    );
    input.fire({ protocolVersion: 1, type: "ready" });
    await waitFor(() => version === document.version, "AI panel handshake");
    setSource("Native prose\n");
    sync.enqueue("Native prose\n");
    await waitFor(
      () => !sync.hasPending && document.getText() === "Native prose\n",
      "preceding input sync",
    );
    const before = document.getText();
    const beforeVersion = document.version;
    const beforeEdits = editMessages;
    await provider.triggerAiSuggestion();
    await waitFor(() => suggestionReady, "fake Copilot LSP response");
    assert.equal(modelCalls, 1);
    assert.equal(
      document.getText(),
      before,
      "ghost display never changes native text",
    );
    assert.equal(
      document.version,
      beforeVersion,
      "ghost display never advances native version",
    );
    assert.equal(editMessages, beforeEdits, "ghost display sends no edit");
    assert.equal(controller.acceptSuggestion(), true);
    assert.equal(state.doc.textContent, "Native prose continues🌿");
    const accepted = source;
    await waitFor(
      () => !sync.hasPending && document.getText() === accepted,
      "AI acceptance sync",
    );
    assert.equal(editMessages, beforeEdits + 1);
    input.fire({
      protocolVersion: 1,
      type: "undo",
      operationId: "ai-undo-1",
      baseVersion: document.version,
    });
    await waitFor(
      () => document.getText() === before,
      "single native Undo removes only the candidate",
    );
    input.fire({
      protocolVersion: 1,
      type: "redo",
      operationId: "ai-redo-1",
      baseVersion: document.version,
    });
    await waitFor(
      () => document.getText() === accepted,
      "native Redo restores the candidate",
    );
    setSource(accepted + "Later input\n");
    sync.enqueue(accepted + "Later input\n");
    await waitFor(
      () => !sync.hasPending && document.getText().includes("Later input"),
      "following input sync",
    );
    input.fire({
      protocolVersion: 1,
      type: "undo",
      operationId: "ai-undo-following",
      baseVersion: document.version,
    });
    await waitFor(
      () => document.getText() === accepted,
      "following input has its own history boundary",
    );
    console.log(
      "AI native acceptance: " +
        vscode.version +
        "; fake LSP completions=" +
        modelCalls +
        "; ghost unchanged; isolated Undo/Redo passed.",
    );
  } finally {
    controller.dispose();
    provider.dispose();
    input.dispose();
    disposal.dispose();
  }
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for " + label);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
