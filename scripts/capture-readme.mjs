import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";

// Capture the shipped webview, not a mock-up of the product. Only the host
// transport is simulated by the repository's existing browser harness.
const root = process.cwd();
const tools = process.env.MM_CAPTURE_TOOLS;
assert(tools, "MM_CAPTURE_TOOLS must point to a directory with Playwright installed");
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
const report = { sourceCommit: process.env.GITHUB_SHA, capture: "production webview in browser harness", actions: [], errors };
const theme = {
  "editor.background": "#1f1f1f", "editor.foreground": "#cccccc",
  "foreground": "#cccccc", "editorWidget.background": "#252526",
  "editorWidget.foreground": "#cccccc", "dropdown.background": "#313131",
  "dropdown.foreground": "#cccccc", "dropdown.border": "#3c3c3c",
  "input.background": "#313131", "input.foreground": "#cccccc",
  "input.border": "#3c3c3c", "panel.border": "#2b2b2b",
  "widget.border": "#454545", "focusBorder": "#0078d4",
  "button.background": "#0078d4", "button.foreground": "#ffffff",
  "button.hoverBackground": "#026ec1", "descriptionForeground": "#9d9d9d",
  "textLink.foreground": "#4daafc", "editor.selectionBackground": "#264f78",
  "editor.findMatchHighlightBackground": "#ea5c0055"
};
const overview = `# Project launch\n\nA launch plan worth reading. **Write visually**, keep your Markdown.\n\n## Release checklist\n\n- [x] Finish the first working version\n- [x] Review the documentation\n- [ ] Share it with the team\n\n## Who is working on what?\n\n| Feature | Status | Owner | Target |\n| :--- | :---: | :--- | ---: |\n| Visual editing | Ready | Alice | Today |\n| Table controls | In review | Sam | Tomorrow |\n| Release notes | Draft | Morgan | Friday |\n\n> [!TIP]\n> Select table cells, copy them, and paste where you need them.\n\n## A little code, too\n\n\`\`\`typescript\nconst release = { name: "Markdown Mint", ready: true };\nconsole.log(release.name);\n\`\`\`\n`;
const tableFixture = `# Copy cells, not pipe characters\n\nDrag a rectangle. Copy. Click a destination. Paste.\n\n| Feature | Status | Owner | Target |\n| --- | --- | --- | --- |\n| Visual editing | Ready | Alice | Today |\n| Table controls | In review | Sam | Tomorrow |\n| Release notes | Draft | Morgan | Friday |\n|  |  |  |  |\n|  |  |  |  |\n\nThe file stays Markdown.\n`;
const diagrams = `# Explain more than text\n\nKeep diagrams, equations, and notes beside your documentation.\n\n## From idea to release\n\n\`\`\`mermaid\nflowchart LR\n    A[Draft] --> B[Review]\n    B --> C{Ready?}\n    C -->|Yes| D[Ship]\n    C -->|Not yet| A\n\`\`\`\n\n## Keep the calculation close\n\n$$\n\\mathrm{Progress} = \\frac{\\mathrm{completed}}{\\mathrm{planned}} \\times 100\\%\n$$\n\n> [!NOTE]\n> GitHub and GitLab profiles make the relevant insertion controls available.\n`;
async function load(page, markdown) {
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__markdownMintHarness && document.querySelector('.ProseMirror[contenteditable="true"]'));
  await page.evaluate(({ theme, markdown }) => {
    document.body.classList.add("vscode-dark");
    for (const [name, value] of Object.entries(theme))
      document.documentElement.style.setProperty(`--vscode-${name.replaceAll(".", "-")}`, value);
    window.__markdownMintHarness.deliverExternal(markdown);
  }, { theme, markdown });
  await page.waitForFunction(text => window.__markdownMintHarness.document.markdown === text, markdown);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(650);
  await page.mouse.move(4, 4);
}
async function shot(page, filename) {
  await page.screenshot({ path: join(output, filename), animations: "disabled" });
}
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(origin)).ok) break; } catch {}
    if (i === 99) throw new Error("Browser harness did not start");
    await new Promise(r => setTimeout(r, 100));
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 880 }, deviceScaleFactor: 1, colorScheme: "dark", permissions: ["clipboard-read", "clipboard-write"] });
  await context.route("**/*", route => route.request().url().startsWith(origin) || route.request().url().startsWith("data:") ? route.continue() : route.abort());
  const page = activePage = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await load(page, overview);
  await shot(page, "editor.png");
  report.actions.push("Captured the real editing surface using a non-sensitive sample document");
  await load(page, diagrams);
  await page.waitForTimeout(4000);
  await shot(page, "diagrams.png");
  report.actions.push("Captured Mermaid, math and a note using the bundled renderers");
  await page.setViewportSize({ width: 1080, height: 650 });
  await load(page, tableFixture);
  const frames = [];
  async function frame(duration) {
    const name = `frame-${frames.length}.png`;
    await page.screenshot({ path: join(scratch, name), animations: "disabled" });
    frames.push({ name, duration });
  }
  await frame(1.3);
  const rows = page.locator(".ProseMirror table tr");
  const start = await rows.nth(1).locator("th,td").nth(0).boundingBox();
  const end = await rows.nth(2).locator("th,td").nth(2).boundingBox();
  assert(start && end, "Expected source table cells");
  await page.mouse.move(start.x + 10, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 18 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelectorAll(".ProseMirror .selectedCell").length === 6);
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
    return rows[4]?.textContent.includes("Visual editing") && rows[5]?.textContent.includes("Table controls");
  });
  const result = await page.evaluate(() => window.__markdownMintHarness.document.markdown);
  assert.equal((result.match(/Visual editing/g) || []).length, 2);
  assert.equal((result.match(/Table controls/g) || []).length, 2);
  await frame(2.0);
  await shot(page, "table-paste.png");
  await page.keyboard.press("Control+z");
  await page.waitForFunction(text => window.__markdownMintHarness.document.markdown === text, tableFixture);
  await frame(1.2);
  report.actions.push("Real mouse drag selected 2 x 3 cells; real Ctrl+C/Ctrl+V pasted the matrix; one Ctrl+Z restored the source");
  await writeFile(join(scratch, "frames.txt"), frames.map(({ name, duration }) => `file '${name}'\nduration ${duration}\n`).join("") + `file '${frames.at(-1).name}'\n`);
  execFileSync("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", join(scratch, "frames.txt"), "-filter_complex", "[0:v]fps=8,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3", "-loop", "0", join(output, "table-demo.gif")], { stdio: "inherit" });
  await writeFile(join(scratch, "after-paste.md"), result);
} catch (error) {
  report.failure = error.stack || String(error);
  if (activePage) {
    await activePage.screenshot({ path: join(scratch, "failure.png") }).catch(() => {});
    await writeFile(join(scratch, "failure.html"), await activePage.content().catch(() => ""));
  }
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(join(scratch, "report.json"), JSON.stringify(report, null, 2) + "\n");
  if (browser) await browser.close();
  server.kill("SIGTERM");
}
