import { describe, expect, it } from "vitest";
import { loadFormatterConfig } from "../../src/extension/formatterConfig";

function memoryFileSystem(files: Record<string, string>) {
  return {
    async readFile(filePath: string): Promise<string | undefined> {
      return files[filePath];
    },
  };
}

describe("project formatter configuration", () => {
  it("reads JSON Prettier options and the matching EditorConfig EOL", async () => {
    const files = {
      "/workspace/.prettierrc.json":
        '{"printWidth": 42, "proseWrap": "always", "plugins": ["unsafe"]}',
      "/workspace/.editorconfig": "root = true\n[*]\nend_of_line = crlf\n",
    };
    const result = await loadFormatterConfig(
      "/workspace/docs/readme.md",
      memoryFileSystem(files),
      { workspaceRoot: "/workspace", isTrusted: false },
    );
    expect(result.options).toEqual({
      printWidth: 42,
      proseWrap: "always",
      endOfLine: "crlf",
    });
    expect(result.ignored).toBe(false);
    expect(result.diagnostics).toEqual([]);
  });

  it("reads YAML options and applies a matching file override", async () => {
    const files = {
      "/workspace/.prettierrc.yaml":
        "printWidth: 80\nproseWrap: preserve\noverrides:\n  - files: ['docs/**/*.md']\n    printWidth: 28\n",
    };
    const result = await loadFormatterConfig(
      "/workspace/docs/guide.md",
      memoryFileSystem(files),
      { workspaceRoot: "/workspace", isTrusted: false },
    );
    expect(result.options).toEqual({ printWidth: 28, proseWrap: "preserve" });
  });

  it("supports standard nested override options and excludeFiles", async () => {
    const files = {
      "/workspace/.prettierrc.json": JSON.stringify({
        printWidth: 80,
        overrides: [
          {
            files: "**/*.md",
            options: { printWidth: 30, proseWrap: "always" },
          },
          {
            files: "**/*.md",
            excludeFiles: "docs/generated/**",
            options: { printWidth: 25 },
          },
        ],
      }),
    };
    const fs = memoryFileSystem(files);
    const regular = await loadFormatterConfig("/workspace/docs/guide.md", fs, {
      workspaceRoot: "/workspace",
      isTrusted: false,
    });
    const excluded = await loadFormatterConfig(
      "/workspace/docs/generated/guide.md",
      fs,
      { workspaceRoot: "/workspace", isTrusted: false },
    );
    expect(regular.options).toEqual({ printWidth: 25, proseWrap: "always" });
    expect(excluded.options).toEqual({ printWidth: 30, proseWrap: "always" });
  });

  it("honors ordered prettierignore patterns and negation", async () => {
    const files = {
      "/workspace/.prettierignore": "generated/\n*.md\n!keep.md\n",
    };
    const fs = memoryFileSystem(files);
    const ignored = await loadFormatterConfig(
      "/workspace/generated/output.md",
      fs,
      { workspaceRoot: "/workspace", isTrusted: false },
    );
    const restored = await loadFormatterConfig("/workspace/keep.md", fs, {
      workspaceRoot: "/workspace",
      isTrusted: false,
    });
    expect(ignored.ignored).toBe(true);
    expect(restored.ignored).toBe(false);
  });

  it("interprets a nested prettierignore relative to its own directory", async () => {
    const files = {
      "/workspace/packages/pkg/.prettierignore": "generated/**\n",
    };
    const result = await loadFormatterConfig(
      "/workspace/packages/pkg/generated/file.md",
      memoryFileSystem(files),
      { workspaceRoot: "/workspace", isTrusted: false },
    );
    expect(result.ignored).toBe(true);
  });

  it("supports EditorConfig brace globs", async () => {
    const files = {
      "/workspace/.editorconfig":
        "root = true\n[{*.md,*.markdown}]\nend_of_line = crlf\n",
    };
    const result = await loadFormatterConfig(
      "/workspace/docs/guide.md",
      memoryFileSystem(files),
      { workspaceRoot: "/workspace", isTrusted: false },
    );
    expect(result.options.endOfLine).toBe("crlf");
  });

  it("reads a package.json prettier field when it is the resolved config", async () => {
    const files = {
      "/workspace/package.json": JSON.stringify({
        name: "fixture",
        prettier: { printWidth: 36 },
      }),
    };
    const result = await loadFormatterConfig(
      "/workspace/docs/guide.md",
      memoryFileSystem(files),
      { workspaceRoot: "/workspace", isTrusted: false },
    );
    expect(result.options).toEqual({ printWidth: 36 });
  });

  it("reports executable configuration instead of evaluating it in an untrusted workspace", async () => {
    const files = { "/workspace/.prettierrc.js": "module.exports = {};" };
    const result = await loadFormatterConfig(
      "/workspace/readme.md",
      memoryFileSystem(files),
      { workspaceRoot: "/workspace", isTrusted: false },
    );
    expect(result.options).toEqual({});
    expect(result.diagnostics.join("\n")).toContain("untrusted workspace");
  });

  it("uses a trusted resolver only for executable configuration", async () => {
    const files = { "/workspace/.prettierrc.cjs": "module.exports = {};" };
    let calledWith = "";
    const result = await loadFormatterConfig(
      "/workspace/readme.md",
      memoryFileSystem(files),
      {
        workspaceRoot: "/workspace",
        isTrusted: true,
        resolver: {
          resolveTrustedConfig: async (filePath) => {
            calledWith = filePath;
            return { printWidth: 36 };
          },
        },
      },
    );
    expect(calledWith).toBe("/workspace/readme.md");
    expect(result.options).toEqual({ printWidth: 36 });
    expect(result.diagnostics).toEqual([]);
  });
});
