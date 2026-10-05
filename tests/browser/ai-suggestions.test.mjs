import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const port = Number(process.env.MM_AI_BROWSER_PORT ?? "4186");
const baseUrl = `http://127.0.0.1:${port}`;
const output = resolve("output/playwright/ai-suggestions");
const modifier = process.platform === "darwin" ? "Meta" : "Control";
const server = spawn(process.execPath, ["tests/browser/server.mjs"], {
  env: { ...process.env, MM_BROWSER_PORT: String(port) },
  stdio: "pipe",
});
let serverOutput = "";
server.stdout.on("data", (chunk) => {
  serverOutput += chunk;
});
server.stderr.on("data", (chunk) => {
  serverOutput += chunk;
});
let browser;
let page;
const requests = () =>
  page.evaluate(() =>
    window.__markdownMintHarness.messages.filter(
      (message) => message.type === "ai-suggestion-request",
    ),
  );
const source = () =>
  page.evaluate(() => window.__markdownMintHarness.document.markdown);
async function load(markdown = "日本語の文章", profile = "github") {
  await page.goto(`${baseUrl}/?ai=1`);
  await page.waitForFunction(() => window.markdownMint?.view);
  await page.evaluate(
    ([text, selectedProfile]) =>
      window.__markdownMintHarness.deliverExternal(text, selectedProfile),
    [markdown, profile],
  );
  await endCaret();
}
async function endCaret() {
  await page.evaluate(() => {
    const view = window.markdownMint.view;
    view.dispatch(
      view.state.tr.setSelection(
        view.state.selection.constructor.near(
          view.state.doc.resolve(view.state.doc.content.size - 1),
        ),
      ),
    );
    view.focus();
  });
}
async function placeCaretAtText(text, offset) {
  await page.evaluate(
    ([needle, textOffset]) => {
      const view = window.markdownMint.view;
      let position;
      view.state.doc.descendants((node, start) => {
        if (!node.isText || !node.text) return;
        const index = node.text.indexOf(needle);
        if (
          index >= 0 &&
          node.text.indexOf(needle, index + needle.length) < 0 &&
          position === undefined
        )
          position = start + index + textOffset;
      });
      if (position === undefined)
        throw Error(`Could not find visible text: ${needle}`);
      view.dispatch(
        view.state.tr.setSelection(
          view.state.selection.constructor.create(view.state.doc, position),
        ),
      );
      view.focus();
    },
    [text, offset],
  );
}
async function trigger(text = " 続きを書きます🌿") {
  const count = (await requests()).length;
  await page.evaluate(() => window.__markdownMintHarness.triggerAi());
  await page.waitForFunction(
    (previous) =>
      window.__markdownMintHarness.messages.filter(
        (message) => message.type === "ai-suggestion-request",
      ).length > previous,
    count,
  );
  const request = (await requests()).at(-1);
  await page.evaluate(
    ([request, text]) => window.__markdownMintHarness.respondAi(request, text),
    [request, text],
  );
  await page.locator(".mm-ai-suggestion").waitFor();
  return request;
}

try {
  await mkdir(output, { recursive: true });
  for (let attempt = 0; ; attempt += 1) {
    try {
      if ((await fetch(baseUrl)).ok) break;
    } catch {
      /* server binding */
    }
    if (attempt > 100) throw Error(`Browser harness failed: ${serverOutput}`);
    await new Promise((done) => setTimeout(done, 50));
  }
  browser = await chromium.launch({
    headless: true,
    ...(process.env.MM_BROWSER_EXECUTABLE_PATH
      ? { executablePath: process.env.MM_BROWSER_EXECUTABLE_PATH }
      : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 960, height: 800 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  page = await context.newPage();
  page.setDefaultTimeout(8000);
  await load();
  const copilotButton = page.getByTestId("toolbar-copilot");
  const initialToolbar = await copilotButton.evaluate((button) => ({
    state: button.dataset.state,
    pressed: button.getAttribute("aria-pressed"),
    label: button.getAttribute("aria-label"),
    icon: button.querySelector("svg")?.dataset.icon,
    following: Array.from(button.parentElement?.children ?? [])
      .slice(
        Array.from(button.parentElement?.children ?? []).indexOf(button) + 1,
      )
      .map((child) =>
        child.classList.contains("mm-export-menu")
          ? "export"
          : child.classList.contains("mm-source-button")
            ? "source"
            : "other",
      ),
  }));
  assert.deepEqual(initialToolbar, {
    state: "on",
    pressed: "true",
    label: "Copilot suggestions: On. Click to turn off. Fake Copilot ready",
    icon: "copilot",
    following: ["export", "source"],
  });
  const initialRequestCount = (await requests()).length;
  await copilotButton.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    window.__markdownMintHarness.messages.some(
      (message) => message.type === "ai-suggestion-toolbar-action",
    ),
  );
  assert.equal(
    (await requests()).length,
    initialRequestCount,
    "toolbar setup/toggle click does not request a completion",
  );
  await page.evaluate(() =>
    window.__markdownMintHarness.setAiState({
      autoTrigger: false,
      availability: "disabled",
    }),
  );
  assert.equal(await copilotButton.getAttribute("data-state"), "off");
  assert.equal(await copilotButton.getAttribute("aria-pressed"), "false");
  assert.equal(
    await copilotButton.locator("svg").getAttribute("data-icon"),
    "copilot-blocked",
  );
  await page.evaluate(() =>
    window.__markdownMintHarness.setAiState({
      autoTrigger: true,
      availability: "needs-authorization",
      statusText: "Click to authorize",
    }),
  );
  assert.equal(await copilotButton.getAttribute("data-state"), "authorization");
  assert.equal(
    await copilotButton.locator("svg").getAttribute("data-icon"),
    "copilot-not-connected",
  );
  console.log(
    "Passed accessible Copilot toolbar setup/on/off states and ordering",
  );
  for (const [theme, background, foreground] of [
    ["dark", "#1e1e1e", "#d4d4d4"],
    ["light", "#ffffff", "#333333"],
  ]) {
    await page.evaluate(
      ([theme, background, foreground]) => {
        document.documentElement.className = `vscode-${theme}`;
        document.body.className = `vscode-${theme}`;
        document.documentElement.style.setProperty(
          "--vscode-editor-background",
          background,
        );
        document.documentElement.style.setProperty(
          "--vscode-icon-foreground",
          foreground,
        );
      },
      [theme, background, foreground],
    );
    const appearance = await copilotButton.evaluate((button) => {
      const svg = button.querySelector("svg");
      const box = button.getBoundingClientRect();
      return {
        visible: box.width >= 28 && box.height >= 28,
        buttonColor: getComputedStyle(button).color,
        iconFill: svg ? getComputedStyle(svg).fill : "none",
        following: Array.from(button.parentElement?.children ?? [])
          .slice(
            Array.from(button.parentElement?.children ?? []).indexOf(button) +
              1,
          )
          .map((child) =>
            child.classList.contains("mm-export-menu")
              ? "export"
              : child.classList.contains("mm-source-button")
                ? "source"
                : "other",
          ),
      };
    });
    const expectedForeground = `rgb(${[1, 3, 5]
      .map((offset) => parseInt(foreground.slice(offset, offset + 2), 16))
      .join(", ")})`;
    assert.equal(
      appearance.visible,
      true,
      `${theme} Copilot toolbar visibility`,
    );
    assert.equal(
      appearance.buttonColor,
      expectedForeground,
      `${theme} toolbar color`,
    );
    assert.equal(
      appearance.iconFill,
      expectedForeground,
      `${theme} icon color`,
    );
    assert.deepEqual(
      appearance.following,
      ["export", "source"],
      `${theme} toolbar order`,
    );
  }
  console.log(
    "Passed Copilot icon contrast and placement in dark and light themes",
  );

  for (const [filename, profile] of [
    ["common-test.md", "commonmark"],
    ["github-test.md", "github"],
    ["github-test-class-B.md", "github"],
    ["gitlab-test.md", "gitlab"],
    ["gitlab-test-class-B.md", "gitlab"],
  ]) {
    await load(await readFile(resolve("tests/md", filename), "utf8"), profile);
    const layout = await page.evaluate(() => {
      const primary = document.querySelector(".mm-toolbar-primary");
      const elements = Array.from(primary?.children ?? []);
      const compatibility = elements.findIndex((element) =>
        element.matches(".mm-compatibility"),
      );
      const copilot = elements.findIndex((element) =>
        element.matches("[data-testid='toolbar-copilot']"),
      );
      const exportMenu = elements.findIndex((element) =>
        element.matches(".mm-export-menu"),
      );
      const source = elements.findIndex((element) =>
        element.matches(".mm-source-button"),
      );
      const button = elements[copilot];
      const box = button?.getBoundingClientRect();
      return {
        width:
          document.querySelector(".ProseMirror")?.getBoundingClientRect()
            .width ?? 0,
        order: [compatibility, copilot, exportMenu, source],
        buttonWidth: box?.width ?? 0,
        buttonHeight: box?.height ?? 0,
        icon: button?.querySelector("svg")?.dataset.icon,
      };
    });
    assert.ok(layout.width > 200, `${filename}: rich document is visible`);
    assert.ok(
      layout.buttonWidth >= 28,
      `${filename}: Copilot button is visible`,
    );
    assert.ok(
      layout.buttonHeight >= 28,
      `${filename}: Copilot button is visible`,
    );
    assert.ok(
      layout.order[0] < layout.order[1] &&
        layout.order[1] < layout.order[2] &&
        layout.order[2] < layout.order[3],
      `${filename}: compatibility/Copilot/Export/Source order`,
    );
    assert.equal(layout.icon, "copilot", `${filename}: default enabled icon`);
    console.log(`Passed Copilot toolbar fixture layout: ${filename}`);
  }
  await load();
  const initial = await page.evaluate(() => ({
    document: window.__markdownMintHarness.document,
    state: window.__markdownMintHarness.state,
    edits: window.__markdownMintHarness.messages.filter(
      (message) => message.type === "edit",
    ).length,
  }));
  await trigger();
  const shown = await page.evaluate(() => ({
    document: window.__markdownMintHarness.document,
    state: window.__markdownMintHarness.state,
    edits: window.__markdownMintHarness.messages.filter(
      (message) => message.type === "edit",
    ).length,
  }));
  assert.deepEqual(
    shown,
    initial,
    "ghost display cannot change document, recovery, or edit count",
  );
  assert.equal(
    await page.locator(".mm-ai-suggestion").getAttribute("contenteditable"),
    "false",
  );
  await page.keyboard.press("Tab");
  await page.waitForFunction(() => !window.markdownMint.sync.hasPending);
  assert.equal(await source(), "日本語の文章 続きを書きます🌿");
  await page.keyboard.press(`${modifier}+z`);
  await page.waitForFunction(
    () => window.__markdownMintHarness.document.markdown === "日本語の文章",
  );
  await page.keyboard.press(`${modifier}+Shift+z`);
  await page.waitForFunction(() =>
    window.__markdownMintHarness.document.markdown.includes("続きを書きます"),
  );
  console.log("Passed ghost integrity, Tab, and browser host Undo/Redo");

  await load("English prose");
  await trigger(" next words");
  await page.keyboard.press(`${modifier}+a`);
  await page.keyboard.press(`${modifier}+c`);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(copied.includes("English prose"));
  assert.ok(!copied.includes("next words"));
  await page.keyboard.press(`${modifier}+x`);
  assert.ok(!(await source()).includes("next words"));
  assert.ok(
    !(await page.evaluate(() => navigator.clipboard.readText())).includes(
      "next words",
    ),
  );
  console.log("Passed real keyboard copy, select-all copy, and cut exclusion");

  await load("English prose");
  await page.evaluate(() =>
    window.__markdownMintHarness.setAiState({ autoTrigger: true }),
  );
  await page.keyboard.type("!");
  await page.waitForFunction(() =>
    window.__markdownMintHarness.messages.some(
      (message) =>
        message.type === "ai-suggestion-request" && message.trigger === "auto",
    ),
  );
  const request = (await requests()).at(-1);
  await page.keyboard.press("Escape");
  await page.evaluate(
    (request) =>
      window.__markdownMintHarness.respondAi(request, " late result"),
    request,
  );
  assert.equal(await page.locator(".mm-ai-suggestion").count(), 0);
  await page.waitForTimeout(2100);
  assert.equal((await requests()).length, 1);
  await trigger(" manual result");
  await page.evaluate(() =>
    window.__markdownMintHarness.setAiState({ autoTrigger: false }),
  );
  assert.equal(
    await page.locator(".mm-ai-suggestion").count(),
    1,
    "manual candidate survives auto-off",
  );
  await page.keyboard.press("Escape");
  console.log(
    "Passed native typing debounce, Escape suppression, and manual-with-auto-off",
  );

  for (const [name, sourceText] of [
    ["paragraph", "Hello"],
    ["heading", "# Hello"],
    ["list", "- Hello"],
    ["task", "- [ ] Hello"],
  ]) {
    await load(sourceText);
    await trigger(" world");
    await page.keyboard.press("Tab");
    assert.ok((await source()).includes("Hello world"), name);
  }
  for (const sourceText of [
    "`code`",
    "| A |\n|---|\n| B |",
    "```ts\nvalue\n```",
    "",
    "<details>\n<summary>T</summary>\n\nBody\n\n</details>",
  ]) {
    await load(sourceText);
    await page.evaluate(() => window.__markdownMintHarness.triggerAi());
    await page.waitForTimeout(60);
    assert.equal((await requests()).length, 0, sourceText);
  }
  console.log("Passed eligible and excluded editing targets");

  await load("[link](https://example.com)");
  await placeCaretAtText("link", 2);
  await trigger(" text");
  await page.keyboard.press("Tab");
  await page.waitForFunction(() => !window.markdownMint.sync.hasPending);
  assert.equal(
    await source(),
    "[li textnk](https://example.com)",
    "link-label completion preserves the existing destination",
  );

  await load("Hello world");
  await placeCaretAtText("Hello world", 6);
  await trigger("wonderful ");
  assert.equal(
    await page.locator(".mm-ai-suggestion").textContent(),
    "wonderful ",
  );
  await page.keyboard.press("Tab");
  await page.waitForFunction(() => !window.markdownMint.sync.hasPending);
  assert.equal(
    await source(),
    "Hello wonderful world",
    "midline completion preserves the existing suffix",
  );

  const linkedParagraph = "Read [the docs](https://example.test) today.";
  await load(linkedParagraph);
  await placeCaretAtText("Read ", 5);
  await trigger("more about ");
  await page.keyboard.press("Tab");
  await page.waitForFunction(() => !window.markdownMint.sync.hasPending);
  const linkedSource = await source();
  assert.equal(
    await page.evaluate(() => window.markdownMint.view.state.doc.textContent),
    "Read more about the docs today.",
    "prose adjacent to a link stays eligible and keeps the surrounding text",
  );
  assert.ok(
    linkedSource.includes("[the docs](https://example.test)"),
    "prose adjacent to a link retains its destination",
  );
  console.log(
    "Passed midline suffix preservation and prose next to a Markdown link",
  );

  const palettes = [
    ["light", "#ffffff", "#333333", "#6a737d"],
    ["dark", "#1e1e1e", "#d4d4d4", "#a1a1a1"],
    ["high-contrast", "#000000", "#ffffff", "#ffffff"],
  ];
  for (const [name, background, foreground, ghost] of palettes) {
    await load("日本語の文章が折り返す幅でも続きを表示します。".repeat(5));
    await page.setViewportSize({ width: 520, height: 800 });
    await page.evaluate(
      ([name, background, foreground, ghost]) => {
        const root = document.documentElement;
        root.className = `vscode-${name}`;
        document.body.className = `vscode-${name}`;
        for (const [key, value] of [
          ["--vscode-editor-background", background],
          ["--vscode-editor-foreground", foreground],
          ["--vscode-foreground", foreground],
          ["--vscode-editorGhostText-foreground", ghost],
          ["--vscode-descriptionForeground", ghost],
          [
            "--vscode-editorGhostText-border",
            name === "high-contrast" ? foreground : "transparent",
          ],
        ])
          root.style.setProperty(key, value);
      },
      [name, background, foreground, ghost],
    );
    await trigger();
    const colors = await page.evaluate(() => ({
      background: getComputedStyle(document.body).backgroundColor,
      prose: getComputedStyle(window.markdownMint.view.dom).color,
      ghost: getComputedStyle(document.querySelector(".mm-ai-suggestion"))
        .color,
    }));
    const rgb = (hex) =>
      `rgb(${[1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)).join(", ")})`;
    assert.deepEqual(
      colors,
      {
        background: rgb(background),
        prose: rgb(foreground),
        ghost: rgb(ghost),
      },
      name,
    );
    const geometry = await page.locator(".mm-ai-suggestion").boundingBox();
    assert.ok(geometry && geometry.width > 0 && geometry.height > 0, name);
    await page.screenshot({
      path: resolve(output, `${name}.png`),
      fullPage: true,
    });
    const textBefore = await source();
    await page.evaluate(() => window.markdownMint.setMode("preview", false));
    assert.equal(await page.locator(".mm-ai-suggestion").count(), 0);
    assert.equal(await source(), textBefore);
    assert.ok(
      !(await page.locator(".mm-preview-panel").textContent()).includes(
        "続きを書きます🌿",
      ),
    );
  }
  console.log("Passed light/dark/high-contrast wrapping and preview exclusion");
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        model: "fake",
        realCopilotRequests: 0,
        groups: 5,
        clipboard: "real Chromium keyboard",
        themes: palettes.map(([name]) => name),
        nativeIme: "manual",
        fixtures: [
          "common-test.md",
          "github-test.md",
          "github-test-class-B.md",
          "gitlab-test.md",
          "gitlab-test-class-B.md",
        ],
      },
      null,
      2,
    ) + "\n",
  );
} catch (error) {
  await page
    ?.screenshot({ path: resolve(output, "failure.png"), fullPage: true })
    .catch(() => undefined);
  throw error;
} finally {
  await browser?.close();
  server.kill("SIGINT");
}
