import { describe, expect, it } from "vitest";
import {
  WorkspaceFileSearch,
  createWorkspaceFileSearchIndex,
  encodeMarkdownPath,
  isImageFileName,
  isWorkspaceFileSearchQuery,
  relativeMarkdownPath,
} from "../../src/shared/workspaceFileSearch";

const search = new WorkspaceFileSearch();
const file = (path: string) => ({ path });

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
        fileName: "guide.md",
        directory: "docs/",
        relativePath: "./guide.md",
      },
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
});
