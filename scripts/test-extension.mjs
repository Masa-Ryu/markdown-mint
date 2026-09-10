import { runTests } from "@vscode/test-electron";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync as pathExists } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extensionDevelopmentPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const extensionTestsPath = resolve(
  extensionDevelopmentPath,
  "dist",
  "test-extension.js",
);
const installedCode =
  "/Applications/Visual Studio Code.app/Contents/MacOS/Electron";
const vscodeExecutablePath =
  process.env.MARKDOWN_WEAVER_CODE ??
  (pathExists(installedCode) ? installedCode : undefined);

// Keep the profile path short: Electron uses a Unix-domain IPC socket below
// user-data and macOS rejects paths longer than roughly 103 characters.
const temporaryRoot = await mkdtemp(
  join(process.env.MARKDOWN_WEAVER_TEST_TMP ?? "/private/tmp", "mw-ext-"),
);
const userDataDirectory = join(temporaryRoot, "user-data");
const extensionsDirectory = join(temporaryRoot, "extensions");
const workspaceDirectory = join(temporaryRoot, "workspace");
await mkdir(workspaceDirectory, { recursive: true });
await cp(
  resolve(extensionDevelopmentPath, "tests", "fixtures"),
  workspaceDirectory,
  {
    recursive: true,
  },
);
const testFile = join(workspaceDirectory, "acceptance.md");

try {
  const exitCode = await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    ...(vscodeExecutablePath ? { vscodeExecutablePath } : {}),
    extensionTestsEnv: {
      MARKDOWN_WEAVER_TEST_FILE: testFile,
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
  if (process.env.MARKDOWN_WEAVER_TEST_KEEP === "1")
    console.log(`Kept native test workspace at ${temporaryRoot}`);
  else await rm(temporaryRoot, { recursive: true, force: true });
}
