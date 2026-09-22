import { createHash } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { renderMarkdown } from "../../core/index";
import type { MarkdownProfile } from "../../shared/protocol";
import {
  embedMarkdownImages,
  loadExportMermaidRuntime,
  loadExportStylesheet,
} from "./exportResources";

export interface CreateExportHtmlOptions {
  readonly markdown: string;
  readonly profile: MarkdownProfile;
  readonly documentUri: vscode.Uri;
  readonly title: string;
  /** Optional in tests and callers with an ExtensionContext; normally resolved from VS Code. */
  readonly extensionUri?: vscode.Uri;
}

function extensionRootUri(provided?: vscode.Uri): vscode.Uri {
  if (provided) return provided;
  const installed = vscode.extensions.getExtension("masa-ryu.markdown-mint");
  if (installed) return installed.extensionUri;
  return vscode.Uri.file(path.resolve(__dirname, ".."));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function includesMermaid(html: string): boolean {
  return /\bdata-mm-mermaid\s*=\s*(?:"true"|'true'|true)(?=\s|>)/i.test(html);
}

/** Render the current Markdown source as a self-contained HTML document. */
export async function createExportHtml({
  markdown,
  profile,
  documentUri,
  title,
  extensionUri: providedExtensionUri,
}: CreateExportHtmlOptions): Promise<string> {
  const extensionUri = extensionRootUri(providedExtensionUri);
  const renderedHtml = renderMarkdown(markdown, profile);
  const [html, stylesheet] = await Promise.all([
    embedMarkdownImages(renderedHtml, documentUri),
    loadExportStylesheet(extensionUri),
  ]);
  const mermaidRuntime = includesMermaid(html)
    ? await loadExportMermaidRuntime(extensionUri)
    : undefined;
  const scriptPolicy = mermaidRuntime
    ? `'sha256-${createHash("sha256").update(mermaidRuntime).digest("base64")}'`
    : "'none'";
  const contentSecurityPolicy = [
    "default-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "connect-src 'none'",
    "img-src data: https:",
    "font-src data:",
    "style-src 'unsafe-inline'",
    `script-src ${scriptPolicy}`,
  ].join("; ");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="${escapeHtml(contentSecurityPolicy)}">
  <title>${escapeHtml(title)}</title>
  <style>${stylesheet}</style>
</head>
<body>
  <article class="markdown-body">${html}</article>${
    mermaidRuntime ? `\n  <script>${mermaidRuntime}</script>` : ""
  }
</body>
</html>
`;
}
