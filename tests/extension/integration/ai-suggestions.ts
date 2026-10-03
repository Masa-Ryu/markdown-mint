import assert from "node:assert/strict";
import * as vscode from "vscode";
import {
  EditorState,
  TextSelection,
  type Transaction,
} from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { parseMarkdown, serializeMarkdown } from "../../../src/core";
import { MarkdownMintEditorProvider } from "../../../src/extension/extension";
import type {
  AiModel,
  AiSuggestionsEnvironment,
} from "../../../src/extension/aiSuggestions";
import { isHostMessage } from "../../../src/shared/protocol";
import { AiSuggestionsController } from "../../../src/webview/aiSuggestions";
import { SyncController } from "../../../src/webview/editor";

/** Real native document/history APIs; only the model and panel transport are fakes. */
export async function runAiSuggestionAcceptance(
  extensionUri: vscode.Uri,
  documentUri: vscode.Uri,
): Promise<void> {
  const document = await vscode.workspace.openTextDocument(documentUri);
  await vscode.window.showTextDocument(document, { preview: false });
  const input = new vscode.EventEmitter<unknown>();
  const disposal = new vscode.EventEmitter<void>();
  let configuredModel = "";
  let modelCalls = 0;
  let editMessages = 0;
  let suggestionReady = false;
  const model: AiModel = {
    id: "acceptance-fake",
    name: "Acceptance fake",
    vendor: "copilot",
    maxInputTokens: 4096,
    countTokens: async () => 20,
    sendRequest: async () => {
      modelCalls += 1;
      return {
        text: (async function* () {
          yield " continues🌿";
        })(),
      } as unknown as vscode.LanguageModelChatResponse;
    },
  };
  const environment: AiSuggestionsEnvironment = {
    supported: () => true,
    trusted: () => true,
    settings: () => ({ autoTrigger: false, model: configuredModel }),
    saveModel: async (id) => {
      configuredModel = id;
    },
    models: async () => [model],
    access: () => true,
    choose: async () => model,
    explain: async () => true,
    notify: (reason) => assert.fail(`Unexpected AI failure: ${reason}`),
    user: (text) => vscode.LanguageModelChatMessage.User(text),
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
  const controller = new AiSuggestionsController({
    view: () => ({ state, focus: () => undefined }) as unknown as EditorView,
    canSuggest: () => true,
    synced: () => !sync.hasPending,
    version: () => version,
    documentId: () => documentUri.toString(),
    post: (message) => input.fire(message),
    dispatch: (transaction: Transaction) => {
      const previous = state;
      state = state.apply(transaction);
      controller.transactionApplied(
        transaction.docChanged,
        !previous.selection.eq(state.selection),
        transaction.storedMarksSet,
      );
      if (transaction.docChanged) sync.enqueue(serializeMarkdown(state.doc));
      return true;
    },
  });
  const setSource = (source: string): void => {
    const doc = parseMarkdown(source, "github").doc;
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
    // The preceding user edit must be fully acknowledged before taking the AI snapshot.
    setSource("Native prose writer\n");
    sync.enqueue("Native prose writer\n");
    await waitFor(
      () => !sync.hasPending && document.getText() === "Native prose writer\n",
      "preceding input sync",
    );
    const before = document.getText();
    const beforeVersion = document.version;
    const beforeEdits = editMessages;
    await provider.triggerAiSuggestion();
    await waitFor(() => suggestionReady, "fake AI response");
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
    assert.equal(state.doc.textContent, "Native prose writer continues🌿");
    const accepted = serializeMarkdown(state.doc);
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
    // A later input is a separate history entry even immediately after acceptance.
    setSource(accepted + "\nLater input\n");
    sync.enqueue(accepted + "\nLater input\n");
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
      `AI native acceptance: ${vscode.version}; fake model sends=${modelCalls}; ghost unchanged; isolated Undo/Redo passed.`,
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
      throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
