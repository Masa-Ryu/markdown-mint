import * as vscode from "vscode";
import { posix } from "node:path";
import { Minimatch } from "minimatch";
import {
  createWorkspaceFileSearchIndex,
  extendWorkspaceFileSearchIndex,
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
/** Refresh discovery on the next search after this cache age. */
export const WORKSPACE_FILE_SEARCH_CACHE_TTL_MS = 5_000;
const WORKSPACE_DIRECTORY_SCAN_CONCURRENCY = 8;

interface WorkspaceFileExcludePattern {
  readonly matcher: Minimatch;
  readonly when?: string;
}

interface WorkspaceDirectoryScanResult {
  readonly directories: readonly vscode.Uri[];
  readonly siblingNamesByParent: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Host-side adapter for workspace discovery. VS Code owns the filesystem
 * lookup and applies files.exclude when findFiles is called without an
 * explicit exclude glob. Results are cached per workspace folder and scheme;
 * a second keystroke reranks the prepared index, and a five-second refresh
 * lets later searches observe filesystem changes outside VS Code.
 */
export class WorkspaceFileSearchHost implements vscode.Disposable {
  private readonly search = new RankedWorkspaceFileSearch();
  private readonly fileCache = new Map<
    string,
    Promise<readonly vscode.Uri[]>
  >();
  private readonly directoryCache = new Map<
    string,
    Promise<WorkspaceDirectoryScanResult>
  >();
  private readonly fileIndexCache = new Map<
    string,
    Promise<WorkspaceFileSearchIndex>
  >();
  private readonly linkIndexCache = new Map<
    string,
    Promise<WorkspaceFileSearchIndex>
  >();
  private readonly excludeCache = new Map<
    string,
    readonly WorkspaceFileExcludePattern[]
  >();
  private readonly cacheCreatedAt = new Map<string, number>();
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
    this.refreshWorkspaceCacheIfExpired(key);
    try {
      const index =
        filter === "image"
          ? await this.getOrCreateFileIndex(documentUri, workspaceFolder)
          : await this.getOrCreateIndex(documentUri, workspaceFolder);
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
      this.clearWorkspaceCache(key);
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
    const workspaceKey = workspaceFolder.uri.toString(true);
    this.refreshWorkspaceCacheIfExpired(workspaceKey);
    const indexKey = this.indexKey(documentUri, workspaceFolder);
    const cached = this.warmupCache.get(indexKey);
    if (cached) return cached;

    const warmup = this.getOrCreateFileIndex(documentUri, workspaceFolder).then(
      () => undefined,
      () => {
        this.clearWorkspaceCache(workspaceKey);
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
    this.fileIndexCache.clear();
    this.linkIndexCache.clear();
    this.excludeCache.clear();
    this.cacheCreatedAt.clear();
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
    let files: Promise<readonly vscode.Uri[]>;
    files = Promise.resolve(
      vscode.workspace.findFiles(
        new vscode.RelativePattern(workspaceFolder, "**/*"),
        undefined,
      ),
    ).then((result) => {
      if (this.fileCache.get(key) === files) this.markWorkspaceCacheFresh(key);
      return result;
    });
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
  ): Promise<WorkspaceDirectoryScanResult> {
    const key = workspaceFolder.uri.toString(true);
    const cached = this.directoryCache.get(key);
    if (cached) return cached;
    const excludes = this.getFileExcludePatterns(workspaceFolder);
    let directories: Promise<WorkspaceDirectoryScanResult>;
    directories = scanWorkspaceDirectories(workspaceFolder, excludes).then(
      (result) => {
        if (this.directoryCache.get(key) === directories)
          this.markWorkspaceCacheFresh(key);
        return result;
      },
    );
    this.directoryCache.set(key, directories);
    return directories;
  }

  private refreshWorkspaceCacheIfExpired(workspaceKey: string): void {
    const createdAt = this.cacheCreatedAt.get(workspaceKey);
    if (
      createdAt !== undefined &&
      Date.now() - createdAt >= WORKSPACE_FILE_SEARCH_CACHE_TTL_MS
    )
      this.clearWorkspaceCache(workspaceKey);
  }

  private markWorkspaceCacheFresh(workspaceKey: string): void {
    this.cacheCreatedAt.set(workspaceKey, Date.now());
  }

  private clearWorkspaceCache(workspaceKey: string): void {
    this.fileCache.delete(workspaceKey);
    this.directoryCache.delete(workspaceKey);
    this.excludeCache.delete(workspaceKey);
    this.cacheCreatedAt.delete(workspaceKey);
    this.deleteIndexesForWorkspace(workspaceKey);
  }

  private getOrCreateIndex(
    documentUri: vscode.Uri,
    workspaceFolder: vscode.WorkspaceFolder,
  ): Promise<WorkspaceFileSearchIndex> {
    const indexKey = this.indexKey(documentUri, workspaceFolder);
    const cached = this.linkIndexCache.get(indexKey);
    if (cached) return cached;

    const index = Promise.all([
      this.getOrCreateFileIndex(documentUri, workspaceFolder),
      this.discoverFiles(workspaceFolder),
      this.discoverDirectories(workspaceFolder),
    ]).then(([fileIndex, discoveredFiles, directoryScan]) => {
      const files = discoveredFiles.filter((uri) =>
        isSameFileSystem(uri, documentUri),
      );
      const excludes = this.getFileExcludePatterns(workspaceFolder);
      const relativeFilePaths = new Set(
        files
          .map((file) => workspaceRelativeUriPath(workspaceFolder.uri, file))
          .filter((filePath): filePath is string => filePath !== undefined),
      );
      const directories = new Map<string, vscode.Uri>();
      for (const uri of directoryScan.directories) {
        if (
          isSameFileSystem(uri, documentUri) &&
          !isExcludedDirectory(
            workspaceFolder.uri,
            uri,
            excludes,
            directoryScan.siblingNamesByParent,
            relativeFilePaths,
          )
        )
          directories.set(uri.toString(true), uri);
      }
      for (const file of files) {
        for (const parent of parentDirectories(file, workspaceFolder.uri)) {
          if (
            isExcludedDirectory(
              workspaceFolder.uri,
              parent,
              excludes,
              directoryScan.siblingNamesByParent,
              relativeFilePaths,
            )
          )
            continue;
          directories.set(parent.toString(true), parent);
        }
      }
      return extendWorkspaceFileSearchIndex(
        fileIndex,
        [...directories.values()].map((uri) => ({
          path: uri.path,
          kind: "directory" as const,
        })),
      );
    });
    this.linkIndexCache.set(indexKey, index);
    return index;
  }

  private getOrCreateFileIndex(
    documentUri: vscode.Uri,
    workspaceFolder: vscode.WorkspaceFolder,
  ): Promise<WorkspaceFileSearchIndex> {
    const indexKey = this.indexKey(documentUri, workspaceFolder);
    const cached = this.fileIndexCache.get(indexKey);
    if (cached) return cached;
    const index = this.discoverFiles(workspaceFolder).then((discoveredFiles) =>
      createWorkspaceFileSearchIndex(
        workspaceFolder.uri.path,
        discoveredFiles
          .filter((uri) => isSameFileSystem(uri, documentUri))
          .map((uri) => ({ path: uri.path, kind: "file" as const })),
      ),
    );
    this.fileIndexCache.set(indexKey, index);
    return index;
  }

  private getFileExcludePatterns(
    workspaceFolder: vscode.WorkspaceFolder,
  ): readonly WorkspaceFileExcludePattern[] {
    const key = workspaceFolder.uri.toString(true);
    const cached = this.excludeCache.get(key);
    if (cached) return cached;
    const excludes = readFileExcludePatterns(workspaceFolder);
    this.excludeCache.set(key, excludes);
    return excludes;
  }

  private indexKey(
    documentUri: vscode.Uri,
    workspaceFolder: vscode.WorkspaceFolder,
  ): string {
    return `${workspaceFolder.uri.toString(true)}|${documentUri.scheme}|${documentUri.authority}`;
  }

  private deleteIndexesForWorkspace(key: string): void {
    for (const indexKey of this.fileIndexCache.keys()) {
      if (indexKey.startsWith(`${key}|`)) this.fileIndexCache.delete(indexKey);
    }
    for (const indexKey of this.linkIndexCache.keys()) {
      if (indexKey.startsWith(`${key}|`)) this.linkIndexCache.delete(indexKey);
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

export async function scanWorkspaceDirectories(
  workspaceFolder: vscode.WorkspaceFolder,
  excludes: readonly WorkspaceFileExcludePattern[],
  readDirectory: typeof vscode.workspace.fs.readDirectory = (uri) =>
    vscode.workspace.fs.readDirectory(uri),
): Promise<WorkspaceDirectoryScanResult> {
  const root = workspaceFolder.uri;
  const found = new Map<string, vscode.Uri>();
  const siblingNamesByParent = new Map<string, ReadonlySet<string>>();
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
            return {
              entries: await readDirectory(uri),
              succeeded: true,
            };
          } catch {
            // Virtual providers may not support directory enumeration for
            // every path. File and parent-directory candidates still work.
            return {
              entries: [] as readonly [string, vscode.FileType][],
              succeeded: false,
            };
          }
        }),
      ),
      remainingMs,
    );
    if (!results) break;
    readCount += batch.length;

    for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
      const parent = batch[batchIndex]!;
      const result = results[batchIndex]!;
      const children = result.entries
        .slice()
        .sort(([left], [right]) => left.localeCompare(right));
      const parentRelativePath = workspaceRelativeUriPath(root, parent.uri);
      if (result.succeeded && parentRelativePath !== undefined)
        siblingNamesByParent.set(
          parentRelativePath,
          new Set(children.map(([name]) => name)),
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
        const childDepth = parent.depth + 1;
        if (childDepth > MAX_WORKSPACE_DIRECTORY_SCAN_DEPTH) continue;
        const child = vscode.Uri.joinPath(parent.uri, name);
        const relativePath = workspaceRelativeUriPath(root, child);
        if (
          !relativePath ||
          isExcludedDirectoryPath(relativePath, excludes, siblingNamesByParent)
        )
          continue;
        const childKey = child.toString(true);
        found.set(childKey, child);
        if (!queued.has(childKey)) {
          queued.add(childKey);
          pending.push({ uri: child, depth: childDepth });
        }
      }
      if (entryCount >= MAX_WORKSPACE_DIRECTORY_SCAN_ENTRIES) break;
    }
  }

  return {
    directories: [...found.values()],
    siblingNamesByParent,
  };
}

function readFileExcludePatterns(
  workspaceFolder: vscode.WorkspaceFolder,
): WorkspaceFileExcludePattern[] {
  try {
    const patterns = vscode.workspace
      .getConfiguration("files", workspaceFolder.uri)
      .get<Record<string, boolean | { readonly when?: unknown }>>(
        "exclude",
        {},
      );
    return Object.entries(patterns ?? {})
      .filter(([, excluded]) => excluded === true || Boolean(excluded))
      .flatMap(([pattern, excluded]) => {
        const matcher = globPatternToMatcher(pattern);
        if (!matcher) return [];
        const when =
          typeof excluded === "object" &&
          excluded !== null &&
          typeof excluded.when === "string"
            ? excluded.when
            : undefined;
        return [{ matcher, ...(when === undefined ? {} : { when }) }];
      });
  } catch {
    return [];
  }
}

function globPatternToMatcher(pattern: string): Minimatch | undefined {
  const normalized = pattern.replace(/^\.\//, "");
  if (!normalized || hasControlCharacter(normalized)) return undefined;
  try {
    return new Minimatch(normalized, {
      dot: true,
      noext: true,
      nocase: isWorkspaceGlobCaseInsensitive(),
      nocomment: true,
      nonegate: true,
    });
  } catch {
    return undefined;
  }
}

export function isWorkspaceGlobCaseInsensitive(
  platform: NodeJS.Platform = process.platform,
): boolean {
  // Remote extension hosts run this code on the remote OS, matching VS Code's
  // files.exclude behavior for SSH, WSL, and dev-container workspaces.
  return platform === "win32" || platform === "darwin";
}

function isExcludedDirectoryPath(
  relativePath: string,
  excludes: readonly WorkspaceFileExcludePattern[],
  siblingNamesByParent: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
  relativeFilePaths: ReadonlySet<string> = new Set(),
): boolean {
  const segments = relativePath.split("/").filter(Boolean);
  if (
    segments.some(
      (segment) =>
        segment.toLowerCase() === ".git" ||
        segment.toLowerCase() === "node_modules",
    )
  )
    return true;

  let candidatePath = "";
  for (let index = 0; index < segments.length; index += 1) {
    candidatePath = candidatePath
      ? `${candidatePath}/${segments[index]}`
      : segments[index]!;
    for (const exclude of excludes) {
      if (
        !exclude.matcher.match(candidatePath) &&
        !exclude.matcher.match(`${candidatePath}/`)
      )
        continue;
      if (exclude.when === undefined) return true;
      const basename = posix.parse(segments[index]!).name;
      const siblingName = exclude.when.replace("$(basename)", basename);
      const parentPath = segments.slice(0, index).join("/");
      if (
        siblingNamesByParent.get(parentPath)?.has(siblingName) ||
        relativeFilePaths.has(posix.join(parentPath, siblingName))
      )
        return true;
    }
  }
  return false;
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
  excludes: readonly WorkspaceFileExcludePattern[],
  siblingNamesByParent: ReadonlyMap<string, ReadonlySet<string>>,
  relativeFilePaths: ReadonlySet<string>,
): boolean {
  const relativePath = workspaceRelativeUriPath(workspaceFolder, directory);
  return (
    relativePath === undefined ||
    isExcludedDirectoryPath(
      relativePath,
      excludes,
      siblingNamesByParent,
      relativeFilePaths,
    )
  );
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
