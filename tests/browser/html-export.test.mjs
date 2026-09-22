import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { chromium } from "playwright";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporaryDirectory = await mkdtemp(
  resolve(tmpdir(), "markdown-mint-html-export-"),
);
const outputPath = resolve(temporaryDirectory, "standalone.html");
const documentPath = resolve(temporaryDirectory, "guide.md");
const imagePath = resolve(temporaryDirectory, "pixel.png");
const generatorPath = resolve(temporaryDirectory, "generate-export.mjs");
let browser;

try {
  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lF8AAAAASUVORK5CYII=",
    "base64",
  );
  await writeFile(imagePath, pixel);
  await writeFile(documentPath, "");

  await build({
    entryPoints: [resolve(repository, "tests/browser/html-export-entry.ts")],
    outfile: generatorPath,
    bundle: true,
    platform: "node",
    format: "esm",
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
    [generatorPath, outputPath, documentPath, imagePath, repository],
    { encoding: "utf8" },
  );
  if (generated.status !== 0)
    throw new Error(
      `Standalone HTML generation failed:\n${generated.stdout}\n${generated.stderr}`,
    );
  const html = await readFile(outputPath, "utf8");
  assert.match(html, /data:image\/png;base64,/);
  assert.match(html, /script-src 'sha256-[^']+'/);
  assert.doesNotMatch(html, /vscode-webview:|vscode-resource:/i);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ colorScheme: "dark" });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.__markdownMintCspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__markdownMintCspViolations.push({
        directive: event.violatedDirective,
        blockedURI: event.blockedURI,
      });
    });
  });

  await page.goto(pathToFileURL(outputPath).href, { waitUntil: "load" });
  await page.waitForFunction(
    () => {
      const diagram = document.querySelector(".mm-mermaid");
      return (
        diagram?.dataset.mmMermaidState === "rendered" &&
        Boolean(diagram.querySelector("svg"))
      );
    },
    null,
    { timeout: 20_000 },
  );
  await page.waitForFunction(
    () =>
      document.images.length === 2 &&
      [...document.images].every(
        (image) => image.complete && image.naturalWidth > 0,
      ),
    null,
    { timeout: 5_000 },
  );
  await page.evaluate(() => document.fonts.ready);

  const result = await page.evaluate(() => {
    const svg = document.querySelector(".mm-mermaid svg");
    const nodeSurface = svg?.querySelector(
      ".node rect, .node circle, .node ellipse, .node polygon",
    );
    const nodeText = svg?.querySelector(".nodeLabel, .node text");
    const edgeLabelBackground = svg?.querySelector(
      ".edgeLabel rect, .edgeLabel .labelBkg",
    );
    const taskBoxes = Array.from(
      document.querySelectorAll(".task-list-item > input[type=checkbox]"),
    ).map((checkbox) => ({
      text: checkbox.parentElement?.textContent?.trim(),
      checked: checkbox.checked,
      taskState: checkbox.dataset.taskState ?? "",
      ariaChecked: checkbox.getAttribute("aria-checked"),
      backgroundColor: getComputedStyle(checkbox).backgroundColor,
      backgroundImage: getComputedStyle(checkbox).backgroundImage,
      opacity: getComputedStyle(checkbox).opacity,
    }));
    const images = Array.from(document.images).map((image) => ({
      alt: image.alt,
      source: image.getAttribute("src"),
      width: image.naturalWidth,
      height: image.naturalHeight,
    }));
    const svgStyle = svg ? getComputedStyle(svg) : undefined;
    return {
      lightClass:
        document.documentElement.classList.contains("vscode-light") &&
        document.body.classList.contains("vscode-light"),
      background: getComputedStyle(document.documentElement)
        .getPropertyValue("--vscode-background")
        .trim(),
      editorBackground: getComputedStyle(document.documentElement)
        .getPropertyValue("--vscode-editor-background")
        .trim(),
      mermaidTheme: {
        background: svgStyle
          ?.getPropertyValue("--mm-mermaid-background")
          .trim(),
        foreground: svgStyle
          ?.getPropertyValue("--mm-mermaid-foreground")
          .trim(),
        surface: svgStyle?.getPropertyValue("--mm-mermaid-surface").trim(),
        nodeSurface: nodeSurface
          ? getComputedStyle(nodeSurface).fill
          : undefined,
        foregroundText: nodeText
          ? getComputedStyle(nodeText).color || getComputedStyle(nodeText).fill
          : undefined,
        edgeLabelBackground: edgeLabelBackground
          ? getComputedStyle(edgeLabelBackground).fill
          : undefined,
      },
      taskBoxes,
      images,
      math: {
        count: document.querySelectorAll(".katex").length,
        mainFontLoaded: document.fonts.check("16px KaTeX_Main"),
      },
      mermaidState:
        document.querySelector(".mm-mermaid")?.dataset.mmMermaidState,
      injectedMarkdownScript: window.__markdownMintInjected === true,
      cspViolations: window.__markdownMintCspViolations,
    };
  });

  assert.equal(result.lightClass, true);
  assert.equal(result.background, "#ffffff");
  assert.equal(result.editorBackground, "#ffffff");
  assert.deepEqual(result.mermaidTheme, {
    background: "#ffffff",
    foreground: "#1f2328",
    surface: "#f6f8fa",
    nodeSurface: "rgb(246, 248, 250)",
    foregroundText: "rgb(31, 35, 40)",
    edgeLabelBackground: "rgb(255, 255, 255)",
  });
  assert.equal(result.mermaidState, "rendered");
  assert.ok(result.math.count >= 2);
  assert.equal(result.math.mainFontLoaded, true);
  assert.equal(result.injectedMarkdownScript, false);
  assert.deepEqual(result.cspViolations, []);
  assert.deepEqual(
    result.images.map(({ alt, width, height }) => ({ alt, width, height })),
    [
      { alt: "Local image", width: 1, height: 1 },
      { alt: "Data image", width: 1, height: 1 },
    ],
  );
  assert.ok(
    result.images.every(({ source }) =>
      source?.startsWith("data:image/png;base64,"),
    ),
  );
  assert.equal(result.taskBoxes.length, 3);
  assert.match(result.taskBoxes[0].text, /Todo/);
  assert.equal(result.taskBoxes[0].checked, false);
  assert.equal(result.taskBoxes[0].backgroundImage, "none");
  assert.match(result.taskBoxes[1].text, /Done/);
  assert.equal(result.taskBoxes[1].checked, true);
  assert.match(result.taskBoxes[1].backgroundImage, /data:image\/svg\+xml/);
  assert.match(result.taskBoxes[2].text, /In progress/);
  assert.equal(result.taskBoxes[2].taskState, "mixed");
  assert.equal(result.taskBoxes[2].ariaChecked, "mixed");
  assert.match(result.taskBoxes[2].backgroundImage, /linear-gradient/);
  assert.ok(result.taskBoxes.every((checkbox) => checkbox.opacity === "1"));
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(pageErrors, []);

  process.stdout.write(
    `Standalone HTML export Chromium smoke passed: ${JSON.stringify({
      mermaid: result.mermaidState,
      theme: result.mermaidTheme,
      images: result.images.length,
      taskStates: result.taskBoxes.map(({ taskState, checked }) => ({
        taskState,
        checked,
      })),
      cspViolations: result.cspViolations.length,
    })}\n`,
  );
  await context.close();
} finally {
  await browser?.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
}
