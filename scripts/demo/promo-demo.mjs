import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import {
  checkFfmpegPrerequisites,
  inspectRecordingMarkers,
  renderPromoMedia,
} from "./promo-media.mjs";
import {
  assertExpectedSource,
  parsePromoArgs,
  publishValidatedFiles,
  readExpectedMarkdown,
  runProcess,
  sha256,
} from "./promo-utils.mjs";

const repository = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const serverPath = resolve(repository, "tests/browser/server.mjs");
const paths = {
  outputDir: resolve(repository, "output/demo"),
  overviewGif: resolve(repository, "docs/media/overview.gif"),
  initialMarkdown: resolve(repository, "docs/demo/promo-initial.md"),
  tableTsv: resolve(repository, "docs/demo/promo-table.tsv"),
  expectedMarkdown: resolve(repository, "docs/demo/promo-expected.json"),
};

const timing = Object.freeze({
  introHoldMs: 2100,
  tableHoldMs: 2400,
  reorderedTableHoldMs: 2400,
  slashMenuHoldMs: 650,
  alertHoldMs: 2300,
  sourceHoldMs: 4300,
  markerHoldMs: 360,
});

const theme = Object.freeze({
  "--vscode-editor-background": "#ffffff",
  "--vscode-foreground": "#1f2328",
  "--vscode-editor-foreground": "#1f2328",
  "--vscode-descriptionForeground": "#59636e",
  "--vscode-widget-border": "rgba(31, 35, 40, 0.25)",
  "--vscode-focusBorder": "#0969da",
});

const markerColors = Object.freeze({
  "clip-start": "rgb(240, 0, 240)",
  "source-start": "rgb(240, 240, 0)",
  "source-end": "rgb(0, 240, 0)",
  "clip-end": "rgb(0, 240, 240)",
});

const wait = (milliseconds) =>
  new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

function helpText() {
  return [
    "Usage: npm run demo:promo [-- --headed] [--port PORT]",
    "Run the browser promo scenario, validate it, render media, and update docs/media/overview.gif.",
    "Use npm run demo:promo:render to re-render a previously validated recording.",
  ].join("\n");
}

async function checkNodeAndNpm() {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(major) || major < 18)
    throw new Error(
      `Promo demo requires Node.js 18 or newer; found ${process.version}.`,
    );
  const npm = await runProcess("npm", ["--version"], { cwd: repository });
  return { node: process.version, npm: npm.stdout.toString("utf8").trim() };
}

async function checkPlaywrightChromium() {
  const executable = chromium.executablePath();
  try {
    await access(executable, fsConstants.X_OK);
  } catch {
    throw new Error(
      `Playwright Chromium is missing at ${executable}. Install it with "npx playwright install chromium" before running the demo.`,
    );
  }
  const browser = await chromium.launch({ headless: true });
  await browser.close();
  return executable;
}

async function findMarkdownCss() {
  const candidates = [
    process.env.VSCODE_MARKDOWN_CSS,
    "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/markdown-language-features/media/markdown.css",
    "/usr/share/code/resources/app/extensions/markdown-language-features/media/markdown.css",
    "/usr/lib/code/resources/app/extensions/markdown-language-features/media/markdown.css",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.R_OK);
      return { path: candidate, fallback: false };
    } catch {
      // Try the next known VS Code install location.
    }
  }
  return {
    path: resolve(repository, "tests/browser/native-theme.css"),
    fallback: true,
  };
}

async function checkPrerequisites() {
  const [runtime, ffmpeg, chromiumExecutable, markdownCss] = await Promise.all([
    checkNodeAndNpm(),
    checkFfmpegPrerequisites(
      process.env.MM_FFMPEG ?? "ffmpeg",
      process.env.MM_FFPROBE ?? "ffprobe",
      repository,
    ),
    checkPlaywrightChromium(),
    findMarkdownCss(),
  ]);
  return { runtime, ffmpeg, chromiumExecutable, markdownCss };
}

async function buildWebview() {
  process.stdout.write("Building the real Markdown Mint webview...\n");
  const result = await runProcess("npm", ["run", "build:webview"], {
    cwd: repository,
    timeoutMs: 120_000,
    maxOutputBytes: 16 * 1024 * 1024,
  });
  process.stdout.write(result.stdout.toString("utf8"));
  process.stdout.write(result.stderr);
}

function startServer(port, markdownCssPath) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: repository,
    env: {
      ...process.env,
      MM_BROWSER_PORT: String(port),
      VSCODE_MARKDOWN_CSS: markdownCssPath,
    },
    stdio: "inherit",
    windowsHide: true,
  });
  let spawnError = null;
  child.once("error", (error) => {
    spawnError = error;
  });
  const exited = new Promise((resolveExit) => {
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });
  return {
    child,
    exited,
    get spawnError() {
      return spawnError;
    },
  };
}

async function waitForServer(server, url) {
  const deadline = Date.now() + 20_000;
  let lastError;
  while (Date.now() < deadline) {
    if (server.spawnError)
      throw new Error(
        `Could not start the browser harness: ${server.spawnError.message}`,
      );
    if (server.child.exitCode !== null || server.child.signalCode !== null) {
      const result = await server.exited;
      throw new Error(
        `Browser harness exited before becoming ready (${result.signal ?? result.code}).`,
      );
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }
  throw new Error(`Browser harness did not become ready: ${lastError ?? url}`);
}

async function stopServer(server) {
  if (
    !server ||
    server.child.exitCode !== null ||
    server.child.signalCode !== null
  )
    return;
  server.child.kill("SIGINT");
  const result = await Promise.race([
    server.exited,
    wait(2000).then(() => null),
  ]);
  if (result !== null) return;
  server.child.kill("SIGTERM");
  const terminated = await Promise.race([
    server.exited,
    wait(2000).then(() => null),
  ]);
  if (terminated !== null) return;
  server.child.kill("SIGKILL");
  await server.exited;
}

async function assertPortAvailable(port) {
  const probe = createServer();
  await new Promise((resolveBind, rejectBind) => {
    probe.once("error", (error) => rejectBind(error));
    probe.listen(port, "127.0.0.1", () => resolveBind());
  }).catch((error) => {
    if (error.code === "EADDRINUSE")
      throw new Error(`Promo demo port ${port} is already in use.`);
    throw new Error(
      `Could not check local promo demo port ${port}: ${error.message}`,
    );
  });
  await new Promise((resolveClose, rejectClose) =>
    probe.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
}

async function waitForRich(page) {
  await page.waitForFunction(
    () =>
      document.body.dataset.markdownMintMode === "editor" &&
      Boolean(window.markdownMint?.view),
  );
  await page
    .locator(".mm-rich-panel .ProseMirror")
    .waitFor({ state: "visible" });
}

async function prepareDemo(page, initialMarkdown, baseUrl) {
  await page.addInitScript(() => {
    Object.defineProperty(window, "acquireVsCodeApi", {
      configurable: true,
      get: () => undefined,
      set: () => {},
    });
  });
  await page.goto(`${baseUrl}/?profile=github`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(() => Boolean(window.markdownMint?.view));
  await page
    .locator(".mm-rich-panel .ProseMirror")
    .waitFor({ state: "attached" });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.evaluate((variables) => {
    for (const [name, value] of Object.entries(variables))
      document.documentElement.style.setProperty(name, value);
    document.body.style.backgroundColor =
      variables["--vscode-editor-background"];
    document.body.style.color = variables["--vscode-foreground"];
  }, theme);
  await page.evaluate((markdown) => {
    window.__markdownMintHarness.deliverExternal(markdown, "github");
  }, initialMarkdown);
  await page.waitForFunction(
    (markdown) =>
      window.__markdownMintHarness.document.markdown === markdown &&
      window.markdownMint.sourceEl.value === markdown,
    initialMarkdown,
  );
  await waitForRich(page);
  await page.waitForFunction(() => document.fonts.status === "loaded");
  const editor = page.locator(".mm-rich-panel .ProseMirror");
  const profile = page.locator(".mm-profile-select");
  await page.waitForFunction(
    () => document.querySelector(".mm-profile-select")?.value === "github",
  );
  await editor
    .locator("h1")
    .filter({ hasText: "Project Status" })
    .waitFor({ state: "visible" });
  await focusTailParagraph(page);
  await installPointerIndicator(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await assert.equal(await profile.inputValue(), "github");
}

async function focusTailParagraph(page) {
  const editor = page.locator(".mm-rich-panel .ProseMirror");
  const lastParagraph = editor.locator(":scope > p").last();
  if ((await lastParagraph.count()) === 0)
    throw new Error(
      "Initial promo document has no paragraph for the TSV paste.",
    );
  await lastParagraph.click();
  await page.keyboard.press("End");
}

async function installPointerIndicator(page) {
  await page.evaluate(() => {
    const pointer = document.createElement("div");
    pointer.setAttribute("aria-hidden", "true");
    Object.assign(pointer.style, {
      position: "fixed",
      zIndex: "2147483646",
      boxSizing: "border-box",
      width: "16px",
      height: "16px",
      margin: "-8px 0 0 -8px",
      border: "2px solid #fff",
      borderRadius: "50%",
      background: "rgba(9, 105, 218, .45)",
      boxShadow: "0 0 0 2px #0969da, 0 2px 5px rgba(0, 0, 0, .45)",
      pointerEvents: "none",
      opacity: "0",
      transition: "opacity 80ms linear, transform 80ms linear",
    });
    document.body.append(pointer);
    document.addEventListener("pointermove", (event) => {
      pointer.style.left = `${event.clientX}px`;
      pointer.style.top = `${event.clientY}px`;
      pointer.style.opacity = "1";
    });
    document.addEventListener("pointerdown", () => {
      pointer.style.transform = "scale(.78)";
      pointer.style.background = "rgba(9, 105, 218, .8)";
    });
    document.addEventListener("pointerup", () => {
      pointer.style.transform = "scale(1)";
      pointer.style.background = "rgba(9, 105, 218, .45)";
    });
  });
}

async function showMarker(page, kind) {
  await page.evaluate(
    ({ markerKind, color }) => {
      document.querySelector("[data-mm-promo-boundary]")?.remove();
      const marker = document.createElement("div");
      marker.dataset.mmPromoBoundary = markerKind;
      marker.setAttribute("aria-hidden", "true");
      marker.style.cssText = `position:fixed;inset:0;z-index:2147483647;pointer-events:none;background:${color};`;
      document.documentElement.append(marker);
    },
    { markerKind: kind, color: markerColors[kind] },
  );
  await page.evaluate(
    () =>
      new Promise((resolvePaint) =>
        requestAnimationFrame(() => requestAnimationFrame(resolvePaint)),
      ),
  );
  await page.waitForTimeout(timing.markerHoldMs);
  await page.evaluate(() =>
    document.querySelector("[data-mm-promo-boundary]")?.remove(),
  );
  await page.evaluate(
    () =>
      new Promise((resolvePaint) =>
        requestAnimationFrame(() => requestAnimationFrame(resolvePaint)),
      ),
  );
}

async function pasteFixedTsv(page, tsv) {
  const editor = page.locator(".mm-rich-panel .ProseMirror");
  await editor.evaluate((element, fixedTsv) => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", fixedTsv);
    const event = new ClipboardEvent("paste", {
      clipboardData: transfer,
      bubbles: true,
      cancelable: true,
    });
    element.dispatchEvent(event);
    if (!event.defaultPrevented)
      throw new Error(
        "Markdown Mint did not handle the fixed TSV paste event.",
      );
  }, tsv);
}

async function waitForTableValues(page, expectedRows) {
  await page.waitForFunction((rows) => {
    const table = document.querySelector(".mm-rich-panel .ProseMirror table");
    if (!table) return false;
    const values = Array.from(table.rows, (row) =>
      Array.from(row.cells, (cell) => cell.textContent?.trim() ?? ""),
    );
    return JSON.stringify(values) === JSON.stringify(rows);
  }, expectedRows);
}

async function moveOwnerColumnBeforeStatus(page) {
  const table = page.locator(".mm-rich-panel .ProseMirror table");
  const statusHeader = table.locator("tr").first().locator("th, td").nth(1);
  const ownerHeader = table.locator("tr").first().locator("th, td").nth(2);
  const statusBox = await statusHeader.boundingBox();
  const ownerBox = await ownerHeader.boundingBox();
  assert.ok(
    statusBox && ownerBox,
    "Promo table headers have no visible geometry.",
  );
  const handle = page.locator(
    '[data-table-control="column-handle"][data-index="2"]',
  );
  await page.mouse.move(
    ownerBox.x + ownerBox.width / 2,
    Math.max(8, ownerBox.y - 18),
  );
  await handle.waitFor({ state: "visible" });
  const handleBox = await handle.boundingBox();
  assert.ok(handleBox, "Owner column handle has no visible geometry.");
  await page.waitForTimeout(250);
  const dragY = handleBox.y + handleBox.height / 2;
  await page.mouse.move(handleBox.x + handleBox.width / 2, dragY);
  await page.mouse.down();
  await page.mouse.move(statusBox.x + 3, dragY, { steps: 14 });
  await page
    .locator(".mm-table-drag-preview:visible")
    .waitFor({ state: "visible" });
  await page.waitForTimeout(250);
  await page.mouse.up();
  const expectedRows = [
    ["Feature", "Owner", "Status"],
    ["Search", "Alice", "Done"],
    ["Export", "Bob", "WIP"],
    ["Mermaid", "Carol", "Done"],
  ];
  await waitForTableValues(page, expectedRows);
  return expectedRows;
}

async function openInsertCommand(page, label) {
  const editor = page.locator(".mm-rich-panel .ProseMirror");
  const finalParagraph = editor.locator(":scope > p").last();
  if ((await finalParagraph.count()) === 0) {
    throw new Error("No paragraph is available after the pasted table.");
  }
  if (((await finalParagraph.textContent()) ?? "").trim() !== "") {
    const table = editor.locator("table").last();
    const box = await table.boundingBox();
    if (!box) throw new Error("The pasted table has no visible geometry.");
    await page.mouse.click(box.x + box.width - 2, box.y + box.height + 12);
    await page.keyboard.press("Enter");
  }
  const targetParagraph = editor.locator(":scope > p").last();
  await targetParagraph.click();
  await page.keyboard.type("/");
  const menu = page.locator(".mm-empty-line-popup");
  await menu.waitFor({ state: "visible" });
  await page.waitForTimeout(timing.slashMenuHoldMs);
  const command = menu.getByRole("menuitem", { name: label, exact: true });
  await command.waitFor({ state: "visible" });
  await command.click();
  await page.waitForFunction(() => {
    const menuElement = document.querySelector(".mm-empty-line-popup");
    return (
      !menuElement ||
      menuElement.hidden ||
      menuElement.getAttribute("aria-hidden") === "true" ||
      getComputedStyle(menuElement).display === "none"
    );
  });
}

async function insertTipAlert(page) {
  await openInsertCommand(page, "Alert");
  const dialog = page.locator(".mm-profile-feature-dialog[open]");
  await dialog.waitFor({ state: "visible" });
  await dialog.locator('[data-feature-field="alert-type"]').selectOption("TIP");
  await dialog
    .locator('[data-feature-field="body"]')
    .fill("Your .md file stays Markdown.");
  await page.waitForTimeout(300);
  await dialog.getByRole("button", { name: "Insert", exact: true }).click();
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll(".mm-alert-node-view")).some(
      (node) =>
        node.textContent?.includes("Your .md file stays Markdown.") ||
        node
          .querySelector("textarea")
          ?.value.includes("Your .md file stays Markdown."),
    ),
  );
  await page.waitForTimeout(timing.alertHoldMs);
  const alert = await page
    .locator(".mm-rich-panel .mm-alert-node-view")
    .last()
    .evaluate((node) => ({
      text: node.textContent ?? "",
      body: node.querySelector("textarea")?.value ?? "",
      source: node.getAttribute("data-source") ?? "",
      type:
        node
          .querySelector("[data-alert-type]")
          ?.getAttribute("data-alert-type") ?? "",
    }));
  const source = await page.evaluate(
    () => window.markdownMint?.sourceEl?.value ?? "",
  );
  assert.ok(
    alert.text.includes("Your .md file stays Markdown.") ||
      alert.body.includes("Your .md file stays Markdown."),
  );
  assert.ok(
    source.includes("> [!TIP]\n> Your .md file stays Markdown."),
    "TIP Alert source was not generated from the Rich UI action.",
  );
  return { type: "TIP", body: "Your .md file stays Markdown." };
}

async function openSourceAndValidate(page, expected) {
  const sourceButton = page.locator(".mm-source-button");
  await sourceButton.waitFor({ state: "visible" });
  assert.equal(await sourceButton.isEnabled(), true);
  await page.waitForFunction(
    () => window.markdownMint?.sync?.hasPending === false,
    null,
    { timeout: 10_000 },
  );
  await sourceButton.click();
  await page
    .waitForFunction(
      () =>
        window.markdownMint?.mode === "source" &&
        document.querySelector(".mm-source-textarea")?.hidden === false,
      null,
      { timeout: 10_000 },
    )
    .catch(async (error) => {
      const state = await page.evaluate(() => ({
        mode: window.markdownMint?.mode,
        bodyMode: document.body.dataset.markdownMintMode,
        syncPending: window.markdownMint?.sync?.hasPending,
        sourceHidden: document.querySelector(".mm-source-textarea")?.hidden,
        sourceVisible:
          document.querySelector(".mm-source-textarea")?.getBoundingClientRect()
            .width > 0,
        notice: document.querySelector(".mm-notice")?.textContent,
      }));
      throw new Error(
        `${error.message}; Source state: ${JSON.stringify(state)}`,
      );
    });
  await page.locator(".mm-source-textarea").waitFor({ state: "visible" });
  const sourceLayout = await fitSourceTextarea(page);
  await showMarker(page, "source-start");
  await page.waitForTimeout(timing.sourceHoldMs);
  const source = await page.locator(".mm-source-textarea").inputValue();
  assertExpectedSource(source, expected);
  await showMarker(page, "source-end");
  return {
    source,
    sourceLineCount: sourceLayout.sourceLineCount,
    sourceVisibleLineCount: sourceLayout.visibleLineCount,
  };
}

async function fitSourceTextarea(page) {
  const layout = await page
    .locator(".mm-source-textarea")
    .evaluate((textarea) => {
      textarea.style.fontSize = "18px";
      textarea.style.lineHeight = "1.35";
      const rectangle = textarea.getBoundingClientRect();
      const availableHeight = Math.max(
        200,
        window.innerHeight - rectangle.top - 28,
      );
      const height = Math.min(
        availableHeight,
        Math.max(360, textarea.scrollHeight + 36),
      );
      textarea.style.height = `${height}px`;
      textarea.style.minHeight = `${height}px`;
      textarea.style.maxHeight = `${height}px`;
      textarea.style.resize = "none";
      textarea.scrollTop = 0;

      const style = getComputedStyle(textarea);
      const lineHeight =
        Number.parseFloat(style.lineHeight) ||
        Number.parseFloat(style.fontSize) * 1.35;
      const padding =
        Number.parseFloat(style.paddingTop) +
        Number.parseFloat(style.paddingBottom);
      return {
        sourceLineCount: textarea.value.split("\n").length,
        visibleLineCount: Math.floor(
          (textarea.clientHeight - padding) / lineHeight,
        ),
        height: textarea.clientHeight,
      };
    });
  assert.ok(
    layout.visibleLineCount >= layout.sourceLineCount,
    `Source textarea fits ${layout.visibleLineCount} lines but Markdown has ${layout.sourceLineCount}.`,
  );
  return layout;
}

async function collectScenario(page, { initialMarkdown, tsv, expected }) {
  await page.waitForTimeout(timing.introHoldMs);
  process.stdout.write("Showing the prepared Project Status document.\n");
  await pasteFixedTsv(page, tsv);
  const initialRows = [
    ["Feature", "Status", "Owner"],
    ["Search", "Done", "Alice"],
    ["Export", "WIP", "Bob"],
    ["Mermaid", "Done", "Carol"],
  ];
  await waitForTableValues(page, initialRows);
  process.stdout.write("Validated the pasted 4x3 TSV table.\n");
  await page.waitForTimeout(timing.tableHoldMs);
  const finalRows = await moveOwnerColumnBeforeStatus(page);
  process.stdout.write("Moved Owner before Status and validated every cell.\n");
  await page.waitForTimeout(timing.reorderedTableHoldMs);
  const alert = await insertTipAlert(page);
  process.stdout.write(
    "Inserted the GitHub TIP Alert through the slash menu.\n",
  );
  const sourceView = await openSourceAndValidate(page, expected);
  process.stdout.write("Opened Source and matched promo-expected.json.\n");
  const tableValues = await readTableValuesFromSourceDom(page);
  assert.deepEqual(tableValues, finalRows);
  return { alert, finalRows, initialMarkdown, ...sourceView, tableValues };
}

async function readTableValuesFromSourceDom(page) {
  return await page.evaluate(() => {
    const table = document.querySelector(".mm-rich-panel .ProseMirror table");
    if (!table) return null;
    return Array.from(table.rows, (row) =>
      Array.from(row.cells, (cell) => cell.textContent?.trim() ?? ""),
    );
  });
}

async function currentGitCommit() {
  const result = await runProcess("git", ["rev-parse", "HEAD"], {
    cwd: repository,
  });
  return result.stdout.toString("utf8").trim();
}

async function main() {
  const options = parsePromoArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  await assertPortAvailable(options.port);
  const prerequisites = await checkPrerequisites();
  process.stdout.write(
    `Node/npm: ${prerequisites.runtime.node} / ${prerequisites.runtime.npm}\n`,
  );
  process.stdout.write(`FFmpeg: ${prerequisites.ffmpeg.ffmpeg}\n`);
  process.stdout.write(`FFprobe: ${prerequisites.ffmpeg.ffprobe}\n`);
  process.stdout.write(`Chromium: ${prerequisites.chromiumExecutable}\n`);
  if (prerequisites.markdownCss.fallback)
    process.stdout.write(
      "VS Code Markdown CSS not found; using the local harness fallback.\n",
    );

  const [initialMarkdown, tsv, expected] = await Promise.all([
    readFile(paths.initialMarkdown, "utf8"),
    readFile(paths.tableTsv, "utf8"),
    readExpectedMarkdown(paths.expectedMarkdown),
  ]);
  const stageDir = resolve(paths.outputDir, `.promo-run-${randomUUID()}`);
  await mkdir(stageDir, { recursive: true });
  let server;
  let browser;
  let context;
  let page;
  let video;
  let savedMasterPath;
  const pageErrors = [];
  let successful = false;

  try {
    await buildWebview();
    server = startServer(options.port, prerequisites.markdownCss.path);
    const baseUrl = `http://127.0.0.1:${options.port}`;
    await waitForServer(server, `${baseUrl}/`);
    browser = await chromium.launch({ headless: !options.headed });
    context = await browser.newContext({
      viewport: { ...PROMO_VIEWPORT },
      recordVideo: { dir: stageDir, size: { ...PROMO_VIEWPORT } },
      colorScheme: "light",
      locale: "en-US",
      deviceScaleFactor: 1,
    });
    page = await context.newPage();
    video = page.video();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await prepareDemo(page, initialMarkdown, baseUrl);
    await showMarker(page, "clip-start");
    const scenario = await collectScenario(page, {
      initialMarkdown,
      tsv,
      expected,
    });
    await showMarker(page, "clip-end");
    if (pageErrors.length > 0)
      throw new Error(`Browser page errors occurred: ${pageErrors.join("; ")}`);
    await context.close();
    context = null;
    const videoPath = await video.path();
    savedMasterPath = resolve(stageDir, "markdown-mint-promo.webm");
    await rename(videoPath, savedMasterPath);

    const ffmpegPath = process.env.MM_FFMPEG ?? "ffmpeg";
    const ffprobePath = process.env.MM_FFPROBE ?? "ffprobe";
    const capture = await inspectRecordingMarkers(
      savedMasterPath,
      ffmpegPath,
      ffprobePath,
      repository,
    );
    if (capture.durationSeconds < 14.5 || capture.durationSeconds > 20.5)
      throw new Error(
        `Captured promo interval is ${capture.durationSeconds.toFixed(2)} seconds; tune the scenario to 15-20 seconds.`,
      );
    if (capture.sourceVisibleDurationSeconds < 2)
      throw new Error(
        `Recorded Source view lasted ${capture.sourceVisibleDurationSeconds.toFixed(2)} seconds; at least 2 seconds are required.`,
      );

    const sourcePath = resolve(stageDir, "generated.md");
    await writeFile(sourcePath, scenario.source, "utf8");
    const masterBytes = await readFile(savedMasterPath);
    const packageLock = JSON.parse(
      await readFile(resolve(repository, "package-lock.json"), "utf8"),
    );
    const report = {
      schemaVersion: 1,
      runId: randomUUID(),
      generatedAt: new Date().toISOString(),
      gitCommit: await currentGitCommit(),
      environment: {
        platform: `${process.platform}-${process.arch}`,
        osRelease: (
          await runProcess("uname", ["-sr"], { cwd: repository })
        ).stdout
          .toString("utf8")
          .trim(),
        node: process.version,
        npm: prerequisites.runtime.npm,
        playwright: packageLock.packages?.["node_modules/playwright"]?.version,
        chromium: prerequisites.chromiumExecutable,
        ffmpeg: prerequisites.ffmpeg.ffmpeg,
        ffprobe: prerequisites.ffmpeg.ffprobe,
      },
      capture: {
        ...capture,
        masterSha256: sha256(masterBytes),
        masterPath: "output/demo/markdown-mint-promo.webm",
        viewport: { ...PROMO_VIEWPORT },
        recordVideoSize: { ...PROMO_VIEWPORT },
        headed: options.headed,
        markerFramesExcludedFromExports: true,
      },
      scenario: {
        validated: true,
        profile: "github",
        sourceView: "Browser harness Source fallback",
        pasteMethod:
          "Synthetic paste ClipboardEvent with fixed TSV; Markdown Mint production paste handler ran.",
        pointerIndicator:
          "Demo-only pointer ring following Playwright pointer events.",
        initialMarkdownPath: "docs/demo/promo-initial.md",
        tableFixturePath: "docs/demo/promo-table.tsv",
        expectedMarkdownPath: "docs/demo/promo-expected.json",
        generatedMarkdownPath: "output/demo/generated.md",
        generatedMarkdownSha256: sha256(scenario.source),
        expectedMarkdownSha256: sha256(expected),
        actions: [
          "Show the prepared Project Status document.",
          "Paste the fixed TSV through the editor paste handler.",
          "Move the Owner column before Status with the table column handle.",
          "Open the slash menu and insert a GitHub TIP Alert through its dialog.",
          "Open Source and compare its content with the expected fixture.",
        ],
        initialMarkdown,
        table: {
          rows: scenario.tableValues.length - 1,
          columns: scenario.tableValues[0].length,
          values: scenario.tableValues,
        },
        alert: scenario.alert,
        sourceVisibleHoldRequestedMs: timing.sourceHoldMs,
        sourceVisibleDurationSeconds: capture.sourceVisibleDurationSeconds,
        sourceLineCount: scenario.sourceLineCount,
        sourceVisibleLineCount: scenario.sourceVisibleLineCount,
      },
    };

    const rendered = await renderPromoMedia({
      masterPath: savedMasterPath,
      outputDir: stageDir,
      capture,
      ffmpegPath,
      ffprobePath,
      cwd: repository,
    });
    report.media = { ...rendered, runId: report.runId };
    if (rendered.gif.sizeBytes > rendered.gifSizeTargetBytes)
      process.stdout.write(
        `GIF is ${formatMiB(rendered.gif.sizeBytes)} MiB; it meets the 8 MiB limit but exceeds the 5 MiB target.\n`,
      );
    await writeFile(
      resolve(stageDir, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
    await copyFile(
      resolve(stageDir, "markdown-mint-promo.gif"),
      resolve(stageDir, "overview.gif"),
    );
    await publishValidatedFiles([
      {
        source: savedMasterPath,
        target: resolve(paths.outputDir, "markdown-mint-promo.webm"),
      },
      {
        source: resolve(stageDir, "markdown-mint-promo.mp4"),
        target: resolve(paths.outputDir, "markdown-mint-promo.mp4"),
      },
      {
        source: resolve(stageDir, "markdown-mint-promo.gif"),
        target: resolve(paths.outputDir, "markdown-mint-promo.gif"),
      },
      { source: sourcePath, target: resolve(paths.outputDir, "generated.md") },
      {
        source: resolve(stageDir, "report.json"),
        target: resolve(paths.outputDir, "report.json"),
      },
      {
        source: resolve(stageDir, "overview.gif"),
        target: paths.overviewGif,
      },
    ]);
    successful = true;
    process.stdout.write("\nPromo demo succeeded.\n");
    process.stdout.write(`Run id: ${report.runId}\n`);
    process.stdout.write(
      `Published interval: ${rendered.outputDurationSeconds.toFixed(2)}s\n`,
    );
    process.stdout.write(
      `Source visible in recorded frames: ${capture.sourceVisibleDurationSeconds.toFixed(2)}s\n`,
    );
    process.stdout.write(
      `MP4: ${formatMiB(rendered.mp4.sizeBytes)} MiB, H.264, 1280x720, no audio\n`,
    );
    process.stdout.write(
      `GIF: ${formatMiB(rendered.gif.sizeBytes)} MiB, 960x540, about 12 fps\n`,
    );
    process.stdout.write(`README GIF updated: docs/media/overview.gif\n`);
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    await stopServer(server).catch((error) => {
      process.stderr.write(
        `Could not stop the promo browser harness: ${error.message}\n`,
      );
    });
    await rm(stageDir, { recursive: true, force: true });
  }
}

function formatMiB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2);
}

const PROMO_VIEWPORT = Object.freeze({ width: 1280, height: 720 });

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
