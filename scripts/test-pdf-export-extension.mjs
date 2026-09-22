import { runTests } from "@vscode/test-electron";
import { chromium } from "playwright";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const useVsix = process.argv.includes("--vsix");
const extensionTestsPath = resolve(repository, "dist", "test-pdf-export.js");
const vscodeExecutablePath =
  process.env.MARKDOWN_MINT_CODE ??
  [
    "/Applications/Visual Studio Code.app/Contents/MacOS/Code",
    "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
  ].find((candidate) => existsSync(candidate));
const temporaryRoot = await mkdtemp(
  join(process.env.MARKDOWN_MINT_TEST_TMP ?? "/private/tmp", "mm-pdf-ext-"),
);
const userDataDirectory = join(temporaryRoot, "user-data");
const extensionsDirectory = join(temporaryRoot, "extensions");
const workspaceDirectory = join(temporaryRoot, "workspace");
const outputDirectory = join(temporaryRoot, "output");
await mkdir(workspaceDirectory, { recursive: true });
let extensionDevelopmentPath = resolve(
  process.env.MARKDOWN_MINT_PDF_EXTENSION_PATH ?? repository,
);

if (useVsix) {
  const packageMetadata = JSON.parse(
    await readFile(join(repository, "package.json"), "utf8"),
  );
  const vsixPath = resolve(
    process.env.MARKDOWN_MINT_PDF_VSIX ??
      join(
        repository,
        `${packageMetadata.name}-${packageMetadata.version}.vsix`,
      ),
  );
  if (!existsSync(vsixPath))
    throw new Error(`Packaged PDF test requires a VSIX: ${vsixPath}`);
  const extractionDirectory = join(temporaryRoot, "vsix");
  await mkdir(extractionDirectory, { recursive: true });
  execFileSync("unzip", ["-q", vsixPath, "-d", extractionDirectory]);
  extensionDevelopmentPath = join(extractionDirectory, "extension");
  if (!existsSync(join(extensionDevelopmentPath, "dist", "extension.js")))
    throw new Error("VSIX does not contain the production extension bundle.");
  for (
    let directory = extensionDevelopmentPath;
    ;
    directory = dirname(directory)
  ) {
    if (existsSync(join(directory, "node_modules")))
      throw new Error(
        `Packaged extension would resolve external node_modules from ${directory}.`,
      );
    if (dirname(directory) === directory) break;
  }
  process.stdout.write(
    "Testing the VSIX extension bundle with no node_modules in its resolution path.\n",
  );
}

try {
  const exitCode = await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    ...(vscodeExecutablePath ? { vscodeExecutablePath } : {}),
    extensionTestsEnv: {
      MARKDOWN_MINT_PDF_CHROMIUM: chromium.executablePath(),
      MARKDOWN_MINT_PDF_OUTPUT_DIR: outputDirectory,
      MARKDOWN_MINT_PDF_WORKSPACE_DIR: workspaceDirectory,
    },
    launchArgs: [
      `--user-data-dir=${userDataDirectory}`,
      `--extensions-dir=${extensionsDirectory}`,
      "--disable-workspace-trust",
      workspaceDirectory,
    ],
  });
  if (exitCode !== 0) process.exitCode = exitCode;
} finally {
  if (process.env.MARKDOWN_MINT_TEST_KEEP === "1")
    process.stdout.write(
      `Kept native PDF test workspace at ${temporaryRoot}\n`,
    );
  else await rm(temporaryRoot, { recursive: true, force: true });
}
