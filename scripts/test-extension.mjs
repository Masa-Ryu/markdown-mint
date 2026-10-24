import { runTests } from "@vscode/test-electron";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveVSCodeExecutable } from "./test-vscode.mjs";

const extensionDevelopmentPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const extensionTestsPath = resolve(
  extensionDevelopmentPath,
  "dist",
  "test-extension.js",
);
const testTemporaryParent = process.env.MARKDOWN_MINT_TEST_TMP ?? tmpdir();
await mkdir(testTemporaryParent, { recursive: true });
const temporaryRoot = await mkdtemp(join(testTemporaryParent, "mm-ext-"));
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
  const vscodeExecutablePath = await resolveVSCodeExecutable();
  const exitCode = await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    vscodeExecutablePath,
    extensionTestsEnv: {
      MARKDOWN_MINT_TEST_FILE: testFile,
      MARKDOWN_MINT_FIXTURE_DIR: resolve(
        extensionDevelopmentPath,
        "tests",
        "md",
      ),
      ...(process.env.MM_FILE_SEARCH_HOST_BENCHMARK === "1"
        ? { MM_FILE_SEARCH_HOST_BENCHMARK: "1" }
        : {}),
      ...(process.env.MM_WORKSPACE_FILE_SEARCH_ONLY === "1"
        ? { MM_WORKSPACE_FILE_SEARCH_ONLY: "1" }
        : {}),
      ...(process.env.MM_FILE_SEARCH_BENCHMARK_SAMPLES
        ? {
            MM_FILE_SEARCH_BENCHMARK_SAMPLES:
              process.env.MM_FILE_SEARCH_BENCHMARK_SAMPLES,
          }
        : {}),
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
    console.log(`Kept native test workspace at ${temporaryRoot}`);
  else await rm(temporaryRoot, { recursive: true, force: true });
}
