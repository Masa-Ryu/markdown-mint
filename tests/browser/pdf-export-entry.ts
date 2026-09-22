import { readFile, writeFile } from "node:fs/promises";
import * as vscode from "vscode";
import { createExportHtml } from "../../src/extension/export/htmlExport";
import { renderPdf } from "../../src/extension/export/pdfExport";

void (async () => {
  const [outputPath, documentPath, extensionPath, executablePath] =
    process.argv.slice(2);
  if (!outputPath || !documentPath || !extensionPath || !executablePath)
    throw new Error("PDF export browser fixture arguments are incomplete.");

  const markdown = await readFile(documentPath, "utf8");
  const html = await createExportHtml({
    markdown,
    profile: "github",
    documentUri: vscode.Uri.file(documentPath),
    title: "PDF export fixture",
    extensionUri: vscode.Uri.file(extensionPath),
  });
  const pdf = await renderPdf(html, {
    executablePath,
    timeoutMs: 90_000,
  });
  await writeFile(outputPath, pdf);
})();
