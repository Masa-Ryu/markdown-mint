import * as vscode from "vscode";
import {
  WorkspaceFileSearch as RankedWorkspaceFileSearch,
  isWorkspaceFileSearchQuery,
  type WorkspaceFileCandidate,
  type WorkspaceFileSearchFilter,
} from "../shared/workspaceFileSearch";

/**
 * Host-side adapter for workspace discovery. VS Code owns the filesystem
 * lookup and applies files.exclude when findFiles is called without an
 * explicit exclude glob. Results are cached per workspace folder so a second
 * keystroke only reranks the already-discovered URIs.
 */
export class WorkspaceFileSearchHost implements vscode.Disposable {
  private readonly search = new RankedWorkspaceFileSearch();
  private readonly fileCache = new Map<
    string,
    Thenable<readonly vscode.Uri[]>
  >();
  private readonly disposables: vscode.Disposable[];

  public constructor() {
    const workspace = vscode.workspace as typeof vscode.workspace &
      Partial<{
        onDidCreateFiles: (listener: () => void) => vscode.Disposable;
        onDidDeleteFiles: (listener: () => void) => vscode.Disposable;
        onDidRenameFiles: (listener: () => void) => vscode.Disposable;
        onDidChangeWorkspaceFolders: (
          listener: () => void,
        ) => vscode.Disposable;
      }>;
    this.disposables = [
      workspace.onDidCreateFiles?.(() => this.clear()),
      workspace.onDidDeleteFiles?.(() => this.clear()),
      workspace.onDidRenameFiles?.(() => this.clear()),
      workspace.onDidChangeWorkspaceFolders?.(() => this.clear()),
      workspace.onDidChangeConfiguration?.((event) => {
        if (event.affectsConfiguration("files.exclude")) this.clear();
      }),
    ].filter((disposable): disposable is vscode.Disposable =>
      Boolean(disposable),
    );
  }

  public async searchFiles(
    documentUri: vscode.Uri,
    workspaceFolder: vscode.WorkspaceFolder | undefined,
    query: string,
    filter: WorkspaceFileSearchFilter,
  ): Promise<WorkspaceFileCandidate[]> {
    if (!workspaceFolder || !isWorkspaceFileSearchQuery(query)) return [];
    const key = workspaceFolder.uri.toString(true);
    let files = this.fileCache.get(key);
    if (!files) {
      files = vscode.workspace.findFiles(
        new vscode.RelativePattern(workspaceFolder, "**/*"),
        undefined,
      );
      this.fileCache.set(key, files);
    }
    try {
      const discovered = await files;
      return this.search.search({
        documentPath: documentUri.path,
        workspaceFolderPath: workspaceFolder.uri.path,
        files: discovered
          .filter(
            (uri) =>
              uri.scheme === documentUri.scheme &&
              uri.authority === documentUri.authority,
          )
          .map((uri) => ({ path: uri.path })),
        query,
        filter,
      });
    } catch {
      // File providers can disappear while a remote workspace reconnects. An
      // empty result keeps the dialog usable without turning lookup failures
      // into document edits or noisy notifications.
      this.fileCache.delete(key);
      return [];
    }
  }

  public clear(): void {
    this.fileCache.clear();
  }

  public dispose(): void {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.clear();
  }
}
