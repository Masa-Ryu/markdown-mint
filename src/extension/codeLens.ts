import * as vscode from "vscode";

export const MARKDOWN_MINT_VIEW_TYPE = "markdownMint.editor";
export const OPEN_IN_MARKDOWN_MINT_COMMAND = "markdownMint.openInEditor";
export const OPEN_IN_MARKDOWN_MINT_TITLE = "🌿 Open in Markdown Mint";
export const REOPEN_ACTIVE_EDITOR_WITH_COMMAND = "reopenActiveEditorWith";

export class MarkdownMintCodeLensProvider
  implements vscode.CodeLensProvider, vscode.Disposable
{
  private readonly changes = new vscode.EventEmitter<void>();
  private readonly subscriptions: vscode.Disposable[] = [
    vscode.window.onDidChangeActiveTextEditor(() => this.changes.fire()),
    vscode.window.onDidChangeVisibleTextEditors(() => this.changes.fire()),
    vscode.window.tabGroups.onDidChangeTabs(() => this.changes.fire()),
    vscode.window.tabGroups.onDidChangeTabGroups(() => this.changes.fire()),
    this.changes,
  ];

  public readonly onDidChangeCodeLenses = this.changes.event;

  public provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): vscode.CodeLens[] {
    if (token?.isCancellationRequested || !isMarkdownDocument(document)) {
      return [];
    }
    if (!isOpenedInNormalTextEditor(document.uri)) return [];

    const origin = new vscode.Position(0, 0);
    return [
      new vscode.CodeLens(new vscode.Range(origin, origin), {
        title: OPEN_IN_MARKDOWN_MINT_TITLE,
        command: OPEN_IN_MARKDOWN_MINT_COMMAND,
        arguments: [document.uri],
      }),
    ];
  }

  public dispose(): void {
    for (const subscription of this.subscriptions.splice(0)) {
      subscription.dispose();
    }
  }
}

/**
 * Replaces the active text editor's input with Markdown Mint's custom editor.
 * The URI is supplied by the CodeLens so a delayed click cannot act on a
 * different document that became active in the meantime.
 */
export async function openInMarkdownMint(
  uri?: vscode.Uri,
  viewType: string = MARKDOWN_MINT_VIEW_TYPE,
): Promise<void> {
  const candidate = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!candidate || !isActiveNormalMarkdownTextEditor(candidate)) return;

  // This built-in command asks VS Code to replace the active editor input in
  // its current group. It preserves the existing TextDocument model and its
  // dirty state without writing the source document.
  await vscode.commands.executeCommand(
    REOPEN_ACTIVE_EDITOR_WITH_COMMAND,
    viewType,
  );
}

export function isOpenedInNormalTextEditor(uri: vscode.Uri): boolean {
  return vscode.window.tabGroups.all.some((group) => {
    const activeTab = group.activeTab;
    return activeTab ? isNormalTextTabForUri(activeTab, uri) : false;
  });
}

function isActiveNormalMarkdownTextEditor(uri: vscode.Uri): boolean {
  const editor = vscode.window.activeTextEditor;
  if (
    !editor ||
    !isMarkdownDocument(editor.document) ||
    !sameUri(editor.document.uri, uri)
  ) {
    return false;
  }

  const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  return activeTab ? isNormalTextTabForUri(activeTab, uri) : false;
}

function isNormalTextTabForUri(tab: vscode.Tab, uri: vscode.Uri): boolean {
  const input = tab.input;
  return input instanceof vscode.TabInputText && sameUri(input.uri, uri);
}

function isMarkdownDocument(document: vscode.TextDocument): boolean {
  return document.languageId === "markdown";
}

function sameUri(left: vscode.Uri, right: vscode.Uri): boolean {
  return left.toString(true) === right.toString(true);
}
