import { runTests } from "@vscode/test-electron";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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
const testFile = join(workspaceDirectory, "acceptance.md");

try {
  await mkdir(workspaceDirectory, { recursive: true });
  await cp(
    resolve(extensionDevelopmentPath, "tests", "fixtures"),
    workspaceDirectory,
    { recursive: true },
  );
  const vscodeExecutablePath = await resolveVSCodeExecutable();
  const testApplication =
    process.platform === "darwin"
      ? vscodeExecutablePath.match(/^(.*\.app)\/Contents\/MacOS\/[^/]+$/u)?.[1]
      : undefined;
  console.log(`Extension Host platform: ${process.platform} ${process.arch}`);
  console.log(`Extension Host temporary workspace: ${temporaryRoot}`);
  const exitCode = await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    vscodeExecutablePath,
    extensionTestsEnv: {
      MARKDOWN_MINT_TEST_FILE: testFile,
      ...(testApplication && process.env.CI === "true"
        ? {
            MARKDOWN_MINT_TEST_APP: testApplication,
          }
        : {}),
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
      `--logsPath=${join(userDataDirectory, "logs")}`,
      "--disable-workspace-trust",
      workspaceDirectory,
    ],
  });
  if (exitCode !== 0) process.exitCode = exitCode;
} finally {
  try {
    const logDirectory = join(
      extensionDevelopmentPath,
      "output",
      "extension-host",
      basename(temporaryRoot),
    );
    await cp(join(userDataDirectory, "logs"), logDirectory, {
      recursive: true,
    }).catch((error) => {
      // A download or launch failure can occur before VS Code creates logs.
      if (error.code !== "ENOENT") throw error;
    });
  } finally {
    if (process.env.MARKDOWN_MINT_TEST_KEEP === "1")
      console.log(`Kept native test workspace at ${temporaryRoot}`);
    else
      await rm(temporaryRoot, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
  }
}
