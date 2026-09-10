import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";

const VIEW_TYPE = "markdownWeaver.editor";
const TEST_FILE = process.env.MARKDOWN_WEAVER_TEST_FILE;

/**
 * Small Extension Development Host acceptance suite. It intentionally uses
 * only public VS Code APIs so the same checks can run against the installed
 * Code build selected by scripts/test-extension.mjs.
 */
export async function run(): Promise<void> {
  assert.ok(TEST_FILE, "MARKDOWN_WEAVER_TEST_FILE must point at a fixture");
  const filePath = path.resolve(TEST_FILE);
  const fileUri = vscode.Uri.file(filePath);
  const extension = vscode.extensions.getExtension(
    "markdown-weaver-local.markdown-weaver",
  );
  assert.ok(extension, "Markdown Weaver is available in the development host");
  const api = await extension.activate();
  assert.equal(typeof api.extendMarkdownIt, "function");
  assert.equal(typeof api.renderWithNativeMarkdown, "function");

  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    "markdownWeaver.openPreview",
    "markdownWeaver.openSource",
    "markdownWeaver.formatDocument",
  ]) {
    assert.ok(commands.includes(command), `registered command: ${command}`);
  }

  let document = await vscode.workspace.openTextDocument(fileUri);
  assert.equal(document.languageId, "markdown");
  const original = document.getText();

  await vscode.commands.executeCommand("vscode.openWith", fileUri, VIEW_TYPE);
  await waitFor(
    () =>
      vscode.window.tabGroups.all.some((group) =>
        group.tabs.some((tab) => {
          const input = tab.input;
          return (
            input instanceof vscode.TabInputCustom &&
            input.viewType === VIEW_TYPE &&
            input.uri.toString() === fileUri.toString()
          );
        }),
      ),
    "the Markdown Weaver custom editor to open",
  );

  const customChanged = `${original}\n<!-- custom resource edit -->\n`;
  const customWorkspaceEdit = new vscode.WorkspaceEdit();
  customWorkspaceEdit.replace(
    fileUri,
    fullDocumentRange(document),
    customChanged,
  );
  assert.equal(
    await vscode.workspace.applyEdit(customWorkspaceEdit),
    true,
    "a WorkspaceEdit should apply while the custom editor is active",
  );
  await waitFor(
    () => document.getText() === customChanged,
    "the custom editor resource edit",
  );
  await vscode.commands.executeCommand("undo");
  await waitFor(
    () => document.getText() === original,
    "native undo with the custom editor active",
  );
  await vscode.commands.executeCommand("redo");
  await waitFor(
    () => document.getText() === customChanged,
    "native redo with the custom editor active",
  );

  // Open a separate source document before testing native history. This keeps
  // the custom editor's resource history check above independent while still
  // exercising a real source TextEditor and the same native undo service.
  const sourceHistoryUri = vscode.Uri.file(
    path.join(path.dirname(filePath), "source-history.md"),
  );
  let sourceHistoryDocument =
    await vscode.workspace.openTextDocument(sourceHistoryUri);
  await vscode.commands.executeCommand(
    "markdownWeaver.openSource",
    sourceHistoryUri,
  );
  const sourceEditor = await vscode.window.showTextDocument(
    sourceHistoryDocument,
    {
      preview: false,
    },
  );
  const sourceOriginal = sourceHistoryDocument.getText();
  const sourceChanged = `${sourceOriginal}\n<!-- native acceptance edit -->\n`;
  const applied = await sourceEditor.edit((builder) => {
    builder.replace(fullDocumentRange(sourceHistoryDocument), sourceChanged);
  });
  assert.equal(applied, true, "native source edit should apply");
  await waitFor(
    () => sourceHistoryDocument.getText() === sourceChanged,
    "the source document edit",
  );
  await vscode.commands.executeCommand("undo");
  await waitFor(
    () => sourceHistoryDocument.getText() === sourceOriginal,
    "native source undo to restore the original document",
  );
  await vscode.commands.executeCommand("redo");
  await waitFor(
    () => sourceHistoryDocument.getText() === sourceChanged,
    "native source redo to restore the edit",
  );

  // The extension format command applies a minimal WorkspaceEdit. The
  // fixture intentionally has no final newline so disk output proves the
  // formatter and save path ran.
  await vscode.commands.executeCommand("markdownWeaver.openSource", fileUri);
  document = await vscode.workspace.openTextDocument(fileUri);
  const sourceDocumentEditor = await vscode.window.showTextDocument(document, {
    preview: false,
  });
  const unformatted = "# Native format check";
  await sourceDocumentEditor.edit((builder) => {
    builder.replace(fullDocumentRange(document), unformatted);
  });
  await vscode.commands.executeCommand(
    "markdownWeaver.formatDocument",
    fileUri,
  );
  document = await vscode.workspace.openTextDocument(fileUri);
  await waitFor(
    () => document.getText() === `${unformatted}\r\n`,
    "the native format command to add the final newline",
  );
  await document.save();
  assert.equal(await readFile(filePath, "utf8"), `${unformatted}\r\n`);

  const configuration = vscode.workspace.getConfiguration(
    "markdownWeaver",
    fileUri,
  );
  await configuration.update(
    "formatOnSave",
    true,
    vscode.ConfigurationTarget.Workspace,
  );
  await sourceDocumentEditor.edit((builder) => {
    builder.replace(fullDocumentRange(document), "# Format on save check");
  });
  await document.save();
  assert.equal(
    await readFile(filePath, "utf8"),
    "# Format on save check\r\n",
    "format-on-save must format the file before it reaches disk",
  );

  const nativeHtml = await vscode.commands.executeCommand<unknown>(
    "markdown.api.render",
    document,
  );
  const nativeHtmlText = extractHtml(nativeHtml);
  assert.match(nativeHtmlText, /<h1\b[^>]*>Format on save check<\/h1>/);

  // The extension API accepts source strings for callers that do not have an
  // ITextDocument. URI/profile-sensitive rendering is covered by the native
  // command above, which receives the real TextDocument and current URI.
  const apiHtml = await api.renderWithNativeMarkdown("# API render check");
  assert.match(apiHtml, /<h1\b[^>]*>API render check<\/h1>/);

  const tableSource = "| A | B |\n| --- | --- |\n| 1 | 2 |\n";
  await sourceDocumentEditor.edit((builder) => {
    builder.replace(fullDocumentRange(document), tableSource);
  });
  document = await vscode.workspace.openTextDocument(fileUri);
  await configuration.update(
    "profile",
    "github",
    vscode.ConfigurationTarget.Workspace,
  );
  const githubHtml = extractHtml(
    await vscode.commands.executeCommand<unknown>(
      "markdown.api.render",
      document,
    ),
  );
  assert.match(githubHtml, /<table\b/);
  await configuration.update(
    "profile",
    "commonmark",
    vscode.ConfigurationTarget.Workspace,
  );
  const commonmarkHtml = extractHtml(
    await vscode.commands.executeCommand<unknown>(
      "markdown.api.render",
      document,
    ),
  );
  assert.doesNotMatch(commonmarkHtml, /<table\b/);

  const imageSource = "![icon](assets/icon.svg)\n";
  const imageEditor = await vscode.window.showTextDocument(document, {
    preview: false,
  });
  await imageEditor.edit((builder) => {
    builder.replace(fullDocumentRange(document), imageSource);
  });
  document = await vscode.workspace.openTextDocument(fileUri);
  const imageHtml = extractHtml(
    await vscode.commands.executeCommand<unknown>(
      "markdown.api.render",
      document,
    ),
  );
  assert.match(imageHtml, /src="[^"]*icon\.svg[^"]*"/);

  await configuration.update(
    "profile",
    "github",
    vscode.ConfigurationTarget.Workspace,
  );
  const configUri = vscode.Uri.file(
    path.join(path.dirname(filePath), "config.md"),
  );
  const configDocument = await vscode.workspace.openTextDocument(configUri);
  await vscode.commands.executeCommand(
    "markdownWeaver.formatDocument",
    configUri,
  );
  await configDocument.save();
  const configDisk = await readFile(configUri.fsPath, "utf8");
  assert.match(configDisk, /\r\n/, "the project EditorConfig CRLF setting");
  assert.ok(
    configDisk
      .split("\r\n")
      .filter((line) => line.length > 0)
      .every((line) => line.length <= 24),
    "the project Prettier printWidth/proseWrap settings should apply",
  );

  const ignoredUri = vscode.Uri.file(
    path.join(path.dirname(filePath), "ignored.md"),
  );
  const ignoredDocument = await vscode.workspace.openTextDocument(ignoredUri);
  const ignoredBefore = ignoredDocument.getText();
  await vscode.commands.executeCommand(
    "markdownWeaver.formatDocument",
    ignoredUri,
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  assert.equal(
    ignoredDocument.getText(),
    ignoredBefore,
    ".prettierignore must leave an ignored source untouched",
  );

  await configuration.update(
    "formatOnSave",
    undefined,
    vscode.ConfigurationTarget.Workspace,
  );
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
}

function fullDocumentRange(document: vscode.TextDocument): vscode.Range {
  return new vscode.Range(
    document.positionAt(0),
    document.positionAt(document.getText().length),
  );
}

function extractHtml(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const html = (value as { html?: unknown }).html;
    if (typeof html === "string") return html;
  }
  return "";
}

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 10_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started >= timeoutMs)
      throw new Error(`Timed out waiting for ${description}.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}
