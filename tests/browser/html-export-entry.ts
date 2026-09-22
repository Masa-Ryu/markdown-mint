import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import * as vscode from "vscode";
import { createExportHtml } from "../../src/extension/export/htmlExport";

const [outputPath, documentPath, imagePath, extensionPath] =
  process.argv.slice(2);
if (!outputPath || !documentPath || !imagePath || !extensionPath)
  throw new Error("HTML export browser fixture arguments are incomplete.");

const inlineImage =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lF8AAAAASUVORK5CYII=";
const markdown = [
  "# Standalone HTML export smoke",
  "",
  `![Local image](${pathToFileURL(imagePath).href})`,
  `![Data image](data:image/png;base64,${inlineImage})`,
  "Inline math $x^2$.",
  "",
  "$$",
  "\\frac{1}{2}",
  "$$",
  "",
  "- [ ] Todo",
  "- [x] Done",
  "- [~] In progress",
  "",
  "```ts",
  "const htmlExportActions = 'hidden in the standalone HTML';",
  "```",
  "",
  "```mermaid",
  "graph TD",
  "  A[Node A] -->|edge label| B[Node B]",
  "```",
  "",
  "<script>window.__markdownMintInjected = true</script>",
].join("\n");

const html = await createExportHtml({
  markdown,
  profile: "gitlab",
  documentUri: vscode.Uri.file(documentPath),
  title: "Standalone export smoke",
  extensionUri: vscode.Uri.file(extensionPath),
});
await writeFile(outputPath, html, "utf8");
