import { beforeEach, describe, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => {
  function normalizePath(value: string): string {
    const absolute = value.startsWith("/");
    const segments: string[] = [];
    for (const segment of value.split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === ".." && segments.length > 0 && segments.at(-1) !== "..")
        segments.pop();
      else if (segment !== ".." || !absolute) segments.push(segment);
    }
    return (
      `${absolute ? "/" : ""}${segments.join("/")}` || (absolute ? "/" : "")
    );
  }

  class UriStub {
    public readonly fsPath: string;
    public readonly query = "";
    public readonly fragment = "";

    public constructor(
      public readonly scheme: string,
      public readonly path: string,
      public readonly authority = "",
    ) {
      this.path = normalizePath(path);
      this.fsPath = this.path;
    }

    public static file(value: string): UriStub {
      return new UriStub("file", value.startsWith("/") ? value : `/${value}`);
    }

    public static parse(value: string): UriStub {
      const parsed = new URL(value);
      return new UriStub(
        parsed.protocol.replace(/:$/, ""),
        decodeURIComponent(parsed.pathname),
        parsed.hostname,
      );
    }

    public static joinPath(base: UriStub, ...parts: string[]): UriStub {
      return new UriStub(
        base.scheme,
        normalizePath([base.path, ...parts].join("/")),
        base.authority,
      );
    }

    public with(options: { path?: string }): UriStub {
      return new UriStub(
        this.scheme,
        options.path ?? this.path,
        this.authority,
      );
    }
  }

  const readFile = vi.fn(async (_uri: unknown) => new Uint8Array());
  return {
    UriStub,
    readFile,
    vscode: {
      Uri: UriStub,
      workspace: { fs: { readFile } },
      extensions: { getExtension: () => undefined },
    },
  };
});

vi.mock("vscode", () => stubs.vscode);

import type * as vscode from "vscode";
import { renderMarkdown } from "../../../src/core/index";
import {
  createExportHtml,
  type CreateExportHtmlOptions,
} from "../../../src/extension/export/htmlExport";
import { embedMarkdownImages } from "../../../src/extension/export/exportResources";

const extensionUri = new stubs.UriStub("file", "/extension");
const documentUri = new stubs.UriStub("file", "/docs/sub/guide.md");
const encoder = new TextEncoder();

function asBytes(value: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(value);
}

function exportOptions(
  overrides: Partial<CreateExportHtmlOptions> = {},
): CreateExportHtmlOptions {
  return {
    markdown: "# Export\n\nA paragraph.",
    profile: "github",
    documentUri: documentUri as unknown as vscode.Uri,
    title: "guide",
    extensionUri: extensionUri as unknown as vscode.Uri,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  stubs.readFile.mockImplementation(async (rawUri: unknown) => {
    const uri = rawUri as { path: string };
    if (uri.path.endsWith("/media/document.css"))
      return asBytes(".markdown-body { color: var(--vscode-foreground); }");
    if (uri.path.endsWith("/media/export.css"))
      return asBytes(
        ':root { color-scheme: light; --vscode-background: #ffffff; --vscode-editor-background: #ffffff; --mm-document-min-width: 0px; } .markdown-body input[type=checkbox][data-task-state="mixed"] { background-image: linear-gradient(#fff, #fff); } .markdown-body input[type=checkbox]:checked { background-image: url(data:image/svg+xml,check); }',
      );
    if (uri.path.endsWith("/dist/katex/katex.css"))
      return asBytes(
        '@font-face{src:url(fonts/KaTeX_Main-Regular.woff2) format("woff2");}',
      );
    if (uri.path.endsWith("/dist/katex/fonts/KaTeX_Main-Regular.woff2"))
      return asBytes("font-data");
    if (uri.path.endsWith("/dist/mermaid.js"))
      return asBytes("globalThis.markdownMintMermaid = {};\n");
    if (uri.path === "/docs/images/my image.png")
      return new Uint8Array([1, 2, 3]);
    if (uri.path === "/outside/picture.jpeg") return new Uint8Array([4, 5]);
    if (uri.path === "/docs/diagram.svg") return asBytes("<svg></svg>");
    throw new Error(`Unexpected or unreadable resource: ${uri.path}`);
  });
});

describe("standalone HTML export", () => {
  it("uses renderMarkdown output for each profile and packages portable styles", async () => {
    const markdown = "# Heading\n\n- first\n- second\n\n> quoted";
    for (const profile of ["commonmark", "github", "gitlab"] as const) {
      const html = await createExportHtml(exportOptions({ markdown, profile }));
      expect(html).toContain(
        `<article class="markdown-body">${renderMarkdown(markdown, profile)}</article>`,
      );
      expect(html).toContain("color-scheme: light");
      expect(html).toContain('<html lang="en" class="vscode-light">');
      expect(html).toContain('<body class="vscode-light">');
      expect(html).toContain("--vscode-background: #ffffff");
      expect(html).toContain("--vscode-editor-background: #ffffff");
      expect(html).toContain("min-width: 0px");
      expect(html).toContain("data:font/woff2;base64,Zm9udC1kYXRh");
      expect(html).toContain("script-src 'none'");
    }
  });

  it("preserves GitHub tables, task lists, alerts, code, math, footnotes, and anchors", async () => {
    const markdown = [
      "# Guide",
      "",
      "| Name | Value |",
      "| --- | --- |",
      "| one | two |",
      "",
      "- [x] Complete",
      "",
      "> [!NOTE]",
      "> Keep this note.",
      "",
      "```ts",
      "const answer: number = 42;",
      "```",
      "",
      "Inline math $x^2$.",
      "",
      "Block math:",
      "",
      "$$",
      "\\frac{1}{2}",
      "$$",
      "",
      "Read this[^note].",
      "",
      "[^note]: A footnote.",
    ].join("\n");
    const rendered = renderMarkdown(markdown, "github");
    const html = await createExportHtml(
      exportOptions({ markdown, profile: "github" }),
    );

    expect(rendered).toContain("<table>");
    expect(rendered).toContain('type="checkbox"');
    expect(rendered).toContain("markdown-alert");
    expect(rendered).toContain("<pre");
    expect(rendered).toContain('class="language-typescript hljs"');
    expect(rendered).toContain("katex");
    expect(rendered).toContain("katex-display");
    expect(rendered).toContain("footnote");
    expect(rendered).toContain('id="guide"');
    expect(html).toContain(
      `<article class="markdown-body">${rendered}</article>`,
    );
  });

  it("embeds relative and absolute local PNG, JPEG, and SVG images", async () => {
    const result = await embedMarkdownImages(
      '<img alt="space" src="../images/my%20image.png"><img src="file:///outside/picture.jpeg"><img src="../diagram.svg">',
      documentUri as unknown as vscode.Uri,
    );
    expect(result).toContain("data:image/png;base64,AQID");
    expect(result).toContain("data:image/jpeg;base64,BAU=");
    expect(result).toContain(
      `data:image/svg+xml;base64,${Buffer.from("<svg></svg>").toString("base64")}`,
    );
    expect(stubs.readFile).toHaveBeenCalledTimes(3);
  });

  it("resolves a Markdown file URI through createExportHtml into a data image", async () => {
    const markdown = "![absolute](file:///outside/picture.jpeg)";
    expect(renderMarkdown(markdown, "github")).not.toContain("<img");
    const html = await createExportHtml(exportOptions({ markdown }));

    expect(renderMarkdown(markdown, "github")).not.toContain("<img");
    expect(html).toContain("data:image/jpeg;base64,BAU=");
    expect(html).toContain('src="data:image/jpeg;base64,BAU=" alt="absolute"');
    expect(stubs.readFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/outside/picture.jpeg" }),
    );
  });

  it("renders GitLab todo, done, and mixed tasks as static distinct controls", async () => {
    const markdown = ["- [ ] Todo", "- [x] Done", "- [~] In progress"].join(
      "\n",
    );
    const html = await createExportHtml(
      exportOptions({ markdown, profile: "gitlab" }),
    );

    expect(html).toContain('<input type="checkbox" disabled> ');
    expect(html).toContain('<input type="checkbox" disabled checked> ');
    expect(html).toContain(
      '<input type="checkbox" disabled data-task-state="mixed" aria-checked="mixed"> ',
    );
    expect(html).toContain("Todo");
    expect(html).toContain("Done");
    expect(html).toContain("In progress");
    expect(html).toContain('[data-task-state="mixed"]');
    expect(html).toContain(":checked");
    expect(html).toContain("script-src 'none'");
    expect(html).not.toContain("globalThis.markdownMintMermaid");
  });

  it("keeps data and HTTPS images without network fetches", async () => {
    const result = await embedMarkdownImages(
      '<img src="data:image/png;base64,AAAA"><img src="https://images.example.test/a.png">',
      documentUri as unknown as vscode.Uri,
    );
    expect(result).toContain("data:image/png;base64,AAAA");
    expect(result).toContain('src="https://images.example.test/a.png"');
    expect(stubs.readFile).not.toHaveBeenCalled();
  });

  it("removes unsafe image schemes and preserves unreadable local references", async () => {
    const result = await embedMarkdownImages(
      '<img src="javascript:alert(1)"><img src="vscode-webview://resource/a.png"><img src="./missing.png">',
      documentUri as unknown as vscode.Uri,
    );
    expect(result).not.toMatch(/src="(?:javascript:|vscode-webview:)/i);
    expect(result).toContain('src="./missing.png"');
  });

  it("inlines the packaged Mermaid runtime only when a placeholder exists", async () => {
    const plain = await createExportHtml(exportOptions());
    expect(plain).not.toContain("markdownMintMermaid");
    expect(plain).toContain("script-src 'none'");

    const mermaid = await createExportHtml(
      exportOptions({ markdown: "```mermaid\ngraph TD; A-->B\n```" }),
    );
    expect(mermaid).toContain('data-mm-mermaid="true"');
    expect(mermaid).toContain(
      "<script>globalThis.markdownMintMermaid = {};</script>",
    );
    expect(mermaid).toMatch(/script-src 'sha256-[^']+'/);
    expect(stubs.readFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/extension/dist/mermaid.js" }),
    );
  });

  it("keeps renderer sanitization and disallows Markdown scripts and unsafe links", async () => {
    const html = await createExportHtml(
      exportOptions({
        markdown:
          "<script>window.exported = true</script>\n\n[unsafe](javascript:alert(1))",
      }),
    );
    expect(html).not.toContain("<script>window.exported");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("script-src 'none'");
  });
});
