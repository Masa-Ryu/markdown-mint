import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";

// Use the real bundled webview and its CSS, not a product mock-up.
// The existing browser harness supplies only the VS Code host transport.
const root = process.cwd();
const tools = process.env.MM_CAPTURE_TOOLS;
assert(
  tools,
  "MM_CAPTURE_TOOLS must point to a directory with Playwright installed",
);
const requireTools = createRequire(join(resolve(tools), "package.json"));
const { chromium } = requireTools("playwright");
const output = resolve(root, "images/readme");
const scratch = resolve(root, "output/readme-capture");
await mkdir(output, { recursive: true });
await mkdir(scratch, { recursive: true });
const server = spawn(process.execPath, ["tests/browser/server.mjs"], {
  cwd: root,
  env: { ...process.env, MM_BROWSER_PORT: "4173" },
  stdio: "inherit",
});
const origin = "http://127.0.0.1:4173";
let browser;
let activePage;
const errors = [];
const report = {
  sourceCommit: process.env.GITHUB_SHA,
  capture:
    "production webview in browser harness; asynchronous simulated host transport",
  actions: [],
  errors,
};
const theme = {
  "editor.background": "#1f1f1f",
  "editor.foreground": "#cccccc",
  foreground: "#cccccc",
  "editorWidget.background": "#252526",
  "editorWidget.foreground": "#cccccc",
  "dropdown.background": "#313131",
  "dropdown.foreground": "#cccccc",
  "dropdown.border": "#3c3c3c",
  "input.background": "#313131",
  "input.foreground": "#cccccc",
  "input.border": "#3c3c3c",
  "panel.border": "#2b2b2b",
  "widget.border": "#454545",
  focusBorder: "#0078d4",
  "button.background": "#0078d4",
  "button.foreground": "#ffffff",
  "button.hoverBackground": "#026ec1",
  descriptionForeground: "#9d9d9d",
  "textLink.foreground": "#4daafc",
  "editor.selectionBackground": "#264f78",
  "editor.findMatchHighlightBackground": "#ea5c0055",
};
const overview = `# Plan your next release\n\n**Write visually.** Keep the checklists, tables, and notes in your Markdown.\n\n## From plan to progress\n\n| Feature | Status | Owner | Target |\n| :--- | :---: | :--- | ---: |\n| Visual editing | Ready | Alice | Today |\n| Table controls | In review | Sam | Tomorrow |\n| Release notes | Draft | Morgan | Friday |\n\n## Before you ship\n\n- [x] Review the changes\n- [ ] Share the release notes\n\n> [!TIP]\n> Select table cells, copy them, and paste where you need them.\n`;
const tableFixture = `# Copy cells, not pipe characters\n\nDrag a rectangle. Copy. Click a destination. Paste.\n\n| Feature | Status | Owner | Target |\n| --- | --- | --- | --- |\n| Visual editing | Ready | Alice | Today |\n| Table controls | In review | Sam | Tomorrow |\n| Release notes | Draft | Morgan | Friday |\n|  |  |  |  |\n|  |  |  |  |\n\nThe file stays Markdown.\n`;
const diagrams = `# Explain more than text\n\nKeep diagrams, equations, and notes beside your documentation.\n\n## From idea to release\n\n\`\`\`mermaid\nflowchart LR\n    A[Draft] --> B[Review]\n    B --> C[Ship]\n\`\`\`\n\n## Keep the calculation close\n\n$$\n\\mathrm{Progress} = \\frac{\\mathrm{completed}}{\\mathrm{planned}} \\times 100\\%\n$$\n\n> [!NOTE]\n> Add diagrams and equations without leaving your document.\n`;
async function load(page, markdown) {
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.waitForFunction(
    () =>
      window.__markdownMintHarness &&
      document.querySelector('.ProseMirror[contenteditable="true"]'),
  );
  await page.evaluate(
    ({ theme, markdown }) => {
      document.body.classList.add("vscode-dark");
      for (const [name, value] of Object.entries(theme))
        document.documentElement.style.setProperty(
          `--vscode-${name.replaceAll(".", "-")}`,
          value,
        );
      // The real host is asynchronous. Avoid re-entrant acknowledgements in the
      // synchronous test double without changing any production editor code.
      const host = window.acquireVsCodeApi();
      const post = host.postMessage.bind(host);
      host.postMessage = (message) => queueMicrotask(() => post(message));
      window.__markdownMintHarness.deliverExternal(markdown);
    },
    { theme, markdown },
  );
  await page.waitForFunction(
    (text) => window.__markdownMintHarness.document.markdown === text,
    markdown,
  );
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(650);
  await page.mouse.move(4, 4);
}
async function shot(page, filename) {
  await page.screenshot({
    path: join(output, filename),
    animations: "disabled",
  });
}
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(origin)).ok) break;
    } catch {}
    if (i === 99) throw new Error("Browser harness did not start");
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1180, height: 760 },
    deviceScaleFactor: 1,
    colorScheme: "dark",
    permissions: ["clipboard-read", "clipboard-write"],
  });
  await context.route("**/*", (route) =>
    route.request().url().startsWith(origin) ||
    route.request().url().startsWith("data:")
      ? route.continue()
      : route.abort(),
  );
  const page = (activePage = await context.newPage());
  page.on("pageerror", (error) => errors.push(error.message));
  await load(page, overview);
  await shot(page, "editor.png");
  report.actions.push(
    "Captured the real editing surface using a non-sensitive sample document",
  );
  await load(page, diagrams);
  await page.waitForTimeout(4000);
  await shot(page, "diagrams.png");
  report.actions.push(
    "Captured Mermaid, math and a note using the bundled renderers",
  );
  await page.setViewportSize({ width: 1080, height: 650 });
  await load(page, tableFixture);
  const frames = [];
  async function frame(duration) {
    const name = `frame-${frames.length}.png`;
    await page.screenshot({
      path: join(scratch, name),
      animations: "disabled",
    });
    frames.push({ name, duration });
  }
  const rows = page.locator(".ProseMirror table tr");
  // Activating a table reveals its contextual controls and changes the layout.
  // Let that happen before measuring the cells used for the drag gesture.
  await rows.nth(1).locator("th,td").nth(0).click();
  await page.waitForTimeout(300);
  await page.mouse.move(4, 4);
  await frame(1.3);
  const start = await rows.nth(1).locator("th,td").nth(0).boundingBox();
  const end = await rows.nth(2).locator("th,td").nth(2).boundingBox();
  assert(start && end, "Expected source table cells");
  await page.mouse.move(start.x + 10, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, {
    steps: 18,
  });
  await page.mouse.up();
  await page.waitForFunction(
    () => document.querySelectorAll(".ProseMirror .selectedCell").length === 6,
  );
  assert.deepEqual(
    await page.locator(".ProseMirror .selectedCell").allTextContents(),
    ["Visual editing", "Ready", "Alice", "Table controls", "In review", "Sam"],
  );
  await page.mouse.move(4, 4);
  await frame(1.6);
  await page.keyboard.press("Control+c");
  await page.waitForTimeout(350);
  await rows.nth(4).locator("th,td").nth(0).click();
  await page.mouse.move(4, 4);
  await frame(0.9);
  await page.keyboard.press("Control+v");
  await page.waitForFunction(() => {
    const rows = document.querySelectorAll(".ProseMirror table tr");
    return (
      rows[4]?.textContent.includes("Visual editing") &&
      rows[5]?.textContent.includes("Table controls")
    );
  });
  await page.waitForTimeout(300);
  const result = await page.evaluate(
    () => window.__markdownMintHarness.document.markdown,
  );
  assert.equal((result.match(/Visual editing/g) || []).length, 2);
  assert.equal((result.match(/Table controls/g) || []).length, 2);
  await frame(2.0);
  await shot(page, "table-paste.png");
  await page.keyboard.press("Control+z");
  await page.waitForFunction(
    (text) => window.__markdownMintHarness.document.markdown === text,
    tableFixture,
  );
  await page.waitForTimeout(300);
  await frame(1.2);
  report.actions.push(
    "Real mouse drag selected the expected 2 x 3 cells; real Ctrl+C/Ctrl+V pasted the matrix; one Ctrl+Z restored the source",
  );
  assert.equal(errors.length, 0, "Capture encountered a JavaScript page error");
  await writeFile(
    join(scratch, "frames.txt"),
    frames
      .map(({ name, duration }) => `file '${name}'\nduration ${duration}\n`)
      .join("") + `file '${frames.at(-1).name}'\n`,
  );
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      join(scratch, "frames.txt"),
      "-filter_complex",
      "[0:v]fps=8,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3",
      "-loop",
      "0",
      join(output, "table-demo.gif"),
    ],
    { stdio: "inherit" },
  );
  await writeFile(join(scratch, "after-paste.md"), result);
} catch (error) {
  report.failure = error.stack || String(error);
  if (activePage) {
    await activePage
      .screenshot({ path: join(scratch, "failure.png") })
      .catch(() => {});
    await writeFile(
      join(scratch, "failure.html"),
      await activePage.content().catch(() => ""),
    );
  }
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(
    join(scratch, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  if (browser) await browser.close();
  server.kill("SIGTERM");
}
