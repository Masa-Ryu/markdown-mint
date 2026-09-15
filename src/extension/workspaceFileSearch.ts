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
 * explicit exclude glob. Results are cached per workspace folder and scheme
 * so a second keystroke only reranks the already-prepared index.
 */
export class WorkspaceFileSearchHost implements vscode.Disposable {
  private readonly search = new RankedWorkspaceFileSearch();
  private readonly fileCache = new Map<
    string,
    Promise<readonly vscode.Uri[]>
  >();
  private readonly indexCache = new Map<
    string,
    Promise<WorkspaceFileSearchIndex>
  >();
  private readonly warmupCache = new Map<string, Promise<void>>();
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
      const index = await this.getOrCreateIndex(documentUri, workspaceFolder);
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

  /**
   * Prepare discovery and the URI-scoped search index before the first query.
   * The returned promise is shared for simultaneous warm-ups of the same
   * workspace/scheme/authority tuple.
   */
  public warmup(
    documentUri: vscode.Uri,
    workspaceFolder: vscode.WorkspaceFolder | undefined,
  ): Promise<void> {
    if (!workspaceFolder) return Promise.resolve();
    const indexKey = this.indexKey(documentUri, workspaceFolder);
    const cached = this.warmupCache.get(indexKey);
    if (cached) return cached;

    const workspaceKey = workspaceFolder.uri.toString(true);
    const warmup = this.getOrCreateIndex(documentUri, workspaceFolder).then(
      () => undefined,
      () => {
        this.fileCache.delete(workspaceKey);
        this.deleteIndexesForWorkspace(workspaceKey);
        if (this.warmupCache.get(indexKey) === warmup)
          this.warmupCache.delete(indexKey);
      },
    );
    this.warmupCache.set(indexKey, warmup);
    return warmup;
  }

  public clear(): void {
    this.fileCache.clear();
    this.indexCache.clear();
    this.warmupCache.clear();
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

  private getOrCreateIndex(
    documentUri: vscode.Uri,
    workspaceFolder: vscode.WorkspaceFolder,
  ): Promise<WorkspaceFileSearchIndex> {
    const indexKey = this.indexKey(documentUri, workspaceFolder);
    const cached = this.indexCache.get(indexKey);
    if (cached) return cached;

    const index = this.discoverFiles(workspaceFolder).then((discovered) =>
      createWorkspaceFileSearchIndex(
        workspaceFolder.uri.path,
        discovered
          .filter(
            (uri) =>
              uri.scheme === documentUri.scheme &&
              uri.authority === documentUri.authority,
          )
          .map((uri) => ({ path: uri.path })),
      ),
    );
    this.indexCache.set(indexKey, index);
    return index;
  }

  private indexKey(
    documentUri: vscode.Uri,
    workspaceFolder: vscode.WorkspaceFolder,
  ): string {
    return `${workspaceFolder.uri.toString(true)}|${documentUri.scheme}|${documentUri.authority}`;
  }

  private deleteIndexesForWorkspace(key: string): void {
    for (const indexKey of this.indexCache.keys()) {
      if (indexKey.startsWith(`${key}|`)) this.indexCache.delete(indexKey);
    }
    for (const warmupKey of this.warmupCache.keys()) {
      if (warmupKey.startsWith(`${key}|`)) this.warmupCache.delete(warmupKey);
    }
  }
}
