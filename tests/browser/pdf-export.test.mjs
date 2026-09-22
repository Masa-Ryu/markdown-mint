import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { chromium } from "playwright";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporaryDirectory = await mkdtemp(
  resolve(tmpdir(), "markdown-mint-pdf-export-"),
);
const outputPath = resolve(temporaryDirectory, "fixture.pdf");
const generatorPath = resolve(temporaryDirectory, "generate-pdf.cjs");
const fixturePath = resolve(repository, "tests/md/pdf-export.md");
const executablePath = chromium.executablePath();

try {
  if (!existsSync(executablePath))
    throw new Error(
      `The pinned Playwright Chromium is missing: ${executablePath}`,
    );
  await build({
    entryPoints: [resolve(repository, "tests/browser/pdf-export-entry.ts")],
    outfile: generatorPath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    sourcemap: false,
    alias: {
      vscode: resolve(repository, "tests/browser/html-export-vscode.ts"),
    },
    loader: { ".svg": "text" },
    logLevel: "silent",
  });

  const generated = spawnSync(
    process.execPath,
    [generatorPath, outputPath, fixturePath, repository, executablePath],
    { encoding: "utf8" },
  );
  if (generated.status !== 0)
    throw new Error(
      `PDF export rendering failed:\n${generated.stdout}\n${generated.stderr}`,
    );

  const pdf = await readFile(outputPath);
  assert.equal(pdf.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.ok(
    pdf.length > 10_000,
    `Expected a rendered PDF, got ${pdf.length} bytes`,
  );
  const pageCount = [...pdf.toString("latin1").matchAll(/\/Type\s*\/Page\b/g)]
    .length;
  assert.ok(
    pageCount >= 3,
    `Expected pagination across pages, got ${pageCount}`,
  );
  process.stdout.write(
    `PDF export Chromium smoke passed: ${pdf.length} bytes, ${pageCount} pages, ${executablePath}\n`,
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
