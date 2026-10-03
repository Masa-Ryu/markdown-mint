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
  assert.equal(await result.getAttribute("aria-busy"), "false");
  const status = result.locator(".mm-mermaid-preview-status");
  assert.equal(
    await status.isVisible(),
    false,
    "normal preview status is visible",
  );
  assert.equal(
    await status.textContent(),
    "",
    "normal preview status has text",
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

function contrastRatio(foreground, background) {
  const luminance = (value) => {
    const channels = value
      .match(/^rgba?\(([^)]+)\)$/)?.[1]
      ?.split(",")
      .slice(0, 3)
      .map((channel) => Number.parseFloat(channel.trim()) / 255);
    assert.ok(channels?.length === 3, "unrecognized computed color: " + value);
    const linear = channels.map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

async function assertGitGraphPresentation(locator, label) {
  const presentation = await locator
    .locator('svg[aria-roledescription="gitGraph"]')
    .evaluate((svg) => {
      const box = (element) => {
        const value = element.getBBox();
        return {
          x: value.x,
          y: value.y,
          width: value.width,
          height: value.height,
        };
      };
      const paint = (element) => {
        const style = getComputedStyle(element);
        return {
          fill: style.fill,
          stroke: style.stroke,
          strokeWidth: style.strokeWidth,
          strokeOpacity: style.strokeOpacity,
          box: box(element),
        };
      };
      const textPaint = (element) => ({
        text: element.textContent.trim(),
        fill: getComputedStyle(element).fill,
        box: box(element),
      });
      const branches = Array.from(svg.querySelectorAll(".branch"), paint);
      const arrows = Array.from(svg.querySelectorAll("path.arrow"), (path) => ({
        className: path.getAttribute("class"),
        ...paint(path),
      }));
      const mainCommit = svg.querySelector(
        "circle.commit.commit0:not(.commit-merge)",
      );
      const featureCommit = svg.querySelector("circle.commit.Change.commit1");
      const mergeOuter = svg.querySelector(
        "circle.commit.Merge:not(.commit-merge)",
      );
      const mergeInner = svg.querySelector("circle.commit-merge.Merge");
      const branchBackgrounds = Array.from(
        svg.querySelectorAll("rect.branchLabelBkg"),
      );
      const branchTexts = Array.from(svg.querySelectorAll(".branchLabel text"));
      const commitLabelBackgrounds = Array.from(
        svg.querySelectorAll("rect.commit-label-bkg"),
      );
      const commitLabelPairs = commitLabelBackgrounds.map((background) => ({
        background: getComputedStyle(background).fill,
        text: textPaint(
          background.parentElement.querySelector("text.commit-label"),
        ),
      }));
      const branchLabelPairs = branchBackgrounds.map((background, index) => ({
        background: getComputedStyle(background).fill,
        text: textPaint(branchTexts[index]),
      }));
      const commitsByBranch = [0, 1].map((index) => ({
        index,
        commit: paint(
          svg.querySelector(
            "circle.commit.commit" + index + ":not(.commit-merge)",
          ),
        ),
        arrow: paint(svg.querySelector("path.arrow.arrow" + index)),
      }));
      return {
        role: svg.getAttribute("aria-roledescription"),
        branchLabels: Array.from(
          svg.querySelectorAll(".branchLabel tspan"),
          (node) => node.textContent.trim(),
        ),
        branches,
        arrows,
        mainCommit: mainCommit ? paint(mainCommit) : null,
        featureCommit: featureCommit ? paint(featureCommit) : null,
        merge:
          mergeOuter && mergeInner
            ? {
                outer: {
                  ...paint(mergeOuter),
                  radius: mergeOuter.getAttribute("r"),
                },
                inner: {
                  ...paint(mergeInner),
                  radius: mergeInner.getAttribute("r"),
                },
                sameCenter:
                  mergeOuter.getAttribute("cx") ===
                    mergeInner.getAttribute("cx") &&
                  mergeOuter.getAttribute("cy") ===
                    mergeInner.getAttribute("cy"),
              }
            : null,
        labelPairs: [...branchLabelPairs, ...commitLabelPairs].map((pair) => ({
          text: pair.text.text,
          foreground: pair.text.fill,
          background: pair.background,
          box: pair.text.box,
        })),
        commitsByBranch,
      };
    });

  assert.equal(presentation.role, "gitGraph", label + ": wrong diagram role");
  assert.ok(presentation.arrows.length > 0, label + ": no Git graph arrows");
  for (const arrow of presentation.arrows) {
    assert.equal(
      arrow.fill,
      "none",
      label + ": " + arrow.className + " is filled",
    );
    assert.notEqual(arrow.stroke, "none", label + ": arrow has no stroke");
    assert.ok(
      Number(arrow.strokeOpacity) > 0,
      label + ": arrow is transparent",
    );
    assert.equal(arrow.strokeWidth, "8px", label + ": wrong arrow width");
    assert.ok(
      arrow.box.width > 0 || arrow.box.height > 0,
      label + ": arrow has no visible geometry",
    );
  }
  assert.ok(presentation.branches.length > 0, label + ": no branch lines");
  for (const branch of presentation.branches) {
    assert.notEqual(branch.stroke, "none", label + ": branch has no stroke");
    assert.equal(branch.strokeWidth, "1px", label + ": wrong branch width");
  }
  assert.ok(
    presentation.branchLabels.includes("main"),
    label + ": no main label",
  );
  assert.ok(
    presentation.branchLabels.includes("feature"),
    label + ": no feature label",
  );
  for (const commit of [presentation.mainCommit, presentation.featureCommit]) {
    assert.ok(commit, label + ": missing main or feature commit");
    assert.notEqual(commit.fill, "none", label + ": commit has no fill");
    assert.notEqual(commit.stroke, "none", label + ": commit has no outline");
    assert.ok(commit.box.width > 0, label + ": commit has no visible geometry");
  }
  assert.ok(presentation.merge, label + ": missing merge commit circles");
  assert.equal(
    presentation.merge.sameCenter,
    true,
    label + ": merge circles shifted",
  );
  assert.ok(
    Number(presentation.merge.outer.radius) >
      Number(presentation.merge.inner.radius),
    label + ": merge rings are not distinct",
  );
  assert.notEqual(
    presentation.merge.outer.fill,
    presentation.merge.inner.fill,
    label + ": merge inner and outer circles have the same fill",
  );
  assert.ok(
    presentation.labelPairs.length >= 6,
    label + ": label backgrounds missing",
  );
  for (const pair of presentation.labelPairs) {
    assert.ok(
      pair.box.width > 0 && pair.box.height > 0,
      label + ": hidden " + pair.text,
    );
    assert.ok(
      contrastRatio(pair.foreground, pair.background) >= 4.5,
      label +
        ": low contrast for " +
        pair.text +
        ": " +
        pair.foreground +
        " on " +
        pair.background,
    );
  }
  for (const pair of presentation.commitsByBranch) {
    assert.equal(
      pair.commit.fill,
      pair.arrow.stroke,
      label + ": branch " + pair.index + " commit and connector colors differ",
    );
  }
}

async function assertOtherDiagramPaint(locator, templateId, label) {
  const presentation = await locator.locator("svg").evaluate((svg) => {
    const paint = (element) => {
      const style = getComputedStyle(element);
      const box = element.getBBox();
      return {
        fill: style.fill,
        fillOpacity: style.fillOpacity,
        stroke: style.stroke,
        strokeOpacity: style.strokeOpacity,
        strokeWidth: style.strokeWidth,
        box: { width: box.width, height: box.height },
      };
    };
    const role = svg.getAttribute("aria-roledescription");
    if (role === "flowchart-v2") {
      return {
        role,
        edges: Array.from(svg.querySelectorAll(".flowchart-link"), paint),
        markers: Array.from(
          svg.querySelectorAll("marker path, .marker path, .arrowheadPath"),
          paint,
        ),
      };
    }
    if (role === "sequence") {
      return {
        role,
        edges: Array.from(
          svg.querySelectorAll(".messageLine0, .messageLine1"),
          paint,
        ),
      };
    }
    if (role === "pie") {
      return {
        role,
        slices: Array.from(svg.querySelectorAll("path.pieCircle"), paint),
      };
    }
    return { role };
  });
  const isPainted = (paint) =>
    paint !== "none" &&
    !/^rgba\([^,]+,\s*[^,]+,\s*[^,]+,\s*0(?:\.0+)?\)$/.test(paint);

  if (templateId.startsWith("flowchart-")) {
    assert.equal(
      presentation.role,
      "flowchart-v2",
      label + ": wrong flowchart role",
    );
    assert.ok(
      presentation.edges.length > 0,
      label + ": no flowchart connectors",
    );
    for (const edge of presentation.edges) {
      assert.equal(edge.fill, "none", label + ": filled flowchart connector");
      assert.ok(
        isPainted(edge.stroke),
        label + ": invisible flowchart connector",
      );
      assert.ok(
        Number.parseFloat(edge.strokeWidth) > 0,
        label + ": zero-width connector",
      );
    }
    assert.ok(
      presentation.markers.length > 0,
      label + ": no flowchart arrowheads",
    );
    for (const marker of presentation.markers) {
      assert.ok(
        isPainted(marker.fill),
        label + ": invisible flowchart arrowhead",
      );
      assert.ok(
        Number(marker.fillOpacity) > 0,
        label + ": transparent flowchart arrowhead",
      );
    }
  } else if (templateId.startsWith("sequence-")) {
    assert.equal(
      presentation.role,
      "sequence",
      label + ": wrong sequence role",
    );
    assert.ok(
      presentation.edges.length > 0,
      label + ": no sequence connectors",
    );
    for (const edge of presentation.edges) {
      assert.equal(edge.fill, "none", label + ": filled sequence connector");
      assert.ok(
        isPainted(edge.stroke),
        label + ": invisible sequence connector",
      );
      assert.ok(
        Number.parseFloat(edge.strokeWidth) > 0,
        label + ": zero-width connector",
      );
      assert.ok(
        edge.box.width > 0 || edge.box.height > 0,
        label + ": sequence connector has no geometry",
      );
    }
  } else if (templateId === "pie-composition") {
    assert.equal(presentation.role, "pie", label + ": wrong pie role");
    assert.ok(presentation.slices.length >= 3, label + ": pie slices missing");
    const fills = new Set();
    for (const slice of presentation.slices) {
      assert.ok(isPainted(slice.fill), label + ": pie slice has no fill");
      assert.ok(
        Number(slice.fillOpacity) > 0,
        label + ": transparent pie slice",
      );
      fills.add(slice.fill);
    }
    assert.ok(
      fills.size > 1,
      label + ": pie slices have collapsed to one fill",
    );
  }
}

async function expectFooter(
  dialog,
  screen,
  helper = null,
  confirmation = null,
  primary = screen === "editor" ? "Insert diagram" : "Next: Edit code",
) {
  assert.equal(
    await dialog.locator("h2").textContent(),
    screen === "picker" ? "Choose a Mermaid template" : "Edit Mermaid",
  );
  assert.equal(
    await dialog.locator(".mm-mermaid-template-picker").isVisible(),
    screen === "picker",
  );
  assert.equal(
    await dialog.locator(".mm-mermaid-replacement-confirmation button").count(),
    0,
  );
  assert.equal(
    await dialog.locator(".mm-mermaid-preview-slot button:visible").count(),
    0,
  );
  assert.equal(
    (await dialog.locator(".mm-mermaid-primary:visible").count()) +
      (await dialog.locator('button[type="submit"]:visible').count()),
    1,
    "each state must have one primary action",
  );
  assert.equal(
    await dialog
      .getByRole("button", { name: "Use this template", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await dialog
      .getByRole("button", { name: "Create from code", exact: true })
      .count(),
    0,
  );
  assert.deepEqual(
    await dialog
      .locator(".mm-mermaid-footer-main-actions button:visible")
      .allTextContents(),
    confirmation
      ? ["Cancel", confirmation]
      : screen === "picker"
        ? ["Cancel", "Next: Edit code"]
        : ["Cancel", primary],
  );
  const primaryBackground = await dialog
    .locator(
      ".mm-mermaid-primary:visible, .mm-mermaid-footer-main-actions button[type=submit]:visible",
    )
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  const cancelBackground = await dialog
    .getByRole("button", { name: "Cancel", exact: true })
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  assert.notEqual(
    primaryBackground,
    cancelBackground,
    "the primary action should use the prominent theme button color",
  );
  const helperButton = dialog.locator(".mm-mermaid-footer-helper");
  assert.equal(await helperButton.isVisible(), Boolean(helper));
  if (helper) assert.equal(await helperButton.textContent(), helper);
  if (!helper) {
    const footerBox = await dialog.locator(".mm-mermaid-footer").boundingBox();
    const actionsBox = await dialog
      .locator(".mm-mermaid-footer-main-actions")
      .boundingBox();
    assert.ok(footerBox && actionsBox);
    assert.ok(
      Math.abs(
        footerBox.x + footerBox.width - actionsBox.x - actionsBox.width,
      ) <= 1,
      "the editor actions must stay right-aligned in the common footer",
    );
  }
}

async function catalogChecks(page, templates, buildSource) {
  const results = [];
  let capturedInitial = false;
  let capturedNewEditor = false;
  let capturedExistingEditor = false;
  for (const template of templates) {
    for (const direction of template.directions ?? [undefined]) {
      await load(page);
      const count = await edits(page);
      const dialog = await open(page);
      await expectFooter(dialog, "picker");
      if (!capturedInitial) {
        await preview(page);
        await page.screenshot({
          path: resolve(output, "initial-picker.png"),
        });
        capturedInitial = true;
      }
      await dialog.locator(`[data-template-id="${template.id}"]`).click();
      if (direction)
        await dialog.getByLabel("Template direction").selectOption(direction);
      await visibleLabels(
        await preview(page),
        labels[template.id],
        `${template.id} ${direction ?? ""}`,
      );
      if (
        template.id.startsWith("flowchart-") ||
        template.id.startsWith("sequence-") ||
        template.id === "pie-composition"
      ) {
        await assertOtherDiagramPaint(
          dialog.locator(".mm-mermaid-preview"),
          template.id,
          "candidate preview",
        );
      }
      if (template.id === "gitgraph-branch-merge") {
        const graphPreview = dialog.locator(".mm-mermaid-preview");
        await assertGitGraphPresentation(graphPreview, "candidate preview");
        await graphPreview.screenshot({
          path: resolve(output, "gitgraph-candidate.png"),
        });
      }
      assert.equal(
        await edits(page),
        count,
        "candidate preview changed document",
      );
      assert.equal(
        await dialog.locator(sourceSelector).inputValue(),
        "flowchart TD\n    A[Start] --> B[End]",
        "changing a candidate changed the editing draft",
      );
      await dialog
        .getByRole("button", { name: "Next: Edit code", exact: true })
        .click();
      await expectFooter(dialog, "editor");
      assert.equal(await edits(page), count, "Next edited the document");
      const input = dialog.locator(sourceSelector);
      assert.equal(
        await input.inputValue(),
        buildSource(template.id, { direction }),
      );
      const codePreview = await preview(page);
      await visibleLabels(codePreview, labels[template.id], "draft");
      if (template.id === "gitgraph-branch-merge") {
        await assertGitGraphPresentation(codePreview, "applied code preview");
        await codePreview.screenshot({
          path: resolve(output, "gitgraph-code-editor.png"),
        });
      }
      if (!capturedNewEditor) {
        await page.screenshot({ path: resolve(output, "new-editor.png") });
        capturedNewEditor = true;
      }
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
      await dialog
        .getByRole("button", { name: "Insert diagram", exact: true })
        .click();
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
      if (template.id === "gitgraph-branch-merge") {
        await assertGitGraphPresentation(rendered, "inserted document");
        await rendered.screenshot({
          path: resolve(output, "gitgraph-document.png"),
        });
      }
      await rendered.dblclick();
      assert.equal(
        await page.locator(`${dialogSelector} ${sourceSelector}`).inputValue(),
        unicodeSource,
      );
      await expectFooter(
        page.locator(dialogSelector),
        "editor",
        null,
        null,
        "Update diagram",
      );
      const reopenedPreview = await preview(page);
      if (template.id === "gitgraph-branch-merge") {
        await assertGitGraphPresentation(
          reopenedPreview,
          "existing diagram editor",
        );
        await reopenedPreview.screenshot({
          path: resolve(output, "gitgraph-existing-editor.png"),
        });
      }
      if (!capturedExistingEditor) {
        await page.screenshot({
          path: resolve(output, "existing-editor.png"),
        });
        capturedExistingEditor = true;
      }
      assert.equal(
        await page
          .locator(`${dialogSelector} .mm-mermaid-template-picker`)
          .isVisible(),
        false,
      );
      await preview(page);
      await page
        .locator(dialogSelector)
        .getByRole("button", { name: "Update diagram", exact: true })
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

async function pickerUxChecks(page) {
  await load(page);
  const dialog = await open(page);
  const list = dialog.getByRole("listbox");
  const previewElement = dialog.locator(".mm-mermaid-preview");
  const status = previewElement.locator(".mm-mermaid-preview-status");
  assert.equal(
    await previewElement.getAttribute("data-preview-state"),
    "checking",
  );
  assert.equal(await previewElement.getAttribute("aria-busy"), "true");
  assert.equal(await status.isVisible(), false);
  assert.equal(await status.textContent(), "");
  await preview(page);

  await list.evaluate((element) => {
    element.style.height = "160px";
    element.style.maxHeight = "160px";
    element.style.alignSelf = "start";
  });
  const listMetrics = await list.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  assert.ok(
    listMetrics.scrollHeight > listMetrics.clientHeight,
    `template list should scroll: ${JSON.stringify(listMetrics)}`,
  );
  const outsideScroll = await dialog.evaluate((element) => {
    const form = element.querySelector(".mm-dialog-form");
    const workspace = element.querySelector(".mm-mermaid-workspace");
    return [
      element.scrollTop,
      form?.scrollTop ?? 0,
      workspace?.scrollTop ?? 0,
      window.scrollY,
      document.scrollingElement?.scrollTop ?? 0,
    ];
  });

  await list.press("End");
  assert.equal(
    await previewElement.getAttribute("data-preview-state"),
    "checking",
  );
  assert.equal(await previewElement.getAttribute("aria-busy"), "true");
  assert.equal(await status.isVisible(), false);
  await preview(page);
  assert.equal(
    await list
      .locator('[aria-selected="true"]')
      .getAttribute("data-template-id"),
    "gitgraph-branch-merge",
  );
  const listScrollAtEnd = await list.evaluate((element) => element.scrollTop);
  assert.ok(listScrollAtEnd > 0, "End did not scroll the template list");
  for (let index = 0; index < 3; index++) await list.press("ArrowDown");
  assert.equal(
    await list
      .locator('[aria-selected="true"]')
      .getAttribute("data-template-id"),
    "gitgraph-branch-merge",
  );
  assert.equal(
    await previewElement.getAttribute("data-preview-state"),
    "rendered",
    "ArrowDown at the last item restarted the preview",
  );
  assert.equal(await previewElement.locator("svg").count(), 1);
  assert.equal(await status.isVisible(), false);
  assert.equal(
    await list.evaluate((element) => element.scrollTop),
    listScrollAtEnd,
  );
  assert.deepEqual(
    await dialog.evaluate((element) => {
      const form = element.querySelector(".mm-dialog-form");
      const workspace = element.querySelector(".mm-mermaid-workspace");
      return [
        element.scrollTop,
        form?.scrollTop ?? 0,
        workspace?.scrollTop ?? 0,
        window.scrollY,
        document.scrollingElement?.scrollTop ?? 0,
      ];
    }),
    outsideScroll,
  );

  await list.press("Home");
  await preview(page);
  assert.equal(
    await list
      .locator('[aria-selected="true"]')
      .getAttribute("data-template-id"),
    "flowchart-basic",
  );
  const listScrollAtStart = await list.evaluate((element) => element.scrollTop);
  for (let index = 0; index < 3; index++) await list.press("ArrowUp");
  assert.equal(
    await list
      .locator('[aria-selected="true"]')
      .getAttribute("data-template-id"),
    "flowchart-basic",
  );
  assert.equal(
    await previewElement.getAttribute("data-preview-state"),
    "rendered",
    "ArrowUp at the first item restarted the preview",
  );
  assert.equal(await previewElement.locator("svg").count(), 1);
  assert.equal(
    await list.evaluate((element) => element.scrollTop),
    listScrollAtStart,
  );
  assert.deepEqual(
    await dialog.evaluate((element) => {
      const form = element.querySelector(".mm-dialog-form");
      const workspace = element.querySelector(".mm-mermaid-workspace");
      return [
        element.scrollTop,
        form?.scrollTop ?? 0,
        workspace?.scrollTop ?? 0,
        window.scrollY,
        document.scrollingElement?.scrollTop ?? 0,
      ];
    }),
    outsideScroll,
  );

  await dialog
    .getByRole("button", { name: "Next: Edit code", exact: true })
    .click();
  await preview(page);
  const input = dialog.locator(sourceSelector);
  const gateInstalled = await page.evaluate(() => {
    const runtime =
      window.markdownMintMermaid ?? window.mermaid ?? window.mermaidRuntime;
    if (!runtime || typeof runtime.render !== "function") return false;
    const original = runtime.render;
    window.__mmOriginalMermaidRender = original;
    window.__mmMermaidRenderRuntime = runtime;
    window.__mmMermaidRenderGateArmed = true;
    runtime.render = async (...args) => {
      if (window.__mmMermaidRenderGateArmed) {
        window.__mmMermaidRenderGateArmed = false;
        await new Promise((resolve) => {
          window.__mmReleaseMermaidRender = resolve;
        });
      }
      return original.apply(runtime, args);
    };
    return true;
  });
  assert.equal(
    gateInstalled,
    true,
    "could not gate the bundled Mermaid renderer",
  );
  await input.fill("flowchart TD\n    A[Render gate] --> B[Done]");
  await page.waitForFunction(
    () => typeof window.__mmReleaseMermaidRender === "function",
  );
  assert.equal(
    await previewElement.getAttribute("data-preview-state"),
    "rendering",
  );
  assert.equal(await previewElement.getAttribute("aria-busy"), "true");
  assert.equal(await status.isVisible(), false);
  assert.equal(await status.textContent(), "");
  await page.evaluate(() => window.__mmReleaseMermaidRender());
  await preview(page);
  await page.evaluate(() => {
    window.__mmMermaidRenderRuntime.render = window.__mmOriginalMermaidRender;
    delete window.__mmOriginalMermaidRender;
    delete window.__mmMermaidRenderRuntime;
    delete window.__mmReleaseMermaidRender;
  });

  await input.fill("flowchart TD\n    A -->");
  assert.equal(await previewElement.getAttribute("aria-busy"), "true");
  assert.equal(await status.isVisible(), false);
  await page.waitForFunction(
    (selector) =>
      document.querySelector(selector)?.getAttribute("data-preview-state") ===
      "invalid",
    ".mm-mermaid-preview",
  );
  assert.equal(await previewElement.getAttribute("aria-busy"), "false");
  assert.equal(await status.isVisible(), true);
  assert.match(await status.textContent(), /syntax|parse|invalid/i);

  await input.fill("");
  assert.equal(await previewElement.getAttribute("aria-busy"), "false");
  await page.waitForFunction(
    (selector) =>
      document.querySelector(selector)?.getAttribute("data-preview-state") ===
      "empty",
    ".mm-mermaid-preview",
  );
  assert.equal(await previewElement.getAttribute("aria-busy"), "false");
  assert.equal(await status.isVisible(), true);
  assert.equal(
    await status.textContent(),
    "Enter Mermaid code to see a preview.",
  );
  console.log(
    "Passed picker boundaries, list-only scrolling, and preview busy/error states",
  );
}

async function interactionChecks(page) {
  await load(page);
  const before = await saved(page);
  const count = await edits(page);
  let dialog = await open(page);
  await expectFooter(dialog, "picker");
  await preview(page);
  await page.screenshot({ path: resolve(output, "initial-picker.png") });
  let list = dialog.getByRole("listbox");
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
  const source = dialog.locator(sourceSelector);
  const originalDraft = await source.inputValue();
  await dialog.locator("form").evaluate((form) => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
  assert.equal(await saved(page), before, "direct picker submit wrote a draft");
  await expectFooter(dialog, "picker");
  await list.press("Tab");
  assert.equal(
    await dialog
      .getByLabel("Template direction")
      .evaluate((element) => document.activeElement === element),
    true,
  );
  await page.keyboard.press("Tab");
  assert.equal(
    await dialog
      .getByRole("button", { name: "Cancel", exact: true })
      .evaluate((element) => document.activeElement === element),
    true,
  );
  await page.keyboard.press("Tab");
  assert.equal(
    await dialog
      .getByRole("button", { name: "Next: Edit code", exact: true })
      .evaluate((element) => document.activeElement === element),
    true,
    "picker Tab order should skip the hidden submit button",
  );
  await dialog.locator('[data-template-id="gitgraph-branch-merge"]').click();
  assert.equal(await source.inputValue(), originalDraft);
  assert.equal(await saved(page), before);
  assert.equal(await edits(page), count);
  await dialog.locator('[data-template-id="flowchart-basic"]').click();
  await dialog
    .getByRole("button", { name: "Next: Edit code", exact: true })
    .click();
  await expectFooter(dialog, "editor");
  let input = dialog.locator(sourceSelector);
  assert.equal(
    await input.inputValue(),
    buildMermaidTemplateSource("flowchart-basic"),
    "Next: Edit code did not open the selected default candidate",
  );
  assert.equal(await edits(page), count);
  await preview(page);
  await page.screenshot({ path: resolve(output, "new-editor.png") });
  await page.keyboard.press("Escape");
  await page
    .locator(".mm-discard-changes-dialog")
    .getByRole("button", { name: "Discard", exact: true })
    .click();
  assert.equal(await page.locator(dialogSelector).count(), 0);
  assert.equal(
    await page
      .locator('button[data-profile-feature="mermaid"]')
      .evaluate((element) => document.activeElement === element),
    true,
  );
  assert.equal(await saved(page), before);

  dialog = await open(page);
  list = dialog.getByRole("listbox");
  await list.press("ArrowDown");
  const next = dialog.getByRole("button", {
    name: "Next: Edit code",
    exact: true,
  });
  assert.equal(await next.isEnabled(), true);
  await next.focus();
  await page.keyboard.press("Space");
  await expectFooter(dialog, "editor");
  assert.equal(await edits(page), count, "Next: Edit code submitted the form");
  input = dialog.locator(sourceSelector);
  assert.equal(
    await input.inputValue(),
    buildMermaidTemplateSource("flowchart-decision"),
    "Next: Edit code did not use the selected candidate",
  );
  await preview(page);
  await page.screenshot({ path: resolve(output, "new-editor.png") });
  await dialog.getByRole("button", { name: "Templates", exact: true }).click();
  await expectFooter(dialog, "picker", "Back to code");
  await preview(page);
  await page.screenshot({ path: resolve(output, "revisit-picker.png") });
  await dialog.locator('[data-template-id="gitgraph-branch-merge"]').click();
  await dialog
    .getByRole("button", { name: "Back to code", exact: true })
    .click();
  await expectFooter(dialog, "editor");
  assert.equal(
    await input.inputValue(),
    buildMermaidTemplateSource("flowchart-decision"),
    "Back to code applied the unconfirmed candidate",
  );
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
  await expectFooter(dialog, "picker", "Back to code");
  await preview(page);
  await page.screenshot({ path: resolve(output, "revisit-picker.png") });
  await dialog.locator('[data-template-id="gantt-project"]').click();
  assert.equal(await input.inputValue(), original);
  await dialog
    .getByRole("button", { name: "Next: Edit code", exact: true })
    .click();
  await expectFooter(dialog, "picker", "Keep current code", "Replace and edit");
  await page.screenshot({
    path: resolve(output, "replacement-confirmation.png"),
  });
  await dialog.locator("form").evaluate((form) => form.requestSubmit());
  assert.equal(
    await dialog.locator(".mm-mermaid-replacement-confirmation").isVisible(),
    true,
  );
  assert.equal(await input.inputValue(), original);
  assert.equal(await saved(page), before);
  assert.equal(await edits(page), count, "confirmation submit wrote a draft");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .locator(".mm-discard-changes-dialog")
    .getByRole("button", { name: "Keep editing", exact: true })
    .click();
  assert.equal(
    await dialog.locator(".mm-mermaid-replacement-confirmation").isVisible(),
    true,
    "Cancel skipped the standard discard-change confirmation",
  );
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
    .getByRole("button", { name: "Next: Edit code", exact: true })
    .click();
  await expectFooter(dialog, "picker", "Keep current code", "Replace and edit");
  assert.equal(
    await dialog
      .getByRole("button", { name: "Replace and edit", exact: true })
      .evaluate((element) => document.activeElement === element),
    true,
    "the active confirmation action should receive keyboard focus",
  );
  await dialog
    .getByRole("button", { name: "Replace and edit", exact: true })
    .click();
  await expectFooter(dialog, "editor");
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
    .getByRole("button", { name: "Next: Edit code", exact: true })
    .click();
  await expectFooter(dialog, "picker", "Keep current code", "Replace and edit");
  await dialog
    .getByRole("button", { name: "Replace and edit", exact: true })
    .click();
  await expectFooter(dialog, "editor");
  await input.fill(
    (await input.inputValue()) + "\n    %% typed after replacement",
  );
  await dialog
    .getByRole("button", { name: "Undo replacement", exact: true })
    .click();
  await expectFooter(dialog, "editor", "Keep current code", "Restore code");
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
  await expectFooter(dialog, "editor");
  assert.equal(await input.inputValue(), original);
  assert.equal(await edits(page), count);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .locator(".mm-discard-changes-dialog")
    .getByRole("button", { name: "Discard", exact: true })
    .click();
  assert.equal(await saved(page), before);

  dialog = await open(page);
  await expectFooter(dialog, "picker");
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
  assert.equal(
    await dialog.getByRole("button", { name: "Next: Edit code" }).isDisabled(),
    true,
    "navigation should be blocked during composition",
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
    .getByRole("button", { name: "Next: Edit code", exact: true })
    .click();
  await expectFooter(dialog, "editor");
  await preview(page);
  await dialog
    .getByRole("button", { name: "Insert diagram", exact: true })
    .click();
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
  await dialog
    .getByRole("button", { name: "Update diagram", exact: true })
    .click();
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
  await dialog
    .getByRole("button", { name: "Update diagram", exact: true })
    .click();
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
    .getByRole("button", { name: "Next: Edit code", exact: true })
    .click();
  await preview(page);
  await dialog
    .getByRole("button", { name: "Insert diagram", exact: true })
    .click();
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
    .getByRole("button", { name: "Next: Edit code", exact: true })
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
    .getByRole("button", { name: "Next: Edit code", exact: true })
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
  await dialog.locator('[data-template-id="gitgraph-branch-merge"]').click();
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
    const graphPreview = await preview(page);
    await visibleLabels(
      graphPreview,
      labels["gitgraph-branch-merge"],
      "Git graph " + theme,
    );
    await assertGitGraphPresentation(graphPreview, "Git graph " + theme);
    await graphPreview.screenshot({
      path: resolve(output, "gitgraph-" + theme + ".png"),
    });
  }
  console.log(
    "Passed Git graph in four live themes, narrow layouts, and lazy shared runtime loading",
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
  const cspResponse = await fetch(baseUrl);
  assert.equal(cspResponse.status, 200, "browser CSP endpoint unavailable");
  const csp = cspResponse.headers.get("content-security-policy");
  assert.ok(csp, "browser test page has no content security policy");
  const cspDirectives = new Map(
    csp.split(";").map((directive) => {
      const [name, ...values] = directive.trim().split(/\s+/);
      return [name, values.join(" ")];
    }),
  );
  assert.equal(cspDirectives.get("style-src"), "'self'");
  assert.equal(cspDirectives.get("style-src-elem"), "'self'");
  assert.equal(cspDirectives.get("style-src-attr"), "'unsafe-inline'");
  assert.equal(cspDirectives.get("connect-src"), "'none'");
  assert.equal(cspDirectives.get("script-src"), "'self' 'nonce-mm-test-nonce'");
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
  for (const check of [
    pickerUxChecks,
    interactionChecks,
    guardChecks,
    themeChecks,
  ]) {
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
