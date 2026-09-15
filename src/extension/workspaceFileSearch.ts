import * as vscode from "vscode";
import {
  createWorkspaceFileSearchIndex,
  WorkspaceFileSearch as RankedWorkspaceFileSearch,
  isWorkspaceFileSearchQuery,
  type WorkspaceFileCandidate,
  type WorkspaceFileSearchIndex,
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
    Promise<readonly vscode.Uri[]>
  >();
  private readonly indexCache = new Map<string, WorkspaceFileSearchIndex>();
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
    try {
      const discovered = await this.discoverFiles(workspaceFolder);
      const indexKey = `${key}|${documentUri.scheme}|${documentUri.authority}`;
      let index = this.indexCache.get(indexKey);
      if (!index) {
        index = createWorkspaceFileSearchIndex(
          workspaceFolder.uri.path,
          discovered
            .filter(
              (uri) =>
                uri.scheme === documentUri.scheme &&
                uri.authority === documentUri.authority,
            )
            .map((uri) => ({ path: uri.path })),
        );
        this.indexCache.set(indexKey, index);
      }
      return this.search.search({
        documentPath: documentUri.path,
        workspaceFolderPath: workspaceFolder.uri.path,
        files: [],
        query,
        filter,
        index,
      });
    } catch {
      // File providers can disappear while a remote workspace reconnects. An
      // empty result keeps the dialog usable without turning lookup failures
      // into document edits or noisy notifications.
      this.fileCache.delete(key);
      this.deleteIndexesForWorkspace(key);
      return [];
    }
  }

  /** Start discovery without blocking the editor or waiting for a query. */
  public warmup(workspaceFolder: vscode.WorkspaceFolder | undefined): void {
    if (!workspaceFolder) return;
    const key = workspaceFolder.uri.toString(true);
    void this.discoverFiles(workspaceFolder).catch(() => {
      this.fileCache.delete(key);
      this.deleteIndexesForWorkspace(key);
    });
  }

  public clear(): void {
    this.fileCache.clear();
    this.indexCache.clear();
  }

  public dispose(): void {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.clear();
  }

  private discoverFiles(
    workspaceFolder: vscode.WorkspaceFolder,
  ): Promise<readonly vscode.Uri[]> {
    const key = workspaceFolder.uri.toString(true);
    const cached = this.fileCache.get(key);
    if (cached) return cached;
    const files = Promise.resolve(
      vscode.workspace.findFiles(
        new vscode.RelativePattern(workspaceFolder, "**/*"),
        undefined,
      ),
    );
    this.fileCache.set(key, files);
    return files;
  }

  private deleteIndexesForWorkspace(key: string): void {
    for (const indexKey of this.indexCache.keys()) {
      if (indexKey.startsWith(`${key}|`)) this.indexCache.delete(indexKey);
    }
  }
}
