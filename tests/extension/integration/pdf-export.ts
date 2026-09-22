import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import Module from "node:module";
import * as path from "node:path";
import * as vscode from "vscode";

const outputDirectory = process.env.MARKDOWN_MINT_PDF_OUTPUT_DIR;
const workspaceDirectory = process.env.MARKDOWN_MINT_PDF_WORKSPACE_DIR;
const chromiumExecutablePath = process.env.MARKDOWN_MINT_PDF_CHROMIUM;

interface ModuleParent {
  readonly filename?: string;
}

interface ModuleLoader {
  _load(
    request: string,
    parent: ModuleParent | null | undefined,
    isMain: boolean,
  ): unknown;
}

async function runPdfExportCommandAcceptance(): Promise<void> {
  assert.ok(outputDirectory, "MARKDOWN_MINT_PDF_OUTPUT_DIR is required");
  assert.ok(workspaceDirectory, "MARKDOWN_MINT_PDF_WORKSPACE_DIR is required");
  assert.ok(chromiumExecutablePath, "MARKDOWN_MINT_PDF_CHROMIUM is required");

  const extension = vscode.extensions.getExtension("masa-ryu.markdown-mint");
  assert.ok(extension, "Markdown Mint is available in the development host");

  const outputPaths: string[] = [];
  const userErrors: string[] = [];
  const showSaveDialogStub = async () => {
    process.stdout.write("PDF test save dialog stub called.\n");
    const outputPath = outputPaths.shift();
    assert.ok(outputPath, "the PDF command requested an expected output path");
    return vscode.Uri.file(outputPath);
  };
  const showErrorMessageStub = async (message: string) => {
    userErrors.push(String(message));
    return undefined;
  };
  const productionWindow = new Proxy(vscode.window, {
    get(target, property) {
      if (property === "showSaveDialog") return showSaveDialogStub;
      if (property === "showErrorMessage") return showErrorMessageStub;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const productionVscode = new Proxy(vscode, {
    get(target, property, receiver) {
      if (property === "window") return productionWindow;
      return Reflect.get(target, property, receiver);
    },
  });
  const moduleLoader = Module as unknown as ModuleLoader;
  const originalLoad = moduleLoader._load;
  const productionBundlePath = path.join(
    extension.extensionPath,
    "dist",
    "extension.js",
  );
  moduleLoader._load = function load(request, parent, isMain) {
    if (request === "vscode" && parent?.filename === productionBundlePath) {
      process.stdout.write("Intercepted the packaged extension host API.\n");
      return productionVscode;
    }
    return originalLoad.call(moduleLoader, request, parent, isMain);
  };

  const restoreConfiguration = async (): Promise<void> => {
    await vscode.workspace
      .getConfiguration("markdownMint.export.pdf")
      .update("chromiumExecutablePath", "", vscode.ConfigurationTarget.Global);
  };

  try {
    await extension.activate();
    await vscode.workspace
      .getConfiguration("markdownMint.export.pdf")
      .update(
        "chromiumExecutablePath",
        chromiumExecutablePath,
        vscode.ConfigurationTarget.Global,
      );
    await mkdir(outputDirectory, { recursive: true });
    process.stdout.write("Configured the production PDF command test.\n");

    const cases = [
      {
        name: "plain",
        markdown: "# Production PDF command\n\nPDF_COMMAND_PLAIN_MARKER\n",
      },
      {
        name: "katex",
        markdown:
          "# Production KaTeX PDF command\n\n\\[E = mc^2\\]\n\nPDF_COMMAND_KATEX_MARKER\n",
      },
      {
        name: "mermaid",
        markdown:
          "# Production Mermaid PDF command\n\n```mermaid\ngraph TD\n  Start --> PDF_COMMAND_MERMAID_MARKER\n```\n",
      },
    ];

    for (const item of cases) {
      const markdownPath = path.join(workspaceDirectory, `${item.name}.md`);
      const outputPath = path.join(outputDirectory, `${item.name}.pdf`);
      await writeFile(markdownPath, item.markdown, "utf8");
      await rm(outputPath, { force: true });
      outputPaths.push(outputPath);
      const documentUri = vscode.Uri.file(markdownPath);
      await vscode.workspace.openTextDocument(documentUri);
      process.stdout.write(`Opened PDF test document: ${item.name}.\n`);
      process.stdout.write(`Invoking packaged PDF command: ${item.name}.\n`);
      await vscode.commands.executeCommand(
        "markdownMint.exportPdf",
        documentUri,
      );
      process.stdout.write(`Packaged PDF command returned: ${item.name}.\n`);
      const pdf = await readFile(outputPath).catch(() => undefined);
      assert.ok(
        pdf?.subarray(0, 5).toString("ascii") === "%PDF-",
        `the ${item.name} document was exported through the production PDF command${
          userErrors.length > 0
            ? `; user-facing errors: ${userErrors.join(" | ")}`
            : ""
        }`,
      );
    }

    assert.deepEqual(
      userErrors,
      [],
      "PDF export completed without host errors",
    );
    process.stdout.write(
      "Production dist/extension.js PDF command passed for plain, KaTeX, and Mermaid documents.\n",
    );
  } finally {
    moduleLoader._load = originalLoad;
    await restoreConfiguration();
  }
}

export async function run(): Promise<void> {
  await runPdfExportCommandAcceptance();
}
