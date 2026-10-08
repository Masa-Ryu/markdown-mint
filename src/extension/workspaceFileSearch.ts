import * as vscode from "vscode";
import {
  createWorkspaceFileSearchIndex,
  WorkspaceFileSearch as RankedWorkspaceFileSearch,
  isWorkspaceFileSearchQuery,
  type WorkspaceFileCandidate,
  type WorkspaceFileSearchIndex,
  type WorkspaceFileSearchFilter,
} from "../shared/workspaceFileSearch";

export const MAX_WORKSPACE_DIRECTORY_SCAN_DEPTH = 12;
export const MAX_WORKSPACE_DIRECTORY_SCAN_COUNT = 500;
export const MAX_WORKSPACE_DIRECTORY_SCAN_ENTRIES = 5_000;
export const MAX_WORKSPACE_DIRECTORY_SCAN_MS = 150;
const WORKSPACE_DIRECTORY_SCAN_CONCURRENCY = 8;

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
  private readonly directoryCache = new Map<
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
      this.directoryCache.delete(key);
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
        this.directoryCache.delete(workspaceKey);
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
    this.directoryCache.clear();
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

  /**
   * Find empty directories with one bounded, cached breadth-first scan. Most
   * searchable directories are collected as parents of findFiles results;
   * this pass exists for directories that contain no files. Its depth, read
   * count, entry count, and elapsed time are capped so large/remote workspaces
   * cannot turn every keystroke into an unbounded filesystem walk.
   */
  private discoverDirectories(
    workspaceFolder: vscode.WorkspaceFolder,
  ): Promise<readonly vscode.Uri[]> {
    const key = workspaceFolder.uri.toString(true);
    const cached = this.directoryCache.get(key);
    if (cached) return cached;
    const excludes = readFileExcludePatterns(workspaceFolder);
    const directories = scanWorkspaceDirectories(workspaceFolder, excludes);
    this.directoryCache.set(key, directories);
    return directories;
  }

  private getOrCreateIndex(
    documentUri: vscode.Uri,
    workspaceFolder: vscode.WorkspaceFolder,
  ): Promise<WorkspaceFileSearchIndex> {
    const indexKey = this.indexKey(documentUri, workspaceFolder);
    const cached = this.indexCache.get(indexKey);
    if (cached) return cached;

    const index = Promise.all([
      this.discoverFiles(workspaceFolder),
      this.discoverDirectories(workspaceFolder),
    ]).then(([discoveredFiles, discoveredDirectories]) => {
      const files = discoveredFiles.filter((uri) =>
        isSameFileSystem(uri, documentUri),
      );
      const excludes = readFileExcludePatterns(workspaceFolder);
      const directories = new Map<string, vscode.Uri>();
      for (const uri of discoveredDirectories) {
        if (isSameFileSystem(uri, documentUri))
          directories.set(uri.toString(true), uri);
      }
      for (const file of files) {
        for (const parent of parentDirectories(file, workspaceFolder.uri)) {
          if (isExcludedDirectory(workspaceFolder.uri, parent, excludes))
            continue;
          directories.set(parent.toString(true), parent);
        }
      }
      return createWorkspaceFileSearchIndex(workspaceFolder.uri.path, [
        ...files.map((uri) => ({ path: uri.path, kind: "file" as const })),
        ...[...directories.values()].map((uri) => ({
          path: uri.path,
          kind: "directory" as const,
        })),
      ]);
    });
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

interface DirectoryScanItem {
  readonly uri: vscode.Uri;
  readonly depth: number;
}

async function scanWorkspaceDirectories(
  workspaceFolder: vscode.WorkspaceFolder,
  excludes: readonly RegExp[],
): Promise<readonly vscode.Uri[]> {
  const root = workspaceFolder.uri;
  const found = new Map<string, vscode.Uri>();
  const queued = new Set([root.toString(true)]);
  let pending: DirectoryScanItem[] = [{ uri: root, depth: 0 }];
  let readCount = 0;
  let entryCount = 0;
  const startedAt = Date.now();

  while (
    pending.length > 0 &&
    readCount < MAX_WORKSPACE_DIRECTORY_SCAN_COUNT &&
    entryCount < MAX_WORKSPACE_DIRECTORY_SCAN_ENTRIES
  ) {
    const elapsed = Date.now() - startedAt;
    const remainingMs = MAX_WORKSPACE_DIRECTORY_SCAN_MS - elapsed;
    if (remainingMs <= 0) break;
    const batch = pending.splice(
      0,
      Math.min(
        WORKSPACE_DIRECTORY_SCAN_CONCURRENCY,
        MAX_WORKSPACE_DIRECTORY_SCAN_COUNT - readCount,
      ),
    );
    const results = await resolveWithin(
      Promise.all(
        batch.map(async ({ uri }) => {
          try {
            return await vscode.workspace.fs.readDirectory(uri);
          } catch {
            // Virtual providers may not support directory enumeration for
            // every path. File and parent-directory candidates still work.
            return [] as readonly [string, vscode.FileType][];
          }
        }),
      ),
      remainingMs,
    );
    if (!results) break;
    readCount += batch.length;

    for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
      const parent = batch[batchIndex]!;
      const children = results[batchIndex]!.slice().sort(([left], [right]) =>
        left.localeCompare(right),
      );
      for (const [name, type] of children) {
        entryCount += 1;
        if (entryCount > MAX_WORKSPACE_DIRECTORY_SCAN_ENTRIES) break;
        if (
          !name ||
          name === "." ||
          name === ".." ||
          name.includes("/") ||
          name.includes("\\") ||
          hasControlCharacter(name)
        )
          continue;
        if ((type & vscode.FileType.Directory) === 0) continue;
        const child = vscode.Uri.joinPath(parent.uri, name);
        const relativePath = workspaceRelativeUriPath(root, child);
        if (!relativePath || isExcludedDirectoryPath(relativePath, excludes))
          continue;
        const childKey = child.toString(true);
        found.set(childKey, child);
        if (
          parent.depth < MAX_WORKSPACE_DIRECTORY_SCAN_DEPTH &&
          !queued.has(childKey)
        ) {
          queued.add(childKey);
          pending.push({ uri: child, depth: parent.depth + 1 });
        }
      }
      if (entryCount >= MAX_WORKSPACE_DIRECTORY_SCAN_ENTRIES) break;
    }
  }

  return [...found.values()];
}

function readFileExcludePatterns(
  workspaceFolder: vscode.WorkspaceFolder,
): RegExp[] {
  try {
    const patterns = vscode.workspace
      .getConfiguration("files", workspaceFolder.uri)
      .get<Record<string, boolean>>("exclude", {});
    return Object.entries(patterns ?? {})
      .filter(([, excluded]) => excluded)
      .flatMap(([pattern]) => {
        const matcher = globPatternToRegExp(pattern);
        return matcher ? [matcher] : [];
      });
  } catch {
    return [];
  }
}

function globPatternToRegExp(pattern: string): RegExp | undefined {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || hasControlCharacter(normalized)) return undefined;
  let expression = "^";
  for (let index = 0; index < normalized.length;) {
    const character = normalized[index]!;
    if (character === "*" && normalized[index + 1] === "*") {
      index += 2;
      if (normalized[index] === "/") {
        expression += "(?:.*/)?";
        index += 1;
      } else {
        expression += ".*";
      }
      continue;
    }
    if (character === "*") {
      expression += "[^/]*";
      index += 1;
      continue;
    }
    if (character === "?") {
      expression += "[^/]";
      index += 1;
      continue;
    }
    if (character === "[") {
      const closing = normalized.indexOf("]", index + 1);
      if (closing > index + 1) {
        expression += normalized.slice(index, closing + 1);
        index = closing + 1;
        continue;
      }
    }
    expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    index += 1;
  }
  try {
    return new RegExp(`${expression}$`);
  } catch {
    return undefined;
  }
}

function isExcludedDirectoryPath(
  relativePath: string,
  excludes: readonly RegExp[],
): boolean {
  return (
    relativePath
      .split("/")
      .some(
        (segment) =>
          segment.toLowerCase() === ".git" ||
          segment.toLowerCase() === "node_modules",
      ) ||
    excludes.some(
      (pattern) =>
        pattern.test(relativePath) || pattern.test(`${relativePath}/`),
    )
  );
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isExcludedDirectory(
  workspaceFolder: vscode.Uri,
  directory: vscode.Uri,
  excludes: readonly RegExp[],
): boolean {
  const relativePath = workspaceRelativeUriPath(workspaceFolder, directory);
  return !relativePath || isExcludedDirectoryPath(relativePath, excludes);
}

function workspaceRelativeUriPath(
  workspaceFolder: vscode.Uri,
  target: vscode.Uri,
): string | undefined {
  if (!isSameFileSystem(workspaceFolder, target)) return undefined;
  const rootPath = normalizeUriPath(workspaceFolder.path);
  const targetPath = normalizeUriPath(target.path);
  if (targetPath === rootPath) return "";
  const prefix = rootPath === "/" ? "/" : `${rootPath}/`;
  return targetPath.startsWith(prefix)
    ? targetPath.slice(prefix.length)
    : undefined;
}

function parentDirectories(
  file: vscode.Uri,
  workspaceFolder: vscode.Uri,
): vscode.Uri[] {
  const parents: vscode.Uri[] = [];
  let parent = vscode.Uri.joinPath(
    file.with({ query: "", fragment: "" }),
    "..",
  );
  while (workspaceRelativeUriPath(workspaceFolder, parent)) {
    parents.push(parent);
    parent = vscode.Uri.joinPath(parent, "..");
  }
  return parents;
}

function normalizeUriPath(path: string): string {
  if (path === "/") return path;
  return path.replace(/\/+$/, "");
}

function isSameFileSystem(left: vscode.Uri, right: vscode.Uri): boolean {
  return left.scheme === right.scheme && left.authority === right.authority;
}

async function resolveWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
