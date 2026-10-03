import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const output = resolve(repository, "output/playwright/mermaid-templates");
const port = Number(process.env.MM_MERMAID_TEST_PORT ?? "4181");
const baseUrl = `http://127.0.0.1:${port}`;
const dialogSelector = ".mm-profile-feature-dialog[open]";
const sourceSelector = '[data-feature-field="body"]';
const labels = {
  "flowchart-basic": ["Start", "Process", "End"],
  "flowchart-decision": ["Start", "Ready?", "Finish", "Review"],
  "flowchart-grouped": ["Clients", "Services", "Browser", "API", "Database"],
  "sequence-request-response": [
    "User",
    "App",
    "Server",
    "Open page",
    "Return data",
  ],
  "sequence-alternative": [
    "User",
    "App",
    "Server",
    "Accepted",
    "Rejected",
    "Welcome",
  ],
  "state-workflow": ["Planned", "InProgress", "Complete"],
  "class-basic": ["User", "Order", "name", "submit"],
  "er-order": ["USER", "ORDER", "PRODUCT", "places", "contains"],
  "gantt-project": ["Project schedule", "Design", "Implement", "Test"],
  "mindmap-basic": [
    "Project",
    "Goals",
    "Quality",
    "Simplicity",
    "People",
    "Team",
    "Users",
  ],
  "timeline-roadmap": [
    "Release roadmap",
    "Q1",
    "Q2",
    "Q3",
    "Plan",
    "Develop",
    "Release",
  ],
  "pie-composition": ["Work allocation", "Build", "Test", "Plan"],
  "gitgraph-branch-merge": ["Start", "Change", "Prepare", "Merge", "feature"],
};
const edits = (page) =>
  page.evaluate(
    () =>
      window.__markdownMintHarness.messages.filter(
        (message) => message.type === "edit",
      ).length,
  );
const saved = async (page) => {
  await page.waitForFunction(() => !window.markdownMint.sync.hasPending);
  return page.evaluate(() => window.__markdownMintHarness.document.markdown);
};
async function load(page, source = "Before", profile = "github") {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.markdownMint?.view);
  await page.evaluate(
    ([markdown, nextProfile]) =>
      window.__markdownMintHarness.deliverExternal(markdown, nextProfile),
    [source, profile],
  );
  await page.waitForFunction(
    (expected) => window.__markdownMintHarness.document.markdown === expected,
    source,
  );
}
async function open(page) {
  await page.locator('button[data-profile-feature="mermaid"]').click();
  const dialog = page.locator(dialogSelector);
  await dialog.waitFor();
  return dialog;
}
async function preview(page) {
  const result = page.locator(`${dialogSelector} .mm-mermaid-preview`);
  await page.waitForFunction(
    (selector) =>
      ["rendered", "failed", "invalid", "unavailable"].includes(
        document.querySelector(selector)?.dataset.previewState,
      ),
    `${dialogSelector} .mm-mermaid-preview`,
  );
  assert.equal(
    await result.getAttribute("data-preview-state"),
    "rendered",
    await result.textContent(),
  );
  return result;
}
async function visibleLabels(locator, expected, label) {
  const text = await locator.locator("svg").evaluate((svg) =>
    Array.from(svg.querySelectorAll("text"))
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none"
        );
      })
      .map((node) => node.textContent)
      .join(" "),
  );
  for (const value of expected)
    assert.ok(
      text.includes(value),
      `${label}: missing visible label ${value}: ${text}`,
    );
  assert.equal(
    await locator
      .locator("svg foreignObject, svg script, svg [onclick], svg [href]")
      .count(),
    0,
    `${label}: unsafe SVG`,
  );
}

async function catalogChecks(page, templates, buildSource) {
  const results = [];
  for (const template of templates) {
    for (const direction of template.directions ?? [undefined]) {
      await load(page);
      const count = await edits(page);
      const dialog = await open(page);
      await dialog.locator(`[data-template-id="${template.id}"]`).click();
      if (direction)
        await dialog.getByLabel("Template direction").selectOption(direction);
      await visibleLabels(
        await preview(page),
        labels[template.id],
        `${template.id} ${direction ?? ""}`,
      );
      assert.equal(
        await edits(page),
        count,
        "candidate preview changed document",
      );
      await dialog
        .getByRole("button", { name: "Use this template", exact: true })
        .click();
      const input = dialog.locator(sourceSelector);
      assert.equal(
        await input.inputValue(),
        buildSource(template.id, { direction }),
      );
      await visibleLabels(await preview(page), labels[template.id], "draft");
      const unicodeSource = (await input.inputValue()).replace(
        labels[template.id][0],
        "日本語ラベル",
      );
      await input.fill(unicodeSource);
      assert.equal(
        await dialog.locator(".mm-mermaid-preview svg").count(),
        0,
        "stale preview survived input",
      );
      await visibleLabels(
        await preview(page),
        ["日本語ラベル"],
        "Unicode draft",
      );
      await dialog.getByRole("button", { name: "Insert", exact: true }).click();
      await page.locator(dialogSelector).waitFor({ state: "detached" });
      assert.equal(
        await edits(page),
        count + 1,
        "commit did not emit one edit",
      );
      const markdown = await saved(page);
      assert.ok(markdown.includes("```mermaid\n" + unicodeSource + "\n```"));
      const rendered = page.locator(".mm-rich-panel .mm-mermaid");
      await rendered.locator("svg").waitFor();
      await visibleLabels(rendered, ["日本語ラベル"], "document");
      await rendered.dblclick();
      assert.equal(
        await page.locator(`${dialogSelector} ${sourceSelector}`).inputValue(),
        unicodeSource,
      );
      assert.equal(
        await page
          .locator(`${dialogSelector} .mm-mermaid-template-picker`)
          .isVisible(),
        false,
      );
      await preview(page);
      await page
        .locator(dialogSelector)
        .getByRole("button", { name: "Update", exact: true })
        .click();
      assert.equal(
        await saved(page),
        markdown,
        "unchanged re-edit rewrote source",
      );
      assert.equal(
        await edits(page),
        count + 1,
        "no-op update emitted an edit",
      );
      results.push({
        id: template.id,
        direction: direction ?? null,
        rendered: true,
        unicode: true,
        roundTrip: true,
      });
      console.log(`Passed ${template.id} ${direction ?? ""}`);
    }
  }
  return results;
}

async function interactionChecks(page) {
  await load(page);
  const before = await saved(page);
  const count = await edits(page);
  let dialog = await open(page);
  const list = dialog.getByRole("listbox");
  await list.press("ArrowDown");
  assert.equal(
    await list
      .locator('[aria-selected="true"]')
      .getAttribute("data-template-id"),
    "flowchart-decision",
  );
  await list.press("Enter");
  await list.press(
    process.platform === "darwin" ? "Meta+Enter" : "Control+Enter",
  );
  assert.equal(await edits(page), count);
  assert.equal(
    await dialog.locator(".mm-mermaid-template-picker").isVisible(),
    true,
  );
  await list.press("Tab");
  assert.equal(
    await dialog
      .getByLabel("Template direction")
      .evaluate((element) => document.activeElement === element),
    true,
  );
  await page.keyboard.press("Escape");
  assert.equal(
    await dialog.locator(sourceSelector).inputValue(),
    "flowchart TD\n    A[Start] --> B[End]",
  );
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(dialogSelector).count(), 0);
  assert.equal(
    await page
      .locator('button[data-profile-feature="mermaid"]')
      .evaluate((element) => document.activeElement === element),
    true,
  );
  assert.equal(await saved(page), before);

  dialog = await open(page);
  await dialog
    .getByRole("button", { name: "Use this template", exact: true })
    .focus();
  await page.keyboard.press("Space");
  const input = dialog.locator(sourceSelector);
  const original =
    "flowchart TD\n    A[日本語 🐈] --> B[End]\n" +
    Array.from({ length: 70 }, (_, index) => "    %% comment " + index).join(
      "\n",
    );
  await input.fill(original);
  const snapshot = await input.evaluate((element) => {
    element.setSelectionRange(19, 24, "backward");
    element.scrollTop = 220;
    return [
      element.selectionStart,
      element.selectionEnd,
      element.selectionDirection,
      element.scrollTop,
      element.scrollLeft,
    ];
  });
  await dialog.getByRole("button", { name: "Templates", exact: true }).click();
  await dialog.locator('[data-template-id="gantt-project"]').click();
  await dialog
    .getByRole("button", { name: "Use this template", exact: true })
    .click();
  assert.equal(
    await dialog.locator(".mm-mermaid-replacement-confirmation").isVisible(),
    true,
  );
  assert.equal(await input.inputValue(), original);
  await page.keyboard.press("Escape");
  assert.equal(
    await dialog.locator(".mm-mermaid-replacement-confirmation").isVisible(),
    false,
  );
  assert.equal(
    await dialog.locator(".mm-mermaid-template-picker").isVisible(),
    true,
  );
  await page.keyboard.press("Escape");
  assert.equal(await input.inputValue(), original);
  assert.deepEqual(
    await input.evaluate((element) => [
      element.selectionStart,
      element.selectionEnd,
      element.selectionDirection,
      element.scrollTop,
      element.scrollLeft,
    ]),
    snapshot,
  );
  await dialog.getByRole("button", { name: "Templates", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Use this template", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Replace code", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Undo replacement", exact: true })
    .click();
  assert.equal(await input.inputValue(), original);
  assert.deepEqual(
    await input.evaluate((element) => [
      element.selectionStart,
      element.selectionEnd,
      element.selectionDirection,
      element.scrollTop,
      element.scrollLeft,
    ]),
    snapshot,
  );
  await dialog.getByRole("button", { name: "Templates", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Use this template", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Replace code", exact: true })
    .click();
  await input.fill(
    (await input.inputValue()) + "\n    %% typed after replacement",
  );
  await dialog
    .getByRole("button", { name: "Undo replacement", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Keep current code", exact: true })
    .click();
  assert.ok((await input.inputValue()).includes("typed after replacement"));
  await dialog
    .getByRole("button", { name: "Undo replacement", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Restore code", exact: true })
    .click();
  assert.equal(await input.inputValue(), original);
  assert.equal(await edits(page), count);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .locator(".mm-discard-changes-dialog")
    .getByRole("button", { name: "Discard", exact: true })
    .click();
  assert.equal(await saved(page), before);

  dialog = await open(page);
  assert.equal(
    await dialog
      .getByRole("button", { name: "Undo replacement", exact: true })
      .isVisible(),
    false,
  );
  const selected = await dialog
    .getByRole("listbox")
    .locator('[aria-selected="true"]')
    .getAttribute("data-template-id");
  await dialog
    .getByRole("listbox")
    .evaluate((element) =>
      element.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      ),
    );
  await dialog.getByRole("listbox").press("ArrowDown");
  await page.keyboard.press("Escape");
  assert.equal(
    await dialog
      .getByRole("listbox")
      .locator('[aria-selected="true"]')
      .getAttribute("data-template-id"),
    selected,
  );
  assert.equal(
    await dialog.locator(".mm-mermaid-template-picker").isVisible(),
    true,
  );
  await dialog
    .getByRole("listbox")
    .evaluate((element) =>
      element.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true }),
      ),
    );
  await page.waitForTimeout(60);
  await dialog
    .getByRole("button", { name: "Use this template", exact: true })
    .click();
  await preview(page);
  await dialog.getByRole("button", { name: "Insert", exact: true }).click();
  const inserted = await saved(page);
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+z" : "Control+z",
  );
  await page.waitForFunction(
    (source) => window.__markdownMintHarness.document.markdown === source,
    before,
  );
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+Shift+z" : "Control+y",
  );
  await page.waitForFunction(
    (source) => window.__markdownMintHarness.document.markdown === source,
    inserted,
  );
  console.log(
    "Passed keyboard, replacement, restoration, composition events, cancellation, and Undo/Redo boundaries",
  );
}

async function guardChecks(page) {
  const source =
    "Before\n\n~~~mermaid extra\r\nflowchart LR\r\n    A[Original] --> B[End]\r\n~~~\n\nAfter";
  await load(page, source);
  const rendered = page.locator(".mm-rich-panel .mm-mermaid");
  await rendered.locator("svg").waitFor();
  await rendered.dblclick();
  let dialog = page.locator(dialogSelector);
  const original = await dialog.locator(sourceSelector).inputValue();
  assert.ok(original.includes("Original"));
  assert.equal(
    await dialog.locator(".mm-mermaid-template-picker").isVisible(),
    false,
  );
  await dialog.getByRole("button", { name: "Templates", exact: true }).click();
  await dialog.locator('[data-template-id="mindmap-basic"]').click();
  await preview(page);
  await page.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "Update", exact: true }).click();
  assert.equal(
    await saved(page),
    source,
    "no-op edit changed original fence or line endings",
  );
  const count = await edits(page);
  await rendered.dblclick();
  dialog = page.locator(dialogSelector);
  await dialog
    .locator(sourceSelector)
    .fill("flowchart TD\n    A[New] --> B[End]");
  await preview(page);
  await page.evaluate(() =>
    window.markdownMint.view.setProps({ editable: () => false }),
  );
  await dialog.getByRole("button", { name: "Update", exact: true }).click();
  assert.equal(await edits(page), count, "read-only dialog wrote to document");
  assert.equal(
    await dialog.locator(sourceSelector).inputValue(),
    "flowchart TD\n    A[New] --> B[End]",
  );

  await load(page, source);
  await page.locator(".mm-rich-panel .mm-mermaid").dblclick();
  dialog = page.locator(dialogSelector);
  await dialog
    .locator(sourceSelector)
    .fill("flowchart TD\n    A[New] --> B[End]");
  await page.evaluate(() =>
    window.__markdownMintHarness.deliverExternal("External update"),
  );
  await dialog
    .locator("form")
    .evaluate((form) =>
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      ),
    );
  assert.equal(await saved(page), "External update");

  await load(page, "flowchart LR A-->B");
  await page.locator(".mm-rich-panel .ProseMirror").evaluate((element) => {
    const view = window.markdownMint.view;
    const Selection = view.state.selection.constructor;
    view.dispatch(
      view.state.tr.setSelection(
        Selection.create(view.state.doc, 1, view.state.doc.content.size - 1),
      ),
    );
    element.focus();
  });
  dialog = await open(page);
  assert.equal(
    await dialog.locator(sourceSelector).inputValue(),
    "flowchart LR A-->B",
  );
  assert.equal(
    await dialog.locator(".mm-mermaid-template-picker").isVisible(),
    false,
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await saved(page), "flowchart LR A-->B");

  await load(page, "Before", "gitlab");
  dialog = await open(page);
  await dialog
    .getByRole("button", { name: "Use this template", exact: true })
    .click();
  await preview(page);
  await dialog.getByRole("button", { name: "Insert", exact: true }).click();
  assert.ok((await saved(page)).includes("```mermaid"));
  await load(page, "Before", "commonmark");
  assert.equal(
    await page.locator('button[data-profile-feature="mermaid"]').isVisible(),
    false,
  );
  console.log(
    "Passed existing/selected code, fence preservation, read-only/external guards and profiles",
  );
}

async function themeChecks(page) {
  await load(page);
  const requestsBefore = await page.evaluate(
    () =>
      performance
        .getEntriesByType("resource")
        .filter((entry) => entry.name.endsWith("/mermaid.js")).length,
  );
  assert.equal(requestsBefore, 0, "ordinary document loaded Mermaid");
  const dialog = await open(page);
  await preview(page);
  const themes = [
    ["vscode-light", "#ffffff", "#1f2328", "#0969da"],
    ["vscode-dark", "#1e1e1e", "#d4d4d4", "#3794ff"],
    ["vscode-high-contrast", "#000000", "#ffffff", "#00a8ff"],
    ["vscode-high-contrast-light", "#ffffff", "#000000", "#0000ee"],
  ];
  for (const [theme, background, foreground, accent] of themes) {
    await page.evaluate(
      ([name, bg, fg, link]) => {
        document.documentElement.className = document.body.className = name;
        for (const host of [document.documentElement, document.body]) {
          host.style.setProperty("--vscode-editor-background", bg);
          host.style.setProperty("--vscode-editor-foreground", fg);
          host.style.setProperty("--vscode-foreground", fg);
          host.style.setProperty("--vscode-textCodeBlock-background", bg);
          host.style.setProperty("--vscode-textLink-foreground", link);
        }
      },
      [theme, background, foreground, accent],
    );
    await visibleLabels(
      await preview(page),
      ["Start", "Process", "End"],
      theme,
    );
    await page.screenshot({ path: resolve(output, `${theme}-picker.png`) });
  }
  await dialog
    .getByRole("button", { name: "Use this template", exact: true })
    .click();
  await preview(page);
  await page.setViewportSize({ width: 380, height: 640 });
  for (const selector of [
    sourceSelector,
    ".mm-mermaid-preview",
    ".mm-dialog-actions",
  ]) {
    const box = await dialog.locator(selector).boundingBox();
    assert.ok(
      box &&
        box.x >= 0 &&
        box.y >= 0 &&
        box.x + box.width <= 380 &&
        box.y + box.height <= 640,
      `narrow layout overflow: ${selector} ${JSON.stringify(box)}`,
    );
  }
  await page.screenshot({ path: resolve(output, "narrow-code.png") });
  await dialog.getByRole("button", { name: "Templates", exact: true }).click();
  await preview(page);
  await page.screenshot({ path: resolve(output, "narrow-picker.png") });
  const box = await dialog
    .getByRole("button", { name: "Use this template", exact: true })
    .boundingBox();
  assert.ok(box && box.y + box.height <= 640);
  await page.setViewportSize({ width: 1280, height: 900 });
  const requests = await page.evaluate(
    () =>
      performance
        .getEntriesByType("resource")
        .filter((entry) => entry.name.endsWith("/mermaid.js")).length,
  );
  assert.equal(requests, 1, "first-use runtime request was not shared");
  console.log(
    "Passed four live themes, narrow layouts, and lazy shared runtime loading",
  );
}

await mkdir(output, { recursive: true });
const catalogPath = resolve(output, "catalog.mjs");
await build({
  entryPoints: [resolve(repository, "src/webview/mermaidTemplates.ts")],
  outfile: catalogPath,
  bundle: true,
  platform: "node",
  format: "esm",
});
const { getMermaidTemplates, buildMermaidTemplateSource } = await import(
  pathToFileURL(catalogPath).href
);
const server = spawn(process.execPath, ["tests/browser/server.mjs"], {
  cwd: repository,
  env: { ...process.env, MM_BROWSER_PORT: String(port) },
  stdio: ["ignore", "pipe", "inherit"],
});
let browser;
let page;
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(baseUrl)).ok) break;
    } catch {
      /* starting */
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10000);
  const external = [];
  page.on("request", (request) => {
    if (/^https?:/.test(request.url()) && !request.url().startsWith(baseUrl))
      external.push(request.url());
  });
  const filter = process.env.MM_MERMAID_BROWSER_CASE;
  const results =
    !filter || filter === "catalog"
      ? await catalogChecks(
          page,
          getMermaidTemplates(),
          buildMermaidTemplateSource,
        )
      : [];
  for (const check of [interactionChecks, guardChecks, themeChecks]) {
    if (!filter || check.name.includes(filter)) await check(page);
  }
  assert.deepEqual(external, [], "template flow requested external resources");
  await writeFile(
    resolve(output, "results.json"),
    JSON.stringify({ results, external }, null, 2),
  );
  console.log("All Mermaid template browser checks passed.");
} catch (error) {
  await page
    ?.screenshot({ path: resolve(output, "failure.png"), fullPage: true })
    .catch(() => {});
  throw error;
} finally {
  await browser?.close();
  server.kill("SIGINT");
}
