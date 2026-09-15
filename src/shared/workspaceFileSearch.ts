/**
 * Shared, filesystem-agnostic workspace file search helpers.
 *
 * The extension host supplies URI path components from VS Code. The webview
 * only receives the small, already-ranked result set produced by this module;
 * it never needs to inspect the filesystem itself.
 */

export const MAX_WORKSPACE_FILE_SEARCH_RESULTS = 10;

export const IMAGE_FILE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".avif",
  ".bmp",
]);

export type WorkspaceFileSearchFilter = "all" | "image";

export interface WorkspaceFileEntry {
  readonly path: string;
}

export interface WorkspaceFileCandidate {
  readonly fileName: string;
  /** Workspace-folder-relative directory, with a trailing slash. */
  readonly directory: string;
  /** Markdown-safe path relative to the current document directory. */
  readonly relativePath: string;
}

export interface WorkspaceFileSearchOptions {
  readonly documentPath: string;
  readonly workspaceFolderPath: string;
  readonly files: readonly WorkspaceFileEntry[];
  readonly query: string;
  readonly filter: WorkspaceFileSearchFilter;
  readonly maxResults?: number;
  /** Reuse the workspace-normalized file metadata when the host has it. */
  readonly index?: WorkspaceFileSearchIndex;
}

interface ParsedPath {
  readonly absolute: boolean;
  readonly windows: boolean;
  readonly segments: readonly string[];
}

interface MatchScore {
  readonly category: number;
  readonly primary: number;
  readonly secondary: number;
  readonly nameLength: number;
  readonly relativePath: string;
}

interface ScoredCandidate {
  readonly file: PreparedWorkspaceFile;
  readonly score: MatchScore;
  readonly documentRelativePath?: string;
}

interface PreparedWorkspaceFile {
  readonly parsedPath: ParsedPath;
  readonly workspaceRelativePath: string;
  readonly lowerFileName: string;
  readonly lowerWorkspaceRelativePath: string;
  readonly fileName: string;
  readonly directory: string;
  readonly isImage: boolean;
}

export interface WorkspaceFileSearchIndex {
  readonly workspaceFolderPath: string;
  readonly files: readonly PreparedWorkspaceFile[];
}

/**
 * Return whether a URL/anchor should be left as a manually entered value.
 * This deliberately recognizes any URI scheme, not just the four schemes
 * that the link navigator opens, so a future scheme cannot trigger local IO.
 */
export function isWorkspaceFileSearchQuery(value: string): boolean {
  const query = value.trim();
  if (!query || query.startsWith("#") || hasControlCharacter(query))
    return false;
  return !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(query);
}

export function isImageFileName(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  for (const extension of IMAGE_FILE_EXTENSIONS) {
    if (lower.endsWith(extension)) return true;
  }
  return false;
}

/**
 * Normalize workspace-relative file metadata once so every keystroke only has
 * to perform query matching and document-relative path calculation.
 */
export function createWorkspaceFileSearchIndex(
  workspaceFolderPath: string,
  files: readonly WorkspaceFileEntry[],
): WorkspaceFileSearchIndex {
  const workspace = parsePath(workspaceFolderPath);
  if (!workspace.absolute) return { workspaceFolderPath, files: [] };

  const prepared: PreparedWorkspaceFile[] = [];
  for (const file of files) {
    const parsedFile = parsePath(file.path);
    const workspaceRelative = relativeSegments(workspace, parsedFile);
    if (
      !workspaceRelative ||
      workspaceRelative.length === 0 ||
      workspaceRelative[0] === ".." ||
      workspaceRelative.some(isWorkspaceSearchExcludedDirectory)
    )
      continue;
    const fileName = workspaceRelative.at(-1);
    if (!fileName) continue;
    const directorySegments = workspaceRelative.slice(0, -1);
    prepared.push({
      parsedPath: parsedFile,
      workspaceRelativePath: workspaceRelative.join("/"),
      lowerFileName: fileName.toLowerCase(),
      lowerWorkspaceRelativePath: workspaceRelative.join("/").toLowerCase(),
      fileName,
      directory: directorySegments.length
        ? `${directorySegments.join("/")}/`
        : "./",
      isImage: isImageFileName(fileName),
    });
  }
  return { workspaceFolderPath, files: prepared };
}

/**
 * Search and rank a bounded list of files. The class has no VS Code or Node
 * dependency so its path semantics can be tested independently of a host.
 */
export class WorkspaceFileSearch {
  private readonly maxResults: number;

  public constructor(maxResults = MAX_WORKSPACE_FILE_SEARCH_RESULTS) {
    this.maxResults = Math.max(
      1,
      Math.min(maxResults, MAX_WORKSPACE_FILE_SEARCH_RESULTS),
    );
  }

  public search(options: WorkspaceFileSearchOptions): WorkspaceFileCandidate[] {
    const query = options.query.trim().toLowerCase();
    if (!query || !isWorkspaceFileSearchQuery(options.query)) return [];

    const document = parsePath(options.documentPath);
    const workspace = parsePath(options.workspaceFolderPath);
    if (!document.absolute || !workspace.absolute) return [];
    if (!isWithin(workspace, document)) return [];
    const documentDirectory = document.segments.slice(0, -1);
    const limit = Math.max(
      1,
      Math.min(options.maxResults ?? this.maxResults, this.maxResults),
    );
    const index =
      options.index?.workspaceFolderPath === options.workspaceFolderPath
        ? options.index
        : createWorkspaceFileSearchIndex(
            options.workspaceFolderPath,
            options.files,
          );
    const pathQuery = normalizePathQuery(query);
    const topK = new BoundedTopK<ScoredCandidate>(
      limit,
      compareScoredCandidates,
    );

    for (const file of index.files) {
      if (options.filter === "image" && !file.isImage) continue;
      if (!isRelativePathCompatible(document, file.parsedPath)) continue;

      const filenameScore = scoreFilenameCandidate(query, file);
      if (filenameScore) {
        topK.add({ file, score: filenameScore });
        continue;
      }
      if (!pathQuery) continue;

      // Path-like queries are uncommon and need the document-relative path
      // for matching. Ordinary filename queries stay on prepared metadata
      // until the bounded top-K has been selected.
      const relativeSegmentsFromDocument = relativeSegments(
        { ...document, segments: documentDirectory },
        file.parsedPath,
      );
      if (!relativeSegmentsFromDocument) continue;
      const relativePath = encodeMarkdownPath(relativeSegmentsFromDocument);
      const pathScore = scorePathCandidate(file, pathQuery, relativePath);
      if (pathScore)
        topK.add({
          file,
          score: pathScore,
          documentRelativePath: relativePath,
        });
    }

    return topK.values().flatMap(({ file, documentRelativePath }) => {
      const relativePath =
        documentRelativePath ??
        relativeMarkdownPathFromParsedDocument(document, file.parsedPath);
      if (!relativePath) return [];
      return [
        {
          fileName: file.fileName,
          directory: file.directory,
          relativePath,
        },
      ];
    });
  }
}

/** Generate a Markdown-safe relative path between URI path components. */
export function relativeMarkdownPath(
  documentPath: string,
  targetPath: string,
): string | undefined {
  const document = parsePath(documentPath);
  const target = parsePath(targetPath);
  return relativeMarkdownPathFromParsedDocument(document, target);
}

function relativeMarkdownPathFromParsedDocument(
  document: ParsedPath,
  target: ParsedPath,
): string | undefined {
  const relative = relativeSegments(
    { ...document, segments: document.segments.slice(0, -1) },
    target,
  );
  return relative ? encodeMarkdownPath(relative) : undefined;
}

/** Encode each path segment without allowing URI delimiters into a filename. */
export function encodeMarkdownPath(segments: readonly string[]): string {
  const encoded = segments
    .map((segment) => encodeUriPathSegment(segment))
    .join("/");
  if (segments[0] === "..") return encoded;
  return `./${encoded}`;
}

function encodeUriPathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function parsePath(value: string): ParsedPath {
  const normalized = value.replaceAll("\\", "/");
  const windowsDrive = /^\/?[a-z]:\//i.test(normalized);
  const absolute = normalized.startsWith("/") || windowsDrive;
  const windows =
    windowsDrive ||
    normalized.startsWith("//") ||
    /^[a-z]:$/i.test(normalized.split("/")[0] ?? "");
  const segments: string[] = [];
  for (const segment of normalized.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      const previous = segments.at(-1);
      if (previous && previous !== "..") segments.pop();
      else if (!absolute) segments.push(segment);
      continue;
    }
    segments.push(segment);
  }
  return { absolute, windows, segments };
}

function relativeSegments(
  from: ParsedPath,
  target: ParsedPath,
): string[] | undefined {
  if (!isRelativePathCompatible(from, target)) return undefined;

  const compareCase = from.windows || target.windows;
  const same = (left: string, right: string): boolean =>
    compareCase ? left.toLowerCase() === right.toLowerCase() : left === right;
  const common = Math.min(from.segments.length, target.segments.length);
  let shared = 0;
  while (
    shared < common &&
    same(from.segments[shared]!, target.segments[shared]!)
  )
    shared += 1;

  const result = Array.from(
    { length: from.segments.length - shared },
    () => "..",
  );
  result.push(...target.segments.slice(shared));
  return result;
}

function isRelativePathCompatible(
  from: ParsedPath,
  target: ParsedPath,
): boolean {
  return (
    from.absolute === target.absolute &&
    !(from.windows !== target.windows && (from.windows || target.windows))
  );
}

function isWithin(root: ParsedPath, value: ParsedPath): boolean {
  const relative = relativeSegments(root, value);
  return Boolean(relative && relative[0] !== "..");
}

function scoreFilenameCandidate(
  query: string,
  file: PreparedWorkspaceFile,
): MatchScore | undefined {
  const lowerFileName = file.lowerFileName;
  if (lowerFileName.startsWith(query)) {
    return {
      category: 0,
      primary: 0,
      secondary: 0,
      nameLength: file.fileName.length,
      relativePath: file.workspaceRelativePath,
    };
  }
  const substringIndex = lowerFileName.indexOf(query);
  if (substringIndex >= 0) {
    return {
      category: 1,
      primary: substringIndex,
      secondary: 0,
      nameLength: file.fileName.length,
      relativePath: file.workspaceRelativePath,
    };
  }
  const fuzzyFileName = fuzzyMatch(query, lowerFileName);
  if (fuzzyFileName) {
    return {
      category: 2,
      primary: fuzzyFileName.gaps,
      secondary: fuzzyFileName.start,
      nameLength: file.fileName.length,
      relativePath: file.workspaceRelativePath,
    };
  }
  return undefined;
}

function scorePathCandidate(
  file: PreparedWorkspaceFile,
  pathQuery: string,
  documentRelativePath: string,
): MatchScore | undefined {
  const normalizedPathQuery = pathQuery.startsWith("./")
    ? pathQuery.slice(2)
    : pathQuery;
  if (!normalizedPathQuery) return undefined;
  const pathValues = [
    {
      value: file.lowerWorkspaceRelativePath,
      relativePath: file.workspaceRelativePath,
    },
    {
      value: documentRelativePath.toLowerCase(),
      relativePath: documentRelativePath,
    },
  ];
  const pathScores = pathValues.flatMap(({ value, relativePath }) => {
    const pathIndex = value.indexOf(normalizedPathQuery);
    if (pathIndex >= 0)
      return [
        {
          primary: pathIndex,
          secondary: 0,
          relativePath,
        },
      ];
    const fuzzyPath = fuzzyMatch(normalizedPathQuery, value);
    return fuzzyPath
      ? [
          {
            primary: fuzzyPath.gaps,
            secondary: fuzzyPath.start,
            relativePath,
          },
        ]
      : [];
  });
  const bestPath = pathScores.sort(
    (left, right) =>
      left.primary - right.primary || left.secondary - right.secondary,
  )[0];
  if (!bestPath) return undefined;
  return {
    category: 3,
    primary: bestPath.primary,
    secondary: bestPath.secondary,
    nameLength: file.fileName.length,
    relativePath: bestPath.relativePath,
  };
}

function normalizePathQuery(query: string): string | undefined {
  const pathQuery = query.replaceAll("\\", "/");
  if (!/\//.test(pathQuery) && !pathQuery.startsWith(".")) return undefined;
  return pathQuery;
}

function fuzzyMatch(
  query: string,
  value: string,
): { readonly gaps: number; readonly start: number } | undefined {
  let cursor = 0;
  let previous = -1;
  let start = -1;
  let gaps = 0;
  for (const character of query) {
    const index = value.indexOf(character, cursor);
    if (index < 0) return undefined;
    if (start < 0) start = index;
    if (previous >= 0) gaps += index - previous - 1;
    previous = index;
    cursor = index + 1;
  }
  return { gaps, start: Math.max(0, start) };
}

function compareScoredCandidates(
  left: ScoredCandidate,
  right: ScoredCandidate,
): number {
  const a = left.score;
  const b = right.score;
  return (
    a.category - b.category ||
    a.primary - b.primary ||
    a.secondary - b.secondary ||
    a.nameLength - b.nameLength ||
    compareStrings(a.relativePath, b.relativePath)
  );
}

class BoundedTopK<T> {
  private readonly entriesList: T[] = [];

  public constructor(
    private readonly limit: number,
    private readonly compare: (left: T, right: T) => number,
  ) {}

  public add(entry: T): void {
    if (this.entriesList.length < this.limit) {
      this.entriesList.push(entry);
      return;
    }

    let worstIndex = 0;
    for (let index = 1; index < this.entriesList.length; index += 1) {
      if (
        this.compare(this.entriesList[index]!, this.entriesList[worstIndex]!) >
        0
      )
        worstIndex = index;
    }
    if (this.compare(entry, this.entriesList[worstIndex]!) < 0)
      this.entriesList[worstIndex] = entry;
  }

  public values(): T[] {
    return this.entriesList.slice().sort(this.compare);
  }
}

function compareStrings(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function isWorkspaceSearchExcludedDirectory(segment: string): boolean {
  const lower = segment.toLowerCase();
  return lower === ".git" || lower === "node_modules";
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
