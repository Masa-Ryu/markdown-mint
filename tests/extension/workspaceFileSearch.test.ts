import { describe, expect, it } from "vitest";
import {
  WorkspaceFileSearch,
  createWorkspaceFileSearchIndex,
  encodeMarkdownPath,
  extendWorkspaceFileSearchIndex,
  isImageFileName,
  isWorkspaceFileSearchQuery,
  relativeMarkdownPath,
} from "../../src/shared/workspaceFileSearch";

const search = new WorkspaceFileSearch();
const file = (path: string) => ({ path });
const directory = (path: string) => ({ path, kind: "directory" as const });

describe("WorkspaceFileSearch", () => {
  it("ranks filename prefix, substring, fuzzy, and path matches in order", () => {
    const candidates = search.search({
      documentPath: "/project/docs/manual.md",
      workspaceFolderPath: "/project",
      query: "ho",
      filter: "all",
      files: [
        file("/project/how-to/README.md"),
        file("/project/docs/how-to-use.md"),
        file("/project/docs/hoge-design.md"),
        file("/project/specs/Hoge.pdf"),
      ],
    });

    expect(candidates.map((candidate) => candidate.fileName)).toEqual([
      "Hoge.pdf",
      "how-to-use.md",
      "hoge-design.md",
    ]);
    expect(candidates.at(-1)?.directory).toBe("docs/");
  });

  it("matches fuzzy filenames case-insensitively", () => {
    const candidates = search.search({
      documentPath: "/project/docs/manual.md",
      workspaceFolderPath: "/project",
      query: "hgd",
      filter: "all",
      files: [file("/project/specs/Hoge-Design.md")],
    });

    expect(candidates).toMatchObject([
      { fileName: "Hoge-Design.md", relativePath: "../specs/Hoge-Design.md" },
    ]);
  });

  it("limits results and never returns files outside the current folder", () => {
    const files = Array.from({ length: 14 }, (_, index) =>
      file(`/project/files/foo-${String(index).padStart(2, "0")}.md`),
    );
    files.push(file("/another-project/files/foo-outside.md"));

    const candidates = search.search({
      documentPath: "/project/docs/manual.md",
      workspaceFolderPath: "/project",
      query: "foo",
      filter: "all",
      files,
    });

    expect(candidates).toHaveLength(10);
    expect(
      candidates.every((candidate) => !candidate.fileName.includes("outside")),
    ).toBe(true);
  });

  it("does not return files below .git or node_modules", () => {
    const candidates = search.search({
      documentPath: "/project/docs/manual.md",
      workspaceFolderPath: "/project",
      query: "guide",
      filter: "all",
      files: [
        file("/project/.git/guide.md"),
        file("/project/node_modules/package/guide.md"),
        file("/project/src/.GIT/guide.md"),
        file("/project/src/NODE_MODULES/guide.md"),
        file("/project/docs/guide.md"),
      ],
    });

    expect(candidates).toEqual([
      {
        kind: "file",
        fileName: "guide.md",
        directory: "docs/",
        relativePath: "./guide.md",
      },
    ]);
  });

  it("reuses workspace-normalized metadata for repeated queries", () => {
    const index = createWorkspaceFileSearchIndex("/project", [
      file("/project/docs/guide.md"),
      file("/project/node_modules/pkg/guide.md"),
    ]);
    const candidates = search.search({
      documentPath: "/project/docs/manual.md",
      workspaceFolderPath: "/project",
      query: "guide",
      filter: "all",
      files: [],
      index,
    });

    expect(candidates).toEqual([
      {
        kind: "file",
        fileName: "guide.md",
        directory: "docs/",
        relativePath: "./guide.md",
      },
    ]);
  });

  it("extends a cached file index with directories without rebuilding file metadata", () => {
    const fileIndex = createWorkspaceFileSearchIndex("/project", [
      file("/project/docs/guide.md"),
    ]);
    const combinedIndex = extendWorkspaceFileSearchIndex(fileIndex, [
      directory("/project/design"),
    ]);

    expect(combinedIndex.files[0]).toBe(fileIndex.files[0]);
    expect(
      search.search({
        documentPath: "/project/README.md",
        workspaceFolderPath: "/project",
        query: "guide",
        filter: "all",
        files: [],
        index: combinedIndex,
      }),
    ).toEqual([
      expect.objectContaining({ kind: "file", fileName: "guide.md" }),
    ]);
    expect(
      search.search({
        documentPath: "/project/README.md",
        workspaceFolderPath: "/project",
        query: "design",
        filter: "all",
        files: [],
        index: combinedIndex,
      }),
    ).toEqual([
      expect.objectContaining({ kind: "directory", fileName: "design" }),
    ]);

    const caseSensitiveIndex = extendWorkspaceFileSearchIndex(
      createWorkspaceFileSearchIndex("/project", []),
      [directory("/project/Foo"), directory("/project/foo")],
    );
    expect(caseSensitiveIndex.files.map((entry) => entry.fileName)).toEqual([
      "Foo",
      "foo",
    ]);
  });

  it("only uses path matching when the query is path-like", () => {
    const filenameMatches = search.search({
      documentPath: "/project/docs/manual.md",
      workspaceFolderPath: "/project",
      query: "demo",
      filter: "all",
      files: [
        file("/project/output/playwright/README.md"),
        file("/project/docs/demo.md"),
      ],
    });
    expect(filenameMatches.map((candidate) => candidate.fileName)).toEqual([
      "demo.md",
    ]);

    const pathMatches = search.search({
      documentPath: "/project/docs/manual.md",
      workspaceFolderPath: "/project",
      query: "output/",
      filter: "all",
      files: [file("/project/output/playwright/README.md")],
    });
    expect(pathMatches).toMatchObject([
      {
        fileName: "README.md",
        relativePath: "../output/playwright/README.md",
      },
    ]);
  });

  it("generates portable relative paths and encodes URI delimiters", () => {
    expect(
      relativeMarkdownPath(
        "/project/docs/manual.md",
        "/project/docs/target.md",
      ),
    ).toBe("./target.md");
    expect(
      relativeMarkdownPath(
        "/project/docs/manual.md",
        "/project/docs/assets/logo.png",
      ),
    ).toBe("./assets/logo.png");
    expect(
      relativeMarkdownPath("/project/docs/manual.md", "/project/README.md"),
    ).toBe("../README.md");
    expect(
      relativeMarkdownPath(
        "/project/docs/manual.md",
        "/project/specs/design.md",
      ),
    ).toBe("../specs/design.md");
    expect(
      relativeMarkdownPath(
        "/project/docs/manual.md",
        "/project/docs",
        "directory",
      ),
    ).toBe("./");
    expect(
      relativeMarkdownPath(
        "/project/docs/manual.md",
        "/project/docs/assets",
        "directory",
      ),
    ).toBe("./assets/");
    expect(
      relativeMarkdownPath(
        "/project/docs/manual.md",
        "/project/design",
        "directory",
      ),
    ).toBe("../design/");
    expect(
      encodeMarkdownPath(["..", "specs", "hoge manual #?% 日本語 (draft).pdf"]),
    ).toBe(
      "../specs/hoge%20manual%20%23%3F%25%20%E6%97%A5%E6%9C%AC%E8%AA%9E%20%28draft%29.pdf",
    );
    expect(
      relativeMarkdownPath(
        "C:\\project\\docs\\manual.md",
        "C:\\project\\assets\\c#-guide.md",
      ),
    ).toBe("../assets/c%23-guide.md");
    expect(
      relativeMarkdownPath(
        "/C:/Project/docs/manual.md",
        "/c:/project/assets/c#-guide.md",
      ),
    ).toBe("../assets/c%23-guide.md");
  });

  it("only returns the supported image extensions for image searches", () => {
    const imageNames = [
      "a.png",
      "a.JPG",
      "a.jpeg",
      "a.gif",
      "a.webp",
      "a.svg",
      "a.avif",
      "a.bmp",
    ];
    expect(imageNames.every(isImageFileName)).toBe(true);
    expect(isImageFileName("manual.pdf")).toBe(false);
    expect(isImageFileName("README.md")).toBe(false);

    const candidates = search.search({
      documentPath: "/project/docs/manual.md",
      workspaceFolderPath: "/project",
      query: "a",
      filter: "image",
      files: [...imageNames, "manual.pdf", "README.md"].map((name) =>
        file(`/project/assets/${name}`),
      ),
    });
    expect(candidates).toHaveLength(8);
    expect(
      candidates.every((candidate) => isImageFileName(candidate.fileName)),
    ).toBe(true);
  });

  it("does not start local search for URLs or anchors", () => {
    expect(isWorkspaceFileSearchQuery("ho")).toBe(true);
    expect(isWorkspaceFileSearchQuery("https://example.com")).toBe(false);
    expect(isWorkspaceFileSearchQuery("mailto:user@example.com")).toBe(false);
    expect(isWorkspaceFileSearchQuery("tel:+1-555-0100")).toBe(false);
    expect(isWorkspaceFileSearchQuery("#heading")).toBe(false);
    expect(isWorkspaceFileSearchQuery(`ho${String.fromCharCode(0)}ge`)).toBe(
      false,
    );
  });

  it("matches directory names by prefix, substring, and fuzzy ranking", () => {
    const entries = [
      directory("/project/design-system"),
      directory("/project/docs"),
      directory("/project/my-docs"),
    ];
    const searchDirectory = (query: string) =>
      search.search({
        documentPath: "/project/README.md",
        workspaceFolderPath: "/project",
        query,
        filter: "all",
        files: entries,
      });

    expect(
      searchDirectory("doc").map((candidate) => candidate.fileName),
    ).toEqual(["docs", "my-docs"]);
    expect(
      searchDirectory("sign").map((candidate) => candidate.fileName),
    ).toEqual(["design-system"]);
    expect(
      searchDirectory("dsy").map((candidate) => candidate.fileName),
    ).toEqual(["design-system"]);
  });

  it("searches nested directory paths and emits slash-terminated relative paths", () => {
    const candidates = search.search({
      documentPath: "/project/docs/manual.md",
      workspaceFolderPath: "/project",
      query: "../design/research/",
      filter: "all",
      files: [
        directory("/project/design/research"),
        directory("/project/design"),
      ],
    });

    expect(candidates).toEqual([
      {
        kind: "directory",
        fileName: "research",
        directory: "design/",
        relativePath: "../design/research/",
      },
    ]);
  });

  it("keeps a same-named file and directory distinct and deduplicates repeated directories", () => {
    const candidates = search.search({
      documentPath: "/project/docs/manual.md",
      workspaceFolderPath: "/project",
      query: "theme",
      filter: "all",
      files: [
        file("/project/docs/theme"),
        directory("/project/docs/theme"),
        directory("/project/docs/theme/"),
      ],
    });

    expect(candidates).toEqual([
      {
        kind: "file",
        fileName: "theme",
        directory: "docs/",
        relativePath: "./theme",
      },
      {
        kind: "directory",
        fileName: "theme",
        directory: "docs/",
        relativePath: "./theme/",
      },
    ]);
  });

  it("indexes empty directories and encodes names used in links", () => {
    const candidates = search.search({
      documentPath: "/project/docs/manual.md",
      workspaceFolderPath: "/project",
      query: "資料 #?%",
      filter: "all",
      files: [directory("/project/資料 #?%")],
    });

    expect(candidates).toEqual([
      {
        kind: "directory",
        fileName: "資料 #?%",
        directory: "./",
        relativePath: "../%E8%B3%87%E6%96%99%20%23%3F%25/",
      },
    ]);
  });

  it("keeps directory searches bounded to ten mixed file and directory results", () => {
    const entries = [
      ...Array.from({ length: 5 }, (_, index) =>
        file(`/project/items/item-${String(index).padStart(2, "0")}.md`),
      ),
      ...Array.from({ length: 25 }, (_, index) =>
        directory(
          `/project/items/group-item-${String(index).padStart(2, "0")}`,
        ),
      ),
    ];
    const candidates = search.search({
      documentPath: "/project/README.md",
      workspaceFolderPath: "/project",
      query: "item-",
      filter: "all",
      files: entries,
    });

    expect(candidates).toHaveLength(10);
    expect(candidates.some((candidate) => candidate.kind === "file")).toBe(
      true,
    );
    expect(candidates.some((candidate) => candidate.kind === "directory")).toBe(
      true,
    );
  });

  it("excludes directories in image searches", () => {
    const candidates = search.search({
      documentPath: "/project/docs/manual.md",
      workspaceFolderPath: "/project",
      query: "logo",
      filter: "image",
      files: [
        directory("/project/assets/logo"),
        file("/project/assets/logo.png"),
      ],
    });

    expect(candidates).toEqual([
      {
        kind: "file",
        fileName: "logo.png",
        directory: "assets/",
        relativePath: "../assets/logo.png",
      },
    ]);
  });

  it("ranks a large mixed directory index with bounded results", () => {
    const entries = Array.from({ length: 50_000 }, (_, index) => {
      const path = `/project/generated/group-${Math.floor(index / 100)}/folder-${String(index).padStart(5, "0")}`;
      return index % 2 === 0 ? file(`${path}.md`) : directory(path);
    });
    const index = createWorkspaceFileSearchIndex("/project", entries);
    const candidates = search.search({
      documentPath: "/project/docs/manual.md",
      workspaceFolderPath: "/project",
      query: "folder-12",
      filter: "all",
      files: [],
      index,
    });

    expect(candidates).toHaveLength(10);
    expect(candidates.every((candidate) => candidate.kind)).toBe(true);
  });
});
