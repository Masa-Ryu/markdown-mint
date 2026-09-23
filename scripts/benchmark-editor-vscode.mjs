import { execFileSync, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv.includes("--current")
  ? "current"
  : "threshold-sticky";
const launch = process.argv.includes("--launch");
const fixture = resolve(
  repository,
  "tests/github-markdown-test-suite/stress/github-table-2000x20.md",
);

execFileSync("node", ["scripts/build.mjs"], {
  cwd: repository,
  stdio: "inherit",
});

if (mode === "threshold-sticky") {
  await mkdir(resolve(repository, "dist"), { recursive: true });
  await build({
    entryPoints: ["src/webview/main.ts"],
    bundle: true,
    outfile: resolve(repository, "dist/webview.js"),
    platform: "browser",
    format: "iife",
    target: "es2022",
    minify: false,
    sourcemap: true,
    keepNames: true,
    legalComments: "none",
    loader: { ".svg": "text" },
    define: { __MM_EDITOR_PERFORMANCE_BENCHMARK__: "true" },
  });
}

process.stdout.write(
  [
    `Built VS Code benchmark bundle: ${mode}`,
    mode === "threshold-sticky"
      ? "Large tables use totalCells >= 10000 plus one instance-local overflow probe, ON/OFF hysteresis 10000/7500, and sticky proxy scrolling."
      : "Current product bundle restored; no benchmark proxy is enabled.",
    `Fixture: ${fixture}`,
    "Open the file with Markdown Mint using Reopen With → Markdown Mint.",
  ].join("\n") + "\n",
);

if (launch) {
  const code = process.env.VSCODE_CLI ?? "code";
  const child = spawn(
    code,
    ["--extensionDevelopmentPath=" + repository, "--new-window", fixture],
    { cwd: repository, stdio: "inherit" },
  );
  child.on("exit", (exitCode, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = exitCode ?? 0;
  });
}
