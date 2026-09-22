import assert from "node:assert/strict";
import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { chromium } from "playwright";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporaryDirectory = await mkdtemp(
  resolve(tmpdir(), "markdown-mint-pdf-export-"),
);
const outputPath = resolve(temporaryDirectory, "fixture.pdf");
const generatorPath = resolve(temporaryDirectory, "generate-pdf.cjs");
const pdfRendererPath = resolve(temporaryDirectory, "pdf-renderer.mjs");
const fixturePath = resolve(repository, "tests/md/pdf-export.md");
const executablePath = chromium.executablePath();
let rasterBrowser;
let server;

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
  await build({
    entryPoints: [resolve(repository, "tests/browser/pdf-renderer.ts")],
    outfile: pdfRendererPath,
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    sourcemap: false,
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
  const parsed = await getDocument({ data: new Uint8Array(pdf) }).promise;
  const pageCount = parsed.numPages;
  const textRuns = [];
  const pageSizes = [];
  for (let pageNumber = 1; pageNumber <= parsed.numPages; pageNumber += 1) {
    const page = await parsed.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    pageSizes.push({ width: viewport.width, height: viewport.height });
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (!("str" in item) || !item.str.trim()) continue;
      const x = item.transform[4];
      const y = item.transform[5];
      textRuns.push({
        pageNumber,
        text: item.str,
        x,
        y,
        right: x + item.width,
      });
    }
  }

  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        '<!doctype html><meta charset="utf-8"><script type="module" src="/pdf-renderer.mjs"></script>',
      );
      return;
    }
    const assetPath =
      pathname === "/pdf-renderer.mjs"
        ? pdfRendererPath
        : pathname === "/pdf.worker.mjs"
          ? resolve(
              repository,
              "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
            )
          : pathname === "/fixture.pdf"
            ? outputPath
            : undefined;
    if (!assetPath) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      "content-type":
        pathname === "/fixture.pdf"
          ? "application/pdf"
          : "text/javascript; charset=utf-8",
    });
    createReadStream(assetPath).pipe(response);
  });
  await new Promise((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  rasterBrowser = await chromium.launch({ headless: true });
  const rasterPage = await rasterBrowser.newPage();
  await rasterPage.goto(`http://127.0.0.1:${address.port}/`);
  await rasterPage.waitForFunction(() => Boolean(window.pdfjsLib));
  const renderedPages = await rasterPage.evaluate(async () => {
    const parsedPdf = await window.pdfjsLib.getDocument("/fixture.pdf").promise;
    const pages = [];
    for (
      let pageNumber = 1;
      pageNumber <= parsedPdf.numPages;
      pageNumber += 1
    ) {
      const page = await parsedPdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("The browser did not provide a 2D canvas.");
      await page.render({
        canvasContext: context,
        viewport,
        background: "#ffffff",
      }).promise;
      const pixels = context.getImageData(
        0,
        0,
        canvas.width,
        canvas.height,
      ).data;
      let nonWhitePixels = 0;
      for (let offset = 0; offset < pixels.length; offset += 4 * 32) {
        if (
          pixels[offset] < 242 ||
          pixels[offset + 1] < 242 ||
          pixels[offset + 2] < 242
        )
          nonWhitePixels += 1;
      }
      pages.push({
        dataUrl: canvas.toDataURL("image/png"),
        nonWhitePixels,
      });
    }
    return pages;
  });
  assert.equal(renderedPages.length, pageCount);
  for (const [index, renderedPage] of renderedPages.entries()) {
    assert.ok(
      renderedPage.nonWhitePixels > 20,
      `Page ${index + 1} rendered as blank.`,
    );
    await writeFile(
      resolve(temporaryDirectory, `page-${index + 1}.png`),
      Buffer.from(renderedPage.dataUrl.split(",")[1], "base64"),
    );
  }

  const extractedText = textRuns.map(({ text }) => text).join(" ");
  const normalizePdfText = (text) => text.replace(/[\s\u200b\u00ad]+/gu, "");
  const normalizedText = normalizePdfText(extractedText);
  const normalizedTextLowercase = normalizedText.toLowerCase();
  const normalizedPageText = Array.from({ length: pageCount }, (_, index) =>
    normalizePdfText(
      textRuns
        .filter(({ pageNumber }) => pageNumber === index + 1)
        .map(({ text }) => text)
        .join(""),
    ),
  );
  const textRows = new Map();
  for (const run of textRuns) {
    const key = `${run.pageNumber}:${run.y.toFixed(2)}`;
    const row = textRows.get(key) ?? {
      pageNumber: run.pageNumber,
      text: "",
      x: run.x,
      y: run.y,
    };
    row.text += run.text;
    row.x = Math.min(row.x, run.x);
    textRows.set(key, row);
  }
  for (const marker of [
    "PDF_LONG_LINE_TAIL_MARKER",
    "PDF_CODE_TAIL_MARKER",
    "PDF_TABLE_TAIL_MARKER",
    "こんにちは",
    "Chromium",
  ])
    assert.ok(
      normalizedText.includes(normalizePdfText(marker)),
      `PDF text is missing ${marker}.`,
    );
  assert.ok(
    pageCount >= 5,
    `Expected multi-page print layout, got ${pageCount}`,
  );
  assert.ok(
    pageSizes.every(
      ({ width, height }) =>
        Math.abs(width - 595.28) < 1 && Math.abs(height - 841.89) < 1,
    ),
    `Expected A4 portrait pages, got ${JSON.stringify(pageSizes[0])}`,
  );
  assert.ok(
    textRuns.every(({ x, right, pageNumber }) => {
      const width = pageSizes[pageNumber - 1]?.width ?? 0;
      return x >= 42 && right <= width - 42;
    }),
    "Extracted text must stay inside the 16 mm printable page margins.",
  );
  assert.ok(!normalizedTextLowercase.includes("copycode"));
  assert.ok(!normalizedTextLowercase.includes("expandcode"));

  const longLineStart = [...textRows.values()].find(({ text }) =>
    normalizePdfText(text).includes(
      normalizePdfText("04 A single source line longer than 150 characters"),
    ),
  );
  const longLineTail = [...textRows.values()].find(({ text }) =>
    normalizePdfText(text).includes("PDF_LONG_LINE_TAIL_MARKER"),
  );
  assert.ok(
    longLineStart && longLineTail,
    "The long code line must be extracted.",
  );
  assert.ok(
    longLineStart.pageNumber !== longLineTail.pageNumber ||
      Math.abs(longLineStart.y - longLineTail.y) > 2,
    "The long code line should wrap to another printed line.",
  );
  assert.ok(
    longLineStart.x >= 42 && longLineStart.x < 80,
    "Wrapped code must use the page margin without an offset line-number gutter.",
  );
  const codeTailPage = normalizedPageText.findIndex((text) =>
    text.includes("PDF_CODE_TAIL_MARKER"),
  );
  const tableTailPage = normalizedPageText.findIndex((text) =>
    text.includes("PDF_TABLE_TAIL_MARKER"),
  );
  assert.ok(
    codeTailPage > 0,
    "The multi-page code block tail must be present.",
  );
  assert.ok(tableTailPage > 0, "The multi-page table tail must be present.");

  process.stdout.write(
    `PDF browser renderer checks passed: ${pdf.length} bytes, ${pageCount} A4 pages, ${renderedPages.length} raster pages, ${executablePath}\n`,
  );
} finally {
  await rasterBrowser?.close();
  if (server) await new Promise((resolveClose) => server.close(resolveClose));
  if (process.env.MARKDOWN_MINT_PDF_TEST_KEEP === "1")
    process.stdout.write(
      `Kept PDF layout artifacts at ${temporaryDirectory}\n`,
    );
  else await rm(temporaryDirectory, { recursive: true, force: true });
}
