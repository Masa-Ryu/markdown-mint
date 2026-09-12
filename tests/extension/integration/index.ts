import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";

const VIEW_TYPE = "markdownMint.editor";
const TEST_FILE = process.env.MARKDOWN_MINT_TEST_FILE;
const OPEN_IN_MINT_COMMAND = "markdownMint.openInEditor";
const OPEN_IN_MINT_TITLE = "🌿 Open in Markdown Mint";

/**
 * Small Extension Development Host acceptance suite. It intentionally uses
 * only public VS Code APIs so the same checks can run against the installed
 * Code build selected by scripts/test-extension.mjs.
 */
export async function run(): Promise<void> {
  assert.ok(TEST_FILE, "MARKDOWN_MINT_TEST_FILE must point at a fixture");
  const filePath = path.resolve(TEST_FILE);
  const fileUri = vscode.Uri.file(filePath);
  const extension = vscode.extensions.getExtension(
    "masa-ryu.markdown-mint",
  );
  assert.ok(extension, "Markdown Mint is available in the development host");
  await runCodeLensAcceptance(filePath, fileUri, extension);
  const api = await extension.activate();
  assert.equal(typeof api.extendMarkdownIt, "function");
  assert.equal(typeof api.renderWithNativeMarkdown, "function");

  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    "markdownMint.openPreview",
    "markdownMint.openSource",
    "markdownMint.formatDocument",
    OPEN_IN_MINT_COMMAND,
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
    "the Markdown Mint custom editor to open",
  );

  const customGroup = vscode.window.tabGroups.all.find((group) =>
    group.tabs.some((tab) => {
      const input = tab.input;
      return (
        input instanceof vscode.TabInputCustom &&
        input.viewType === VIEW_TYPE &&
        input.uri.toString() === fileUri.toString()
      );
    }),
  );
  assert.ok(customGroup, "the custom editor has an editor group");
  const customViewColumn = customGroup.viewColumn;

  await vscode.commands.executeCommand("markdownMint.openSource", fileUri);
  await waitFor(() => {
    const activeGroup = vscode.window.tabGroups.activeTabGroup;
    const input = activeGroup.activeTab?.input;
    return (
      activeGroup.viewColumn === customViewColumn &&
      input instanceof vscode.TabInputText &&
      input.uri.toString() === fileUri.toString()
    );
  }, "the standard source editor in the custom editor group");
  const standardSourceEditor = vscode.window.activeTextEditor;
  assert.ok(
    standardSourceEditor,
    "the standard Markdown source editor is active",
  );
  assert.equal(
    standardSourceEditor.document.uri.toString(),
    fileUri.toString(),
  );
  assert.equal(standardSourceEditor.document.languageId, "markdown");
  assert.equal(
    standardSourceEditor.viewColumn,
    customViewColumn,
    "the standard source editor stays in the custom editor group",
  );

  await vscode.commands.executeCommand("vscode.openWith", fileUri, VIEW_TYPE, {
    viewColumn: customViewColumn,
    preview: false,
    preserveFocus: false,
  });
  await waitFor(() => {
    const activeInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return (
      activeInput instanceof vscode.TabInputCustom &&
      activeInput.viewType === VIEW_TYPE &&
      activeInput.uri.toString() === fileUri.toString()
    );
  }, "the Markdown Mint custom editor to become active again");

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
    "markdownMint.openSource",
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
  await vscode.commands.executeCommand("markdownMint.openSource", fileUri);
  document = await vscode.workspace.openTextDocument(fileUri);
  const sourceDocumentEditor = await vscode.window.showTextDocument(document, {
    preview: false,
  });
  const unformatted = "# Native format check";
  await sourceDocumentEditor.edit((builder) => {
    builder.replace(fullDocumentRange(document), unformatted);
  });
  await vscode.commands.executeCommand("markdownMint.formatDocument", fileUri);
  document = await vscode.workspace.openTextDocument(fileUri);
  await waitFor(
    () => document.getText() === `${unformatted}\r\n`,
    "the native format command to add the final newline",
  );
  await document.save();
  assert.equal(await readFile(filePath, "utf8"), `${unformatted}\r\n`);

  const configuration = vscode.workspace.getConfiguration(
    "markdownMint",
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
  const profileGroupBefore = vscode.window.tabGroups.activeTabGroup;
  const profileTabBefore = profileGroupBefore.activeTab;
  assert.ok(
    profileTabBefore,
    "the source tab remains active for profile changes",
  );
  assert.ok(
    profileTabBefore.input instanceof vscode.TabInputText &&
      profileTabBefore.input.uri.toString() === fileUri.toString(),
    "profile changes start from the same Markdown source tab",
  );
  const profileTabIndexBefore =
    profileGroupBefore.tabs.indexOf(profileTabBefore);
  const profileTabCountBefore = profileGroupBefore.tabs.length;
  const profileTextBefore = document.getText();
  const profileDiskBefore = await readFile(filePath, "utf8");

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
  await configuration.update(
    "profile",
    "github",
    vscode.ConfigurationTarget.Workspace,
  );
  const githubAgainHtml = extractHtml(
    await vscode.commands.executeCommand<unknown>(
      "markdown.api.render",
      document,
    ),
  );
  assert.match(githubAgainHtml, /<table\b/);
  assert.equal(document.getText(), profileTextBefore);
  assert.equal(
    await readFile(filePath, "utf8"),
    profileDiskBefore,
    "profile changes must not write the source file",
  );
  const profileGroupAfter = vscode.window.tabGroups.all.find(
    (group) => group.viewColumn === profileGroupBefore.viewColumn,
  );
  assert.ok(
    profileGroupAfter,
    "the source group remains after profile changes",
  );
  assert.equal(profileGroupAfter.tabs.length, profileTabCountBefore);
  const profileTabAfter = profileGroupAfter.activeTab;
  assert.ok(
    profileTabAfter,
    "the source tab remains active after profile changes",
  );
  assert.equal(
    profileGroupAfter.tabs.indexOf(profileTabAfter),
    profileTabIndexBefore,
  );
  assert.ok(
    profileTabAfter.input instanceof vscode.TabInputText &&
      profileTabAfter.input.uri.toString() === fileUri.toString(),
    "profile changes keep the existing source tab",
  );

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
    "markdownMint.formatDocument",
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
    "markdownMint.formatDocument",
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

async function runCodeLensAcceptance(
  filePath: string,
  fileUri: vscode.Uri,
  extension: vscode.Extension<unknown>,
): Promise<void> {
  const activationEvents = extension.packageJSON.activationEvents;
  assert.ok(
    Array.isArray(activationEvents) &&
      activationEvents.includes("onLanguage:markdown"),
    "Markdown Mint declares onLanguage:markdown activation",
  );

  const markdownDocument = await vscode.workspace.openTextDocument(fileUri);
  const markdownEditor = await vscode.window.showTextDocument(
    markdownDocument,
    { preview: false },
  );
  assert.equal(markdownDocument.languageId, "markdown");
  const sourceViewColumn = markdownEditor.viewColumn;
  assert.ok(sourceViewColumn, "the Markdown source has a view column");
  assert.ok(
    vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof
      vscode.TabInputText,
    "the CodeLens starts in a standard text editor",
  );

  await waitFor(
    () => extension.isActive,
    "Markdown Mint to activate from onLanguage:markdown",
  );

  const plainDocument = await vscode.workspace.openTextDocument({
    language: "plaintext",
    content: "Plain text has no Markdown Mint CodeLens.\n",
  });
  assert.equal(
    (await codeLensesFor(plainDocument.uri)).length,
    0,
    "non-Markdown documents should not receive the CodeLens",
  );

  const siblingUri = vscode.Uri.file(
    path.join(path.dirname(filePath), "source-history.md"),
  );
  const siblingDocument = await vscode.workspace.openTextDocument(siblingUri);
  const siblingEditor = await vscode.window.showTextDocument(siblingDocument, {
    viewColumn: vscode.ViewColumn.Beside,
    preview: false,
  });
  const siblingViewColumn = siblingEditor.viewColumn;
  assert.ok(siblingViewColumn, "the sibling source has a view column");
  assert.notEqual(
    siblingViewColumn,
    sourceViewColumn,
    "the sibling source is in another editor group",
  );

  const sourceEditor = await vscode.window.showTextDocument(markdownDocument, {
    viewColumn: sourceViewColumn,
    preview: false,
  });
  await waitFor(
    () => {
      const activeGroup = vscode.window.tabGroups.activeTabGroup;
      const activeInput = activeGroup.activeTab?.input;
      return (
        activeGroup.viewColumn === sourceViewColumn &&
        activeInput instanceof vscode.TabInputText &&
        activeInput.uri.toString() === fileUri.toString() &&
        vscode.window.activeTextEditor?.document.uri.toString() ===
          fileUri.toString()
      );
    },
    "the Markdown source editor to be active",
  );

  const sourceGroupBefore = vscode.window.tabGroups.all.find(
    (group) => group.viewColumn === sourceViewColumn,
  );
  assert.ok(sourceGroupBefore, "the source editor group is available");
  const sourceTabBefore = sourceGroupBefore.activeTab;
  assert.ok(sourceTabBefore, "the source tab is active");
  const sourceTabIndexBefore = sourceGroupBefore.tabs.indexOf(sourceTabBefore);
  assert.ok(sourceTabIndexBefore >= 0, "the source tab has a stable index");
  const sourceTabCountBefore = sourceGroupBefore.tabs.length;
  const groupShapeBefore = vscode.window.tabGroups.all.map((group) => ({
    viewColumn: group.viewColumn,
    tabCount: group.tabs.length,
  }));
  const siblingGroupBefore = vscode.window.tabGroups.all.find(
    (group) => group.viewColumn === siblingViewColumn,
  );
  assert.ok(siblingGroupBefore, "the sibling editor group is available");
  const siblingTabCountBefore = siblingGroupBefore.tabs.length;
  const diskBefore = await readFile(filePath, "utf8");
  const original = markdownDocument.getText();
  const dirtyText = original + "\n<!-- CodeLens dirty buffer -->\n";

  assert.equal(
    await sourceEditor.edit((builder) => {
      builder.replace(fullDocumentRange(markdownDocument), dirtyText);
    }),
    true,
    "the dirty Markdown edit should apply",
  );
  await waitFor(
    () => markdownDocument.getText() === dirtyText && markdownDocument.isDirty,
    "the dirty Markdown source buffer",
  );

  const lenses = await codeLensesFor(fileUri);
  assert.equal(lenses.length, 1, "Markdown has one CodeLens");
  const lens = lenses.at(0);
  assert.ok(lens, "the Markdown CodeLens is returned");
  assert.ok(lens.command, "the Markdown CodeLens has a command");
  assert.equal(lens.command.title, OPEN_IN_MINT_TITLE);
  assert.equal(lens.command.command, OPEN_IN_MINT_COMMAND);
  assert.ok(
    lens.range.isEqual(new vscode.Range(0, 0, 0, 0)),
    "the CodeLens range is the first line above the document",
  );

  await vscode.commands.executeCommand(
    lens.command.command,
    ...(lens.command.arguments ?? []),
  );
  await waitFor(() => {
    const group = vscode.window.tabGroups.activeTabGroup;
    const input = group.activeTab?.input;
    return (
      group.viewColumn === sourceViewColumn &&
      input instanceof vscode.TabInputCustom &&
      input.viewType === VIEW_TYPE &&
      input.uri.toString() === fileUri.toString()
    );
  }, "the existing source tab to switch to Markdown Mint");

  const sourceGroupAfter = vscode.window.tabGroups.all.find(
    (group) => group.viewColumn === sourceViewColumn,
  );
  assert.ok(sourceGroupAfter, "the source editor group remains available");
  assert.equal(sourceGroupAfter.tabs.length, sourceTabCountBefore);
  const activeTabAfter = sourceGroupAfter.activeTab;
  assert.ok(activeTabAfter, "the switched tab is active");
  assert.equal(
    sourceGroupAfter.tabs.indexOf(activeTabAfter),
    sourceTabIndexBefore,
    "the Markdown Mint editor keeps the source tab index",
  );
  assert.deepEqual(
    vscode.window.tabGroups.all.map((group) => ({
      viewColumn: group.viewColumn,
      tabCount: group.tabs.length,
    })),
    groupShapeBefore,
    "switching editors does not add a tab or editor group",
  );

  const siblingGroupAfter = vscode.window.tabGroups.all.find(
    (group) => group.viewColumn === siblingViewColumn,
  );
  assert.ok(siblingGroupAfter, "the sibling editor group remains available");
  assert.equal(siblingGroupAfter.tabs.length, siblingTabCountBefore);
  assert.ok(
    siblingGroupAfter.tabs.some((tab) => {
      const input = tab.input;
      return (
        input instanceof vscode.TabInputText &&
        input.uri.toString() === siblingUri.toString()
      );
    }),
    "the text sibling in the other group remains open",
  );

  assert.equal(markdownDocument.getText(), dirtyText);
  assert.equal(markdownDocument.isDirty, true);
  assert.equal(await readFile(filePath, "utf8"), diskBefore);

  assert.equal(
    (await codeLensesFor(fileUri)).length,
    0,
    "the custom editor should not receive the CodeLens",
  );

  const diffUri = vscode.Uri.file(
    path.join(path.dirname(filePath), "ignored.md"),
  );
  await vscode.commands.executeCommand(
    "vscode.diff",
    fileUri,
    diffUri,
    "Markdown Mint CodeLens acceptance diff",
  );
  await waitFor(
    () =>
      vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof
      vscode.TabInputTextDiff,
    "the Markdown diff editor to open",
  );
  assert.equal(
    (await codeLensesFor(fileUri)).length,
    0,
    "the diff editor should not receive the CodeLens",
  );

  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  await vscode.window.showTextDocument(markdownDocument, {
    viewColumn: sourceViewColumn,
    preview: false,
  });
  await vscode.commands.executeCommand("undo");
  await waitFor(
    () => markdownDocument.getText() === original && !markdownDocument.isDirty,
    "the Markdown source buffer cleanup",
  );
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
}

async function codeLensesFor(uri: vscode.Uri): Promise<vscode.CodeLens[]> {
  return (
    (await vscode.commands.executeCommand<vscode.CodeLens[]>(
      "vscode.executeCodeLensProvider",
      uri,
    )) ?? []
  );
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
