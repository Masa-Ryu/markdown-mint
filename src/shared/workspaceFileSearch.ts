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
  readonly candidate: WorkspaceFileCandidate;
  readonly score: MatchScore;
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
 * Search and rank a bounded list of files. The class has no VS Code or Node
 * dependency so its path semantics can be tested independently of a host.
 */
export class WorkspaceFileSearch {
  private readonly maxResults: number;

  public constructor(maxResults = MAX_WORKSPACE_FILE_SEARCH_RESULTS) {
    this.maxResults = Math.max(1, Math.min(maxResults, 100));
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
    const scored: ScoredCandidate[] = [];

    for (const file of options.files) {
      const parsedFile = parsePath(file.path);
      const workspaceRelative = relativeSegments(workspace, parsedFile);
      if (
        !workspaceRelative ||
        workspaceRelative.length === 0 ||
        workspaceRelative[0] === ".."
      )
        continue;

      const fileName = workspaceRelative.at(-1);
      if (!fileName) continue;
      if (options.filter === "image" && !isImageFileName(fileName)) continue;

      const relativeSegmentsFromDocument = relativeSegments(
        { ...document, segments: documentDirectory },
        parsedFile,
      );
      if (!relativeSegmentsFromDocument) continue;
      const relativePath = encodeMarkdownPath(relativeSegmentsFromDocument);
      const workspaceRelativePath = workspaceRelative.join("/");
      const directorySegments = workspaceRelative.slice(0, -1);
      const directory = directorySegments.length
        ? `${directorySegments.join("/")}/`
        : "./";
      const candidate: WorkspaceFileCandidate = {
        fileName,
        directory,
        relativePath,
      };
      const score = scoreCandidate(query, fileName, workspaceRelativePath);
      if (score) scored.push({ candidate, score });
    }

    scored.sort(compareScoredCandidates);
    return scored.slice(0, limit).map(({ candidate }) => candidate);
  }
}

/** Generate a Markdown-safe relative path between URI path components. */
export function relativeMarkdownPath(
  documentPath: string,
  targetPath: string,
): string | undefined {
  const document = parsePath(documentPath);
  const target = parsePath(targetPath);
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
  if (from.absolute !== target.absolute) return undefined;
  if (from.windows !== target.windows && (from.windows || target.windows))
    return undefined;

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

function isWithin(root: ParsedPath, value: ParsedPath): boolean {
  const relative = relativeSegments(root, value);
  return Boolean(relative && relative[0] !== "..");
}

function scoreCandidate(
  query: string,
  fileName: string,
  workspaceRelativePath: string,
): MatchScore | undefined {
  const lowerFileName = fileName.toLowerCase();
  const lowerPath = workspaceRelativePath.toLowerCase();
  if (lowerFileName.startsWith(query)) {
    return {
      category: 0,
      primary: 0,
      secondary: 0,
      nameLength: fileName.length,
      relativePath: workspaceRelativePath,
    };
  }
  const substringIndex = lowerFileName.indexOf(query);
  if (substringIndex >= 0) {
    return {
      category: 1,
      primary: substringIndex,
      secondary: 0,
      nameLength: fileName.length,
      relativePath: workspaceRelativePath,
    };
  }
  const fuzzyFileName = fuzzyMatch(query, lowerFileName);
  if (fuzzyFileName) {
    return {
      category: 2,
      primary: fuzzyFileName.gaps,
      secondary: fuzzyFileName.start,
      nameLength: fileName.length,
      relativePath: workspaceRelativePath,
    };
  }
  const pathIndex = lowerPath.indexOf(query);
  if (pathIndex >= 0) {
    return {
      category: 3,
      primary: pathIndex,
      secondary: 0,
      nameLength: fileName.length,
      relativePath: workspaceRelativePath,
    };
  }
  const fuzzyPath = fuzzyMatch(query, lowerPath);
  if (!fuzzyPath) return undefined;
  return {
    category: 3,
    primary: fuzzyPath.gaps,
    secondary: fuzzyPath.start,
    nameLength: fileName.length,
    relativePath: workspaceRelativePath,
  };
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

function compareStrings(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
