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
  "class-basic": ["User", "Order", "name", "submit", "places"],
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
const themeCases = [
  {
    id: "vscode-light",
    backdrop: "#ffffff",
    foreground: "#1f2328",
    accent: "#0969da",
    charts: ["#0969da", "#bc4c00", "#1a7f37", "#cf222e", "#8250df", "#bf3989"],
  },
  {
    id: "vscode-dark",
    backdrop: "#1e1e1e",
    foreground: "#d4d4d4",
    accent: "#3794ff",
    charts: ["#4fc1ff", "#ffae57", "#89d185", "#f48771", "#b180d7", "#ee9bd3"],
  },
  {
    id: "vscode-high-contrast",
    backdrop: "#000000",
    foreground: "#ffffff",
    accent: "#00a8ff",
    charts: ["#75beff", "#ffb454", "#86e89a", "#ff8080", "#d2a8ff", "#ff9bd1"],
  },
  {
    id: "vscode-high-contrast-light",
    backdrop: "#ffffff",
    foreground: "#000000",
    accent: "#0000ee",
    charts: ["#005fb8", "#924800", "#0f6a23", "#c74440", "#7030a0", "#a31570"],
  },
];
const chartThemeVariables = [
  "--vscode-charts-blue",
  "--vscode-charts-orange",
  "--vscode-charts-green",
  "--vscode-charts-red",
  "--vscode-charts-purple",
  "--vscode-charts-yellow",
];
async function applyTheme(page, theme) {
  await page.evaluate(
    ({
      id,
      backdrop,
      foreground,
      accent,
      charts,
      surface,
      line,
      chartNames,
    }) => {
      document.documentElement.className = document.body.className = id;
      for (const host of [document.documentElement, document.body]) {
        host.style.setProperty("--vscode-editor-background", backdrop);
        host.style.setProperty("--vscode-editor-foreground", foreground);
        host.style.setProperty("--vscode-foreground", foreground);
        host.style.setProperty(
          "--vscode-textCodeBlock-background",
          surface ?? backdrop,
        );
        host.style.setProperty("--vscode-textLink-foreground", accent);
        host.style.setProperty(
          "--vscode-descriptionForeground",
          line ?? foreground,
        );
        host.style.setProperty("--vscode-panel-border", line ?? foreground);
        chartNames.forEach((name, index) =>
          host.style.setProperty(name, charts[index]),
        );
      }
    },
    { ...theme, chartNames: chartThemeVariables },
  );
}
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
async function instrumentMermaidRuntime(page) {
  await page.evaluate(() => {
    const stats = {
      renderCalls: 0,
      renderSources: [],
      renderDurations: [],
      parseCalls: 0,
      parseSources: [],
      parseDurations: [],
      instrumented: false,
    };
    window.__markdownMintMermaidTemplateStats = stats;
    const instrument = () => {
      const runtime = window.markdownMintMermaid;
      if (!runtime || stats.instrumented) return;
      const render = runtime.render;
      const parse = runtime.parse;
      const timed = (durations, callback) => {
        const started = performance.now();
        const finish = (value) => {
          durations.push(performance.now() - started);
          return value;
        };
        try {
          const value = callback();
          if (value && typeof value.then === "function")
            return value.then(finish, (error) => {
              finish();
              throw error;
            });
          return finish(value);
        } catch (error) {
          finish();
          throw error;
        }
      };
      runtime.render = function (...args) {
        stats.renderCalls += 1;
        stats.renderSources.push(args[1]);
        return timed(stats.renderDurations, () => render.apply(this, args));
      };
      runtime.parse = function (...args) {
        stats.parseCalls += 1;
        stats.parseSources.push(args[0]);
        return timed(stats.parseDurations, () => parse.apply(this, args));
      };
      stats.instrumented = true;
    };
    if (window.markdownMintMermaid) instrument();
    else
      window.addEventListener("markdown-mint-mermaid-ready", instrument, {
        once: true,
      });
  });
}
async function mermaidRuntimeStats(page) {
  return page.evaluate(() => ({
    ...(window.__markdownMintMermaidTemplateStats ?? {}),
    explicitValidationParses: performance.getEntriesByName(
      "markdown-mint-mermaid-validation-parse",
    ).length,
  }));
}
async function candidatePerformanceMarks(page) {
  return page.evaluate(() =>
    performance
      .getEntriesByType("mark")
      .filter((entry) =>
        entry.name.startsWith("markdown-mint-mermaid-template-"),
      )
      .map((entry) => ({
        name: entry.name,
        startTime: entry.startTime,
        detail: entry.detail,
      })),
  );
}
async function clearPerformanceMarks(page) {
  await page.evaluate(() => {
    performance.clearMarks();
    performance.clearMeasures();
  });
}
function distribution(values) {
  const sorted = values.toSorted((first, second) => first - second);
  const percentile = (fraction) =>
    sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
  return {
    p50: Number(percentile(0.5).toFixed(2)),
    p95: Number(percentile(0.95).toFixed(2)),
  };
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
async function captureSvgPreview(page, previewLocator, path) {
  const [panel, svg, viewport] = await Promise.all([
    previewLocator.boundingBox(),
    previewLocator.locator("svg").boundingBox(),
    page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
  ]);
  assert.ok(panel && svg, "diagram preview is not measurable");
  const left = Math.max(0, panel.x, svg.x - 8);
  const top = Math.max(0, panel.y, svg.y - 8);
  const right = Math.min(
    viewport.width,
    panel.x + panel.width,
    svg.x + svg.width + 8,
  );
  const bottom = Math.min(
    viewport.height,
    panel.y + panel.height,
    svg.y + svg.height + 8,
  );
  await page.screenshot({
    path,
    clip: { x: left, y: top, width: right - left, height: bottom - top },
  });
}
async function applyThemeToOpenPreview(page, theme) {
  const currentPreview = page.locator(`${dialogSelector} .mm-mermaid-preview`);
  const oldStyle = await currentPreview.locator("svg").getAttribute("style");
  await applyTheme(page, theme);
  await page.waitForFunction(
    ({ selector, previousStyle }) => {
      const target = document.querySelector(selector);
      const svg = target?.querySelector("svg");
      return (
        target?.dataset.previewState === "rendered" &&
        target.getAttribute("aria-busy") === "false" &&
        svg &&
        svg.getAttribute("style") !== previousStyle
      );
    },
    {
      selector: `${dialogSelector} .mm-mermaid-preview`,
      previousStyle: oldStyle,
    },
  );
  return preview(page);
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

function contrastRatio(foreground, background, backdrop = "#ffffff") {
  const parseColor = (value) => {
    const color = value.trim().toLowerCase();
    if (color === "black") return [0, 0, 0, 1];
    if (color === "white") return [255, 255, 255, 1];
    const hex = color.match(/^#([\da-f]{3}|[\da-f]{6})$/)?.[1];
    if (hex) {
      const expanded =
        hex.length === 3
          ? [...hex].map((channel) => channel + channel).join("")
          : hex;
      return [
        Number.parseInt(expanded.slice(0, 2), 16),
        Number.parseInt(expanded.slice(2, 4), 16),
        Number.parseInt(expanded.slice(4, 6), 16),
        1,
      ];
    }
    const match = color.match(/^rgba?\(([^)]+)\)$/);
    const values = match?.[1].split(/[\s,/]+/).filter(Boolean);
    assert.ok(values?.length >= 3, "unrecognized computed color: " + value);
    const channels = values.slice(0, 3).map((channel) => {
      const parsed = Number.parseFloat(channel);
      return channel.endsWith("%") ? (parsed / 100) * 255 : parsed;
    });
    const alpha = values[3]
      ? values[3].endsWith("%")
        ? Number.parseFloat(values[3]) / 100
        : Number.parseFloat(values[3])
      : 1;
    return [...channels, Math.min(1, Math.max(0, alpha))];
  };
  const composite = (front, back) => {
    const alpha = front[3] + back[3] * (1 - front[3]);
    if (!alpha) return [0, 0, 0, 0];
    return [0, 1, 2]
      .map(
        (index) =>
          (front[index] * front[3] + back[index] * back[3] * (1 - front[3])) /
          alpha,
      )
      .concat(alpha);
  };
  const opaqueBackdrop = composite(parseColor(backdrop), [255, 255, 255, 1]);
  const solidBackground = composite(parseColor(background), opaqueBackdrop);
  const solidForeground = composite(parseColor(foreground), solidBackground);
  const luminance = (channels) => {
    const linear = channels.slice(0, 3).map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const first = luminance(solidForeground);
  const second = luminance(solidBackground);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

async function assertTextContrast(
  locator,
  textSelector,
  backgroundSelector,
  backdrop,
  label,
) {
  const pairs = await locator.locator("svg").evaluate(
    (svg, { textSelector, backgroundSelector }) => {
      const backgroundShapes = Array.from(
        svg.querySelectorAll(backgroundSelector),
      );
      const result = [];
      for (const text of Array.from(svg.querySelectorAll(textSelector))) {
        if (!text.textContent.trim()) continue;
        const bounds = text.getBoundingClientRect();
        if (!bounds.width || !bounds.height) continue;
        const pointX = bounds.left + bounds.width / 2;
        const pointY = bounds.top + bounds.height / 2;
        let background;
        let backgroundArea = Infinity;
        for (const shape of backgroundShapes) {
          const box = shape.getBoundingClientRect();
          const contains =
            pointX >= box.left &&
            pointX <= box.right &&
            pointY >= box.top &&
            pointY <= box.bottom;
          const style = getComputedStyle(shape);
          if (
            contains &&
            style.fill !== "none" &&
            Number(style.fillOpacity) > 0
          ) {
            const area = box.width * box.height;
            if (area < backgroundArea) {
              backgroundArea = area;
              background = style.fill;
            }
          }
        }
        result.push({
          text: text.textContent.trim(),
          foreground: getComputedStyle(text).fill,
          background,
        });
      }
      return result;
    },
    { textSelector, backgroundSelector },
  );
  assert.ok(pairs.length > 0, `${label}: no visible text pairs were measured`);
  for (const pair of pairs) {
    assert.ok(
      pair.background,
      `${label}: no rendered background under ${pair.text}`,
    );
    const ratio = contrastRatio(pair.foreground, pair.background, backdrop);
    assert.ok(
      ratio >= 4.5,
      `${label}: ${pair.text} contrast ${ratio.toFixed(2)}:1 against ${pair.background}`,
    );
  }
  return pairs;
}

async function assertExternalTextContrast(
  locator,
  textSelector,
  backdrop,
  label,
) {
  const texts = await locator.locator("svg").evaluate(
    (svg, selector) =>
      Array.from(svg.querySelectorAll(selector))
        .filter((text) => {
          const box = text.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && text.textContent.trim();
        })
        .map((text) => ({
          text: text.textContent.trim(),
          fill: getComputedStyle(text).fill,
        })),
    textSelector,
  );
  assert.ok(texts.length > 0, `${label}: no visible labels were measured`);
  for (const text of texts) {
    const ratio = contrastRatio(text.fill, backdrop);
    assert.ok(
      ratio >= 4.5,
      `${label}: ${text.text} contrast ${ratio.toFixed(2)}:1 against the document background`,
    );
  }
}

async function assertVisibleStrokes(locator, selector, backdrop, label) {
  const strokes = await locator.locator("svg").evaluate(
    (svg, query) =>
      Array.from(svg.querySelectorAll(query)).map((element) => {
        const style = getComputedStyle(element);
        return {
          stroke: style.stroke,
          width: Number.parseFloat(style.strokeWidth),
          opacity: Number(style.strokeOpacity) * Number(style.opacity),
        };
      }),
    selector,
  );
  assert.ok(strokes.length > 0, `${label}: expected visible diagram lines`);
  for (const stroke of strokes) {
    assert.notEqual(stroke.stroke, "none", `${label}: line has no stroke`);
    assert.ok(stroke.width >= 1, `${label}: line width ${stroke.width}px`);
    assert.ok(stroke.opacity > 0, `${label}: line is transparent`);
    assert.ok(
      contrastRatio(stroke.stroke, backdrop) >= 3,
      `${label}: line contrast is below 3:1 against the document background`,
    );
  }
}

async function assertErPresentation(locator, backdrop, label) {
  await assertTextContrast(
    locator,
    ".label text, .edgeLabel text",
    ".outer-path > path:first-child, .row-rect-odd > path:first-child, .row-rect-even > path:first-child, .edgeLabel rect",
    backdrop,
    label + " ER labels",
  );
  const rowCounts = await locator.locator("svg").evaluate((svg) => ({
    odd: svg.querySelectorAll(".row-rect-odd > path:first-child").length,
    even: svg.querySelectorAll(".row-rect-even > path:first-child").length,
  }));
  assert.ok(
    rowCounts.odd > 0 && rowCounts.even > 0,
    `${label}: missing ER row fills`,
  );
  const connectorGeometry = await locator
    .locator('svg[aria-roledescription="er"]')
    .evaluate((svg) => {
      const fontSize = Number.parseFloat(getComputedStyle(svg).fontSize);
      const markersById = new Map(
        Array.from(svg.querySelectorAll("marker.er"), (marker) => [
          marker.id,
          marker,
        ]),
      );
      const screenBox = (corners) => {
        const xs = corners.map((point) => point.x);
        const ys = corners.map((point) => point.y);
        return {
          x: Math.min(...xs),
          y: Math.min(...ys),
          width: Math.max(...xs) - Math.min(...xs),
          height: Math.max(...ys) - Math.min(...ys),
        };
      };
      const lines = Array.from(
        svg.querySelectorAll(".relationshipLine"),
        (line) => {
          const style = getComputedStyle(line);
          const total = line.getTotalLength();
          const midpoint = line
            .getPointAtLength(total / 2)
            .matrixTransform(line.getScreenCTM());
          const markerInstances = ["start", "end"].flatMap((side) => {
            const id = line
              .getAttribute(`marker-${side}`)
              ?.match(/#([^\)]+)/)?.[1];
            const marker = id ? markersById.get(id) : null;
            if (!marker) return [];
            const markerWidth = Number.parseFloat(
              marker.getAttribute("markerWidth"),
            );
            const markerHeight = Number.parseFloat(
              marker.getAttribute("markerHeight"),
            );
            const units = marker.getAttribute("markerUnits") || "strokeWidth";
            const scale =
              units === "strokeWidth"
                ? Number.parseFloat(style.strokeWidth)
                : 1;
            const point = line.getPointAtLength(side === "start" ? 0 : total);
            const nearby = line.getPointAtLength(
              side === "start"
                ? Math.min(0.1, total)
                : Math.max(0, total - 0.1),
            );
            const angle =
              side === "start"
                ? Math.atan2(nearby.y - point.y, nearby.x - point.x)
                : Math.atan2(point.y - nearby.y, point.x - nearby.x);
            const refX = Number(marker.getAttribute("refX"));
            const refY = Number(marker.getAttribute("refY"));
            const shapes = Array.from(
              marker.querySelectorAll("path, circle, polygon"),
              (shape) => {
                const box = shape.getBBox();
                const corners = [
                  [box.x, box.y],
                  [box.x + box.width, box.y],
                  [box.x, box.y + box.height],
                  [box.x + box.width, box.y + box.height],
                ].map(([x, y]) => {
                  const dx = (x - refX) * scale;
                  const dy = (y - refY) * scale;
                  const markerPoint = svg.createSVGPoint();
                  markerPoint.x =
                    point.x + dx * Math.cos(angle) - dy * Math.sin(angle);
                  markerPoint.y =
                    point.y + dx * Math.sin(angle) + dy * Math.cos(angle);
                  return markerPoint.matrixTransform(line.getScreenCTM());
                });
                const painted = getComputedStyle(shape);
                return {
                  width: box.width * scale,
                  height: box.height * scale,
                  strokeWidth: Number.parseFloat(painted.strokeWidth),
                  screenBox: screenBox(corners),
                };
              },
            );
            const bounds = shapes.flatMap((shape) => [
              { x: shape.screenBox.x, y: shape.screenBox.y },
              {
                x: shape.screenBox.x + shape.screenBox.width,
                y: shape.screenBox.y + shape.screenBox.height,
              },
            ]);
            return [
              {
                id,
                side,
                units,
                markerWidth,
                markerHeight,
                lineStrokeWidth: Number.parseFloat(style.strokeWidth),
                shapes,
                screenBox: screenBox(bounds),
              },
            ];
          });
          return {
            strokeWidth: Number.parseFloat(style.strokeWidth),
            fill: style.fill,
            midpoint: { x: midpoint.x, y: midpoint.y },
            markerInstances,
          };
        },
      );
      const labels = Array.from(svg.querySelectorAll(".edgeLabel"), (label) => {
        const bounds = label.getBoundingClientRect();
        return {
          text: label.textContent.trim(),
          screenBox: {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
          },
        };
      });
      return { fontSize, lines, labels };
    });
  assert.ok(
    connectorGeometry.lines.length > 0,
    `${label}: ER relationships are missing`,
  );
  for (const line of connectorGeometry.lines) {
    assert.equal(line.fill, "none", `${label}: ER relationship is filled`);
    assert.equal(
      line.strokeWidth,
      1,
      `${label}: relationship line should preserve Mermaid's 1px base size`,
    );
  }
  const markerInstances = connectorGeometry.lines.flatMap(
    (line) => line.markerInstances,
  );
  assert.ok(
    markerInstances.length > 0,
    `${label}: ER cardinality markers are missing`,
  );
  for (const marker of markerInstances) {
    assert.equal(
      marker.units,
      "strokeWidth",
      `${label}: Mermaid's default ER marker scaling changed`,
    );
    assert.ok(marker.markerWidth > 0 && marker.markerHeight > 0);
    assert.equal(
      marker.lineStrokeWidth,
      1,
      `${label}: ER marker base scale changed`,
    );
    for (const shape of marker.shapes) {
      assert.equal(
        shape.strokeWidth,
        1,
        `${label}: ER marker stroke should retain Mermaid's 1px size`,
      );
      assert.ok(
        shape.width <= connectorGeometry.fontSize * 3 &&
          shape.height <= connectorGeometry.fontSize * 2,
        `${label}: ER crowfoot symbol is unexpectedly large relative to entity text`,
      );
    }
  }
  for (const edgeLabel of connectorGeometry.labels) {
    if (!edgeLabel.text) continue;
    const edgeCenter = {
      x: edgeLabel.screenBox.x + edgeLabel.screenBox.width / 2,
      y: edgeLabel.screenBox.y + edgeLabel.screenBox.height / 2,
    };
    const nearestLine = connectorGeometry.lines
      .map((line) => ({
        ...line,
        distance: Math.hypot(
          line.midpoint.x - edgeCenter.x,
          line.midpoint.y - edgeCenter.y,
        ),
      }))
      .sort((left, right) => left.distance - right.distance)[0];
    assert.ok(nearestLine, `${label}: ER label has no relationship`);
    for (const marker of nearestLine.markerInstances) {
      const labelBox = edgeLabel.screenBox;
      const markerBox = marker.screenBox;
      const gapX = Math.max(
        0,
        markerBox.x - (labelBox.x + labelBox.width),
        labelBox.x - (markerBox.x + markerBox.width),
      );
      const gapY = Math.max(
        0,
        markerBox.y - (labelBox.y + labelBox.height),
        labelBox.y - (markerBox.y + markerBox.height),
      );
      const gap = Math.hypot(gapX, gapY);
      assert.ok(
        gap >= 1,
        `${label}: ER label ${edgeLabel.text} is within ${gap.toFixed(1)}px of its ${marker.id} marker`,
      );
    }
  }
  await assertVisibleStrokes(
    locator,
    ".relationshipLine, .marker.er path, .marker.er circle",
    backdrop,
    label + " ER connectors",
  );
}

async function assertClassDiagramMarkerPresentation(
  locator,
  backdrop,
  label,
  options = {},
) {
  const expectedKinds = options.expectedKinds ?? [
    "extension",
    "aggregation",
    "composition",
    "dependency",
  ];
  const minimumCards = options.minimumCards ?? 9;
  const minimumRelations = options.minimumRelations ?? 5;
  const presentation = await locator
    .locator('svg[aria-roledescription="classDiagram"]')
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
      const markers = Array.from(
        svg.querySelectorAll('marker[id*="classDiagram-"]'),
        (marker) => ({
          id: marker.id,
          units: marker.getAttribute("markerUnits"),
          width: Number.parseFloat(marker.getAttribute("markerWidth")),
          height: Number.parseFloat(marker.getAttribute("markerHeight")),
          viewBox: marker.getAttribute("viewBox"),
          refX: marker.getAttribute("refX"),
          refY: marker.getAttribute("refY"),
          shapes: Array.from(
            marker.querySelectorAll("path, circle, polygon"),
            (shape) => {
              const style = getComputedStyle(shape);
              const geometry = box(shape);
              return {
                fill: style.fill,
                stroke: style.stroke,
                strokeWidth: Number.parseFloat(style.strokeWidth),
                geometry,
              };
            },
          ),
        }),
      );
      const relations = Array.from(
        svg.querySelectorAll("path.relation"),
        (relation) => {
          const style = getComputedStyle(relation);
          const midpoint = relation
            .getPointAtLength(relation.getTotalLength() / 2)
            .matrixTransform(relation.getScreenCTM());
          const markerEndId = relation
            .getAttribute("marker-end")
            ?.match(/#([^\)]+)/)?.[1];
          const markerEnd = markerEndId
            ? svg.querySelector(`#${CSS.escape(markerEndId)}`)
            : null;
          let markerEndBox = null;
          if (markerEnd) {
            const shape = markerEnd.querySelector("path, circle, polygon");
            const shapeBox = shape?.getBBox();
            const markerEndPoint = relation.getPointAtLength(
              relation.getTotalLength(),
            );
            const beforeEndPoint = relation.getPointAtLength(
              Math.max(0, relation.getTotalLength() - 0.1),
            );
            const angle = Math.atan2(
              markerEndPoint.y - beforeEndPoint.y,
              markerEndPoint.x - beforeEndPoint.x,
            );
            const refX = Number(markerEnd.getAttribute("refX"));
            const refY = Number(markerEnd.getAttribute("refY"));
            const corners = shapeBox
              ? [
                  [shapeBox.x, shapeBox.y],
                  [shapeBox.x + shapeBox.width, shapeBox.y],
                  [shapeBox.x, shapeBox.y + shapeBox.height],
                  [shapeBox.x + shapeBox.width, shapeBox.y + shapeBox.height],
                ].map(([x, y]) => {
                  const dx = x - refX;
                  const dy = y - refY;
                  const point = svg.createSVGPoint();
                  point.x =
                    markerEndPoint.x +
                    dx * Math.cos(angle) -
                    dy * Math.sin(angle);
                  point.y =
                    markerEndPoint.y +
                    dx * Math.sin(angle) +
                    dy * Math.cos(angle);
                  return point.matrixTransform(relation.getScreenCTM());
                })
              : [];
            if (corners.length) {
              const xs = corners.map((point) => point.x);
              const ys = corners.map((point) => point.y);
              markerEndBox = {
                x: Math.min(...xs),
                y: Math.min(...ys),
                width: Math.max(...xs) - Math.min(...xs),
                height: Math.max(...ys) - Math.min(...ys),
              };
            }
          }
          return {
            id: relation.id,
            screenBox: (() => {
              const bounds = relation.getBoundingClientRect();
              return {
                x: bounds.x,
                y: bounds.y,
                width: bounds.width,
                height: bounds.height,
              };
            })(),
            fill: style.fill,
            stroke: style.stroke,
            strokeWidth: Number.parseFloat(style.strokeWidth),
            midpoint: { x: midpoint.x, y: midpoint.y },
            markers: ["marker-start", "marker-end"].flatMap((name) => {
              const reference = relation.getAttribute(name);
              const id = reference?.match(/#([^\)]+)/)?.[1];
              return id ? [id] : [];
            }),
            markerEndBox,
          };
        },
      );
      const cards = Array.from(svg.querySelectorAll(".node.default"), box);
      const cardRects = Array.from(
        svg.querySelectorAll(".node.default .label-container"),
        (element) => {
          const rect = element.getBoundingClientRect();
          return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          };
        },
      );
      const edgeLabels = Array.from(
        svg.querySelectorAll(".edgeLabel"),
        (element) => {
          const rect = element.getBoundingClientRect();
          return {
            text: element.textContent.trim(),
            screenBox: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            },
          };
        },
      );
      const terminalLabels = Array.from(
        svg.querySelectorAll(".edgeTerminals"),
        (element) => {
          const rect = element.getBoundingClientRect();
          return {
            text: element.textContent.trim(),
            screenBox: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            },
          };
        },
      );
      const fontSize = Number.parseFloat(getComputedStyle(svg).fontSize);
      const svgBounds = svg.getBoundingClientRect();
      return {
        role: svg.getAttribute("aria-roledescription"),
        viewBox: svg.getAttribute("viewBox"),
        svgBounds: {
          x: svgBounds.x,
          y: svgBounds.y,
          width: svgBounds.width,
          height: svgBounds.height,
        },
        fontSize,
        cards,
        cardRects,
        edgeLabels,
        terminalLabels,
        markers,
        relations,
      };
    });
  assert.equal(presentation.role, "classDiagram");
  const assertLabelWithinSvg = (text, box) => {
    assert.ok(
      box.width > 0 && box.height > 0,
      `${label}: ${text} has no bounds`,
    );
    assert.ok(
      box.x >= presentation.svgBounds.x &&
        box.y >= presentation.svgBounds.y &&
        box.x + box.width <=
          presentation.svgBounds.x + presentation.svgBounds.width &&
        box.y + box.height <=
          presentation.svgBounds.y + presentation.svgBounds.height,
      `${label}: ${text} is clipped by the SVG viewport`,
    );
  };
  assert.ok(
    presentation.cards.length >= minimumCards,
    `${label}: class cards are missing`,
  );
  assert.ok(
    presentation.relations.length >= minimumRelations,
    `${label}: class relationships are missing`,
  );
  const referencedMarkers = new Set(
    presentation.relations.flatMap((edge) => edge.markers),
  );
  const markers = presentation.markers.filter((marker) =>
    referencedMarkers.has(marker.id),
  );
  if (options.requireSuffixedHollowMarkerIds) {
    for (const kind of ["extension", "aggregation"])
      assert.ok(
        markers.some((marker) =>
          new RegExp(`classDiagram-${kind}(?:Start|End)-`).test(marker.id),
        ),
        `${label}: neo ${kind} marker should have a generated ID suffix; found ${markers.map((marker) => marker.id).join(", ")}`,
      );
  }
  const kindOf = (marker) =>
    marker.id.match(
      /classDiagram-(extension|aggregation|composition|dependency|lollipop)/,
    )?.[1];
  const kinds = new Set(markers.map(kindOf).filter(Boolean));
  for (const kind of expectedKinds)
    assert.ok(kinds.has(kind), `${label}: ${kind} marker was not rendered`);
  for (const marker of markers) {
    const kind = kindOf(marker);
    assert.equal(
      marker.units,
      "userSpaceOnUse",
      `${label}: class marker ${kind} should not scale with relationship stroke width`,
    );
    assert.ok(marker.width > 0 && marker.height > 0);
    assert.ok(marker.shapes.length > 0, `${label}: ${kind} symbol is empty`);
    for (const shape of marker.shapes) {
      assert.ok(shape.geometry.width > 0 && shape.geometry.height > 0);
      assert.equal(
        shape.strokeWidth,
        1,
        `${label}: ${kind} marker stroke width`,
      );
      assert.notEqual(
        shape.stroke,
        "none",
        `${label}: ${kind} marker has no outline`,
      );
      assert.ok(
        shape.geometry.width <= presentation.fontSize * 1.5 &&
          shape.geometry.height <= presentation.fontSize * 2 &&
          shape.geometry.width <
            Math.min(...presentation.cards.map((card) => card.width)) &&
          shape.geometry.height <
            Math.min(...presentation.cards.map((card) => card.height)),
        `${label}: ${kind} marker is oversized relative to class text`,
      );
      const hollow = kind === "extension" || kind === "aggregation";
      const fillIsTransparent =
        shape.fill === "transparent" ||
        /^rgba\([^,]+,\s*[^,]+,\s*[^,]+,\s*0(?:\.0+)?\)$/.test(shape.fill);
      assert.equal(
        fillIsTransparent,
        hollow,
        `${label}: ${kind} marker fill semantics changed (${shape.fill})`,
      );
    }
  }
  for (const relation of presentation.relations) {
    assert.equal(relation.fill, "none", `${label}: relation path is filled`);
    assert.equal(
      relation.strokeWidth,
      1,
      `${label}: relation stroke width changed`,
    );
    assert.notEqual(
      relation.stroke,
      "none",
      `${label}: relation has no stroke`,
    );
    assert.ok(relation.markers.length > 0, `${label}: relation has no marker`);
  }
  for (const [
    terminalIndex,
    terminal,
  ] of presentation.terminalLabels.entries()) {
    assert.ok(terminal.text, `${label}: multiplicity label is empty`);
    assertLabelWithinSvg(terminal.text, terminal.screenBox);
    for (const relation of presentation.relations) {
      const arrow = relation.markerEndBox;
      if (!arrow) continue;
      const text = terminal.screenBox;
      const overlaps =
        text.x < arrow.x + arrow.width &&
        text.x + text.width > arrow.x &&
        text.y < arrow.y + arrow.height &&
        text.y + text.height > arrow.y;
      assert.equal(
        overlaps,
        false,
        `${label}: multiplicity label ${terminal.text} overlaps an arrowhead`,
      );
    }
    for (const card of presentation.cardRects) {
      const text = terminal.screenBox;
      const overlaps =
        text.x < card.x + card.width &&
        text.x + text.width > card.x &&
        text.y < card.y + card.height &&
        text.y + text.height > card.y;
      assert.equal(
        overlaps,
        false,
        `${label}: multiplicity label ${terminal.text} overlaps a class box`,
      );
    }
    for (const edgeLabel of presentation.edgeLabels) {
      const text = terminal.screenBox;
      const other = edgeLabel.screenBox;
      const overlaps =
        text.x < other.x + other.width &&
        text.x + text.width > other.x &&
        text.y < other.y + other.height &&
        text.y + text.height > other.y;
      assert.equal(
        overlaps,
        false,
        `${label}: multiplicity label ${terminal.text} overlaps ${edgeLabel.text}`,
      );
    }
    for (const other of presentation.terminalLabels.slice(terminalIndex + 1)) {
      const text = terminal.screenBox;
      const otherBox = other.screenBox;
      const overlaps =
        text.x < otherBox.x + otherBox.width &&
        text.x + text.width > otherBox.x &&
        text.y < otherBox.y + otherBox.height &&
        text.y + text.height > otherBox.y;
      assert.equal(
        overlaps,
        false,
        `${label}: multiplicity labels ${terminal.text} and ${other.text} overlap`,
      );
    }
  }
  for (const edgeLabel of presentation.edgeLabels) {
    if (!edgeLabel.text) continue;
    assert.ok(edgeLabel.text, `${label}: relationship label is empty`);
    assertLabelWithinSvg(edgeLabel.text, edgeLabel.screenBox);
  }
  await assertExternalTextContrast(
    locator,
    ".edgeLabel text, .edgeTerminals",
    backdrop,
    label + " class relationship labels",
  );
  await assertTextContrast(
    locator,
    ".node.default text, .node.default tspan",
    ".node.default .label-container",
    backdrop,
    label + " class labels",
  );
  return presentation;
}

async function assertPiePresentation(locator, backdrop, label) {
  const presentation = await locator.locator("svg").evaluate((svg) => {
    const paths = Array.from(svg.querySelectorAll("path.pieCircle"));
    const swatches = Array.from(svg.querySelectorAll(".legend rect"));
    return {
      paths: paths.map((path) => {
        const style = getComputedStyle(path);
        return {
          fill: style.fill,
          stroke: style.stroke,
          strokeWidth: Number.parseFloat(style.strokeWidth),
          opacity: Number(style.opacity),
        };
      }),
      swatches: swatches.map((element) => getComputedStyle(element).fill),
      slices: svg.querySelectorAll("text.slice").length,
      title: svg.querySelectorAll(".pieTitleText").length,
    };
  });
  assert.equal(
    presentation.paths.length,
    3,
    `${label}: expected three pie sectors`,
  );
  assert.equal(
    new Set(presentation.paths.map((path) => path.fill)).size,
    3,
    `${label}: pie sectors must have distinct fills`,
  );
  assert.equal(
    presentation.slices,
    3,
    `${label}: expected each percentage label`,
  );
  assert.equal(
    presentation.swatches.length,
    3,
    `${label}: expected three legend swatches`,
  );
  for (const path of presentation.paths) {
    assert.notEqual(path.fill, "none", `${label}: sector has no fill`);
    assert.notEqual(
      path.stroke,
      "none",
      `${label}: sector boundary has no stroke`,
    );
    assert.ok(path.strokeWidth >= 1.5, `${label}: sector boundary is too thin`);
    assert.equal(path.opacity, 1, `${label}: pie sector should be opaque`);
    assert.ok(
      contrastRatio(path.stroke, path.fill) >= 3,
      `${label}: pie sector boundary is hard to distinguish`,
    );
  }
  for (const swatch of presentation.swatches)
    assert.ok(
      presentation.paths.some((path) => path.fill === swatch),
      `${label}: legend swatch does not match a sector`,
    );
  await assertTextContrast(
    locator,
    "text.slice",
    "path.pieCircle",
    backdrop,
    label + " pie percentages",
  );
  await assertExternalTextContrast(
    locator,
    ".pieTitleText, .legend text",
    backdrop,
    label + " pie title and legend",
  );
  return presentation;
}

async function assertTimelinePresentation(
  locator,
  backdrop,
  label,
  requireCategories = true,
) {
  const presentation = await locator.locator("svg").evaluate((svg) => ({
    nodes: svg.querySelectorAll(".timeline-node .node-bkg").length,
    sections: new Set(
      Array.from(
        svg.querySelectorAll(".timeline-node .node-bkg"),
        (node) => getComputedStyle(node).fill,
      ),
    ).size,
  }));
  assert.ok(presentation.nodes >= 1, `${label}: expected timeline surfaces`);
  if (requireCategories)
    assert.ok(
      presentation.sections >= 2,
      `${label}: period/event categories were not differentiated`,
    );
  await assertTextContrast(
    locator,
    ".timeline-node text, .timeline-node tspan",
    ".timeline-node .node-bkg",
    backdrop,
    label + " timeline node labels",
  );
  await assertExternalTextContrast(
    locator,
    ":scope > text",
    backdrop,
    label + " timeline title",
  );
  await assertVisibleStrokes(
    locator,
    ".node-line-0, .node-line-1, .node-line--1, .section-edge-0, .section-edge-1, .section-edge--1, .lineWrapper line",
    backdrop,
    label + " timeline connectors",
  );
}

async function assertMindmapPresentation(
  locator,
  backdrop,
  label,
  { expectedNodes = 7, expectedEdges = 6 } = {},
) {
  const presentation = await locator
    .locator('svg[aria-roledescription="mindmap"]')
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
      const screenBox = (element) => {
        const value = element.getBoundingClientRect();
        return {
          x: value.left,
          y: value.top,
          width: value.width,
          height: value.height,
        };
      };
      const nodes = Array.from(
        svg.querySelectorAll(".mindmap-node"),
        (node) => {
          const shape = node.querySelector(".node-bkg, .label-container");
          const text = node.querySelector("text");
          return {
            classes: node.getAttribute("class"),
            label: node.textContent.trim(),
            shape: shape
              ? {
                  tag: shape.tagName.toLowerCase(),
                  fill: getComputedStyle(shape).fill,
                  stroke: getComputedStyle(shape).stroke,
                  box: box(shape),
                  screenBox: screenBox(shape),
                }
              : null,
            text: text
              ? {
                  anchor: getComputedStyle(text).textAnchor,
                  box: box(text),
                  screenBox: screenBox(text),
                }
              : null,
          };
        },
      );
      const edges = Array.from(svg.querySelectorAll("path.edge"), (edge) => {
        const style = getComputedStyle(edge);
        return {
          classes: edge.getAttribute("class"),
          fill: style.fill,
          stroke: style.stroke,
          strokeWidth: Number.parseFloat(style.strokeWidth),
          strokeOpacity: Number(style.strokeOpacity) * Number(style.opacity),
          box: box(edge),
        };
      });
      const viewBox = svg.getAttribute("viewBox").split(/[ ,]+/).map(Number);
      return {
        role: svg.getAttribute("aria-roledescription"),
        viewBox,
        screenBox: screenBox(svg),
        nodes,
        edges,
        optionalLabels: svg.querySelectorAll(".mindmap-node-label").length,
      };
    });

  assert.equal(presentation.role, "mindmap", label + ": wrong diagram role");
  assert.equal(
    presentation.nodes.length,
    expectedNodes,
    label + ": node geometry changed",
  );
  assert.equal(
    presentation.edges.length,
    expectedEdges,
    label + ": branch geometry changed",
  );
  assert.ok(
    presentation.nodes.every((node) => node.shape?.box.width > 0),
    label + ": a node surface is missing",
  );
  assert.ok(
    presentation.nodes.every(
      (node) => node.label && node.text?.screenBox.width > 0,
    ),
    label + ": a node label is missing",
  );
  const root = presentation.nodes.find((node) =>
    node.classes.includes("section-root"),
  );
  const branches = presentation.nodes.filter(
    (node) => !node.classes.includes("section-root"),
  );
  assert.ok(root, label + ": center node missing");
  assert.ok(
    new Set(branches.map((node) => node.shape.fill)).size >= 2,
    label + ": main and feature branch colors collapsed",
  );
  assert.notEqual(
    root.shape.fill,
    branches[0].shape.fill,
    label + ": root surface lost precedence over its branch palette",
  );
  assert.equal(root.shape.tag, "circle", label + ": center node shape changed");
  assert.equal(
    root.text.anchor,
    "middle",
    label + ": center label is not anchored at the circle center",
  );
  for (const node of presentation.nodes) {
    const { x, y, width, height } = node.text.screenBox;
    const surface = node.shape.screenBox;
    if (node.shape.tag === "circle") {
      const centerX = surface.x + surface.width / 2;
      const centerY = surface.y + surface.height / 2;
      const radiusX = surface.width / 2;
      const radiusY = surface.height / 2;
      for (const point of [
        [x, y],
        [x + width, y],
        [x, y + height],
        [x + width, y + height],
      ]) {
        const ellipseDistance =
          ((point[0] - centerX) / radiusX) ** 2 +
          ((point[1] - centerY) / radiusY) ** 2;
        assert.ok(
          ellipseDistance <= 1.08,
          label + ": circular mindmap label spills outside its node",
        );
      }
    } else {
      assert.ok(
        x >= surface.x - 2 &&
          y >= surface.y - 2 &&
          x + width <= surface.x + surface.width + 2 &&
          y + height <= surface.y + surface.height + 2,
        label + ": mindmap label spills outside its node: " + node.label,
      );
    }
  }
  for (const edge of presentation.edges) {
    assert.equal(edge.fill, "none", label + ": a mindmap connector is filled");
    assert.notEqual(edge.stroke, "none", label + ": a branch has no stroke");
    assert.ok(edge.strokeOpacity > 0, label + ": a branch is transparent");
    assert.ok(edge.strokeWidth >= 1.5, label + ": a branch is too thin");
    assert.ok(
      edge.box.width > 0 || edge.box.height > 0,
      label + ": a branch has no geometry",
    );
    const section = edge.classes.match(/section-edge-(\d+)/)?.[1];
    if (section !== undefined) {
      const node = branches.find((item) =>
        item.classes.includes(`section-${section}`),
      );
      assert.ok(node, label + ": connector has no matching branch node");
      assert.equal(
        edge.stroke,
        node.shape.fill,
        label + `: section ${section} connector and node colors differ`,
      );
    }
  }
  assert.ok(
    new Set(presentation.edges.map((edge) => edge.strokeWidth)).size > 1,
    label + ": branch depth no longer affects connector weight",
  );
  const {
    x: svgX,
    y: svgY,
    width: svgWidth,
    height: svgHeight,
  } = presentation.screenBox;
  for (const node of presentation.nodes) {
    const { x, y, width, height } = node.shape.screenBox;
    assert.ok(
      x >= svgX - 4 &&
        y >= svgY - 4 &&
        x + width <= svgX + svgWidth + 4 &&
        y + height <= svgY + svgHeight + 4,
      label + ": mindmap node clipped by viewBox: " + node.label,
    );
  }
  await assertTextContrast(
    locator,
    ".mindmap-node text, .mindmap-node tspan",
    ".mindmap-node .node-bkg, .mindmap-node .label-container",
    backdrop,
    label + " mindmap labels",
  );
  await assertVisibleStrokes(
    locator,
    "path.edge, .mindmap-node .node-line",
    backdrop,
    label + " mindmap branches",
  );
  return presentation;
}

async function assertGanttPresentation(
  locator,
  backdrop,
  label,
  {
    requireStatuses = false,
    requireSections = false,
    requireTodayInRange = false,
    requireTodayOutOfRange = false,
    expectedTaskCount = 3,
    checkDurationOrder = true,
  } = {},
) {
  const presentation = await locator
    .locator('svg[aria-roledescription="gantt"]')
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
      const screenBox = (element) => {
        const value = element.getBoundingClientRect();
        return {
          x: value.left,
          y: value.top,
          width: value.width,
          height: value.height,
        };
      };
      const paint = (element) => {
        const style = getComputedStyle(element);
        return {
          classes: element.getAttribute("class") ?? "",
          text: element.textContent.trim(),
          fill: style.fill,
          stroke: style.stroke,
          strokeWidth: Number.parseFloat(style.strokeWidth),
          textAnchor: style.textAnchor,
          box: box(element),
          screenBox: screenBox(element),
        };
      };
      const viewBox = svg.getAttribute("viewBox").split(/[ ,]+/).map(Number);
      const today = svg.querySelector(".today line, line.today");
      let todayPosition = null;
      if (today) {
        const point = svg.createSVGPoint();
        point.x = Number(today.getAttribute("x1"));
        point.y = Number(today.getAttribute("y1"));
        todayPosition = point
          .matrixTransform(today.getScreenCTM())
          .matrixTransform(svg.getScreenCTM().inverse()).x;
      }
      return {
        role: svg.getAttribute("aria-roledescription"),
        viewBox,
        screenBox: screenBox(svg),
        sections: Array.from(svg.querySelectorAll("rect.section"), paint),
        tasks: Array.from(svg.querySelectorAll("rect.task"), paint),
        labels: Array.from(
          svg.querySelectorAll(
            ".taskText, .taskTextOutsideLeft, .taskTextOutsideRight",
          ),
          paint,
        ),
        titles: Array.from(
          svg.querySelectorAll(".titleText, .sectionTitle"),
          paint,
        ),
        ticks: Array.from(svg.querySelectorAll(".grid .tick"), (tick) => {
          const text = tick.querySelector("text");
          const line = tick.querySelector("line");
          let x = null;
          if (line) {
            const point = svg.createSVGPoint();
            point.x = Number(line.getAttribute("x1"));
            point.y = Number(line.getAttribute("y1"));
            x = point.matrixTransform(line.getScreenCTM()).x;
          }
          return {
            ...(text ? paint(text) : null),
            axisX: x,
          };
        }),
        grid: Array.from(
          svg.querySelectorAll(".grid .tick line, .grid path"),
          paint,
        ),
        today: today ? paint(today) : null,
        todayPosition,
        milestone: svg.querySelector(".milestone"),
        milestoneTransform: svg.querySelector(".milestone")
          ? getComputedStyle(svg.querySelector(".milestone")).transform
          : null,
      };
    });
  assert.equal(presentation.role, "gantt", label + ": wrong diagram role");
  assert.equal(
    presentation.tasks.length,
    expectedTaskCount,
    label + ": task geometry changed",
  );
  assert.equal(
    presentation.labels.length,
    expectedTaskCount,
    label + ": task labels missing",
  );
  assert.ok(
    presentation.sections.length >= expectedTaskCount,
    label + ": section bands missing",
  );
  assert.ok(
    presentation.tasks.every(
      (task) =>
        task.box.width > 0 &&
        task.box.height > 0 &&
        task.fill !== "none" &&
        task.stroke !== "none",
    ),
    label + ": task bar has no visible paint or geometry",
  );
  if (checkDurationOrder)
    assert.ok(
      presentation.tasks[1].box.width > presentation.tasks[0].box.width &&
        presentation.tasks[0].box.width > presentation.tasks[2].box.width,
      label + ": source task durations/order changed",
    );
  assert.ok(
    presentation.ticks.length >= 5,
    label + ": date axis labels are missing",
  );
  assert.ok(presentation.grid.length > 0, label + ": date grid is missing");
  assert.ok(
    presentation.titles.some((title) => title.classes.includes("titleText")),
    label + ": title is missing",
  );
  assert.ok(
    presentation.titles.some((title) => title.classes.includes("sectionTitle")),
    label + ": section title is missing",
  );
  const mainTitle = presentation.titles.find((title) =>
    title.classes.includes("titleText"),
  );
  assert.equal(
    mainTitle.textAnchor,
    "middle",
    label + ": title anchor changed",
  );
  const {
    x: svgX,
    y: svgY,
    width: svgWidth,
    height: svgHeight,
  } = presentation.screenBox;
  for (const task of presentation.tasks) {
    const { x, y, width, height } = task.screenBox;
    assert.ok(
      x >= svgX - 4 &&
        y >= svgY - 4 &&
        x + width <= svgX + svgWidth + 4 &&
        y + height <= svgY + svgHeight + 4,
      label + ": task is clipped by viewBox: " + task.classes,
    );
  }
  for (const text of presentation.labels) {
    if (text.classes.includes("taskTextOutsideRight"))
      assert.equal(
        text.textAnchor,
        "start",
        label + ": right label anchor changed",
      );
    else if (text.classes.includes("taskTextOutsideLeft"))
      assert.equal(
        text.textAnchor,
        "end",
        label + ": left label anchor changed",
      );
    else
      assert.equal(
        text.textAnchor,
        "middle",
        label + ": bar label anchor changed",
      );
  }
  for (let index = 0; index < presentation.labels.length; index += 1) {
    const text = presentation.labels[index];
    const task = presentation.tasks[index];
    const labelBox = text.screenBox;
    const taskBox = task.screenBox;
    const labelCenterY = labelBox.y + labelBox.height / 2;
    const taskCenterY = taskBox.y + taskBox.height / 2;
    assert.ok(
      Math.abs(labelCenterY - taskCenterY) <= 3,
      label + ": task label is vertically detached from its bar",
    );
    if (text.classes.includes("taskTextOutsideRight"))
      assert.ok(
        labelBox.x >= taskBox.x + taskBox.width - 2,
        label + ": outside-right task label overlaps its bar",
      );
    else if (text.classes.includes("taskTextOutsideLeft"))
      assert.ok(
        labelBox.x + labelBox.width <= taskBox.x + 2,
        label + ": outside-left task label overlaps its bar",
      );
    else {
      assert.ok(
        labelBox.x >= taskBox.x - 2 &&
          labelBox.x + labelBox.width <= taskBox.x + taskBox.width + 2,
        label + ": inside task label does not fit its bar",
      );
      assert.ok(
        Math.abs(
          labelBox.x + labelBox.width / 2 - taskBox.x - taskBox.width / 2,
        ) <= 2,
        label + ": inside task label is not centered on its bar",
      );
    }
  }
  for (const tick of presentation.ticks) {
    assert.equal(
      tick.textAnchor,
      "middle",
      label + ": date tick label is not centered",
    );
    if (tick.axisX !== null)
      assert.ok(
        Math.abs(tick.screenBox.x + tick.screenBox.width / 2 - tick.axisX) <= 3,
        label + ": date label is detached from its grid tick",
      );
  }
  await assertTextContrast(
    locator,
    ".taskText",
    ".task",
    backdrop,
    label + " task labels",
  );
  await assertExternalTextContrast(
    locator,
    ".taskTextOutsideLeft, .taskTextOutsideRight, .titleText, .sectionTitle, .grid .tick text, .vertText",
    backdrop,
    label + " axis, titles, and outside task labels",
  );
  await assertVisibleStrokes(
    locator,
    ".grid .tick line, .grid path, .vert, .today line, line.today",
    backdrop,
    label + " grid and today marker",
  );
  if (requireStatuses) {
    const active = presentation.tasks.find((task) =>
      /\bactive(?:Crit)?[0-3]\b/.test(task.classes),
    );
    const done = presentation.tasks.find((task) =>
      /\bdone(?:Crit)?[0-3]\b/.test(task.classes),
    );
    const critical = presentation.tasks.find((task) =>
      /\bcrit[0-3]\b/.test(task.classes),
    );
    assert.ok(
      active && done && critical,
      label + ": active/done/critical task states missing",
    );
    assert.ok(
      new Set([active.fill, done.fill, critical.fill]).size >= 3,
      label + ": task status colors collapsed",
    );
    assert.ok(presentation.milestone, label + ": milestone missing");
    assert.notEqual(
      presentation.milestoneTransform,
      "none",
      label + ": milestone diamond transform missing",
    );
    assert.ok(
      presentation.labels.some((item) =>
        item.classes.includes("taskTextOutside"),
      ),
      label + ": long task label did not exercise outside-bar placement",
    );
  }
  if (requireSections)
    assert.ok(
      new Set(presentation.sections.map((section) => section.fill)).size >= 2,
      label + ": multiple section bands are not differentiated",
    );
  if (requireTodayInRange) {
    assert.ok(presentation.today, label + ": today marker missing");
    assert.notEqual(
      presentation.today.stroke,
      "none",
      label + ": today marker has no stroke",
    );
    assert.ok(
      presentation.todayPosition >= presentation.viewBox[0] &&
        presentation.todayPosition <=
          presentation.viewBox[0] + presentation.viewBox[2],
      label + ": today marker is outside the current date range",
    );
  }
  if (requireTodayOutOfRange) {
    assert.ok(presentation.today, label + ": today marker missing");
    assert.ok(
      presentation.todayPosition < presentation.viewBox[0] ||
        presentation.todayPosition >
          presentation.viewBox[0] + presentation.viewBox[2],
      label + ": fixed task dates no longer keep today outside their range",
    );
  }
  return presentation;
}

const templatePresentationKinds = new Map([
  ["flowchart-basic", "flowchart"],
  ["flowchart-decision", "flowchart"],
  ["flowchart-grouped", "flowchart"],
  ["sequence-request-response", "sequence"],
  ["sequence-alternative", "sequence"],
  ["state-workflow", "state"],
  ["class-basic", "class"],
  ["er-order", "er"],
  ["gantt-project", "gantt"],
  ["mindmap-basic", "mindmap"],
  ["timeline-roadmap", "timeline"],
  ["pie-composition", "pie"],
  ["gitgraph-branch-merge", "gitGraph"],
]);

async function assertDiagramPresentation(
  locator,
  id,
  backdrop,
  label,
  options = {},
) {
  const kind = templatePresentationKinds.get(id);
  assert.ok(kind, `${label}: no visual assertion registered for ${id}`);
  if (kind === "er") return assertErPresentation(locator, backdrop, label);
  if (kind === "pie") return assertPiePresentation(locator, backdrop, label);
  if (kind === "mindmap")
    return assertMindmapPresentation(locator, backdrop, label);
  if (kind === "gantt")
    return assertGanttPresentation(locator, backdrop, label, options);
  if (kind === "timeline")
    return assertTimelinePresentation(
      locator,
      backdrop,
      label,
      options.requireTimelineCategories,
    );
  if (kind === "gitGraph") return assertGitGraphPresentation(locator, label);
  if (kind === "flowchart" || kind === "sequence" || kind === "state")
    return assertOtherDiagramPaint(locator, id, label);
  if (kind === "class")
    return assertClassDiagramMarkerPresentation(locator, backdrop, label, {
      expectedKinds: ["dependency"],
      minimumCards: 2,
      minimumRelations: 1,
    });
  assert.fail(`${label}: unsupported visual assertion kind ${kind}`);
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
    return {
      role,
      shapes: Array.from(
        svg.querySelectorAll("path, rect, circle, polygon, ellipse, line"),
        paint,
      ),
      texts: Array.from(svg.querySelectorAll("text"), (element) => ({
        text: element.textContent.trim(),
        box: {
          width: element.getBBox().width,
          height: element.getBBox().height,
        },
      })),
    };
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
  } else if (templateId === "state-workflow" || templateId === "class-basic") {
    assert.ok(presentation.role, label + ": diagram role missing");
    const visibleGeometry = presentation.shapes.filter(
      (shape) => shape.box.width > 0 || shape.box.height > 0,
    );
    assert.ok(
      visibleGeometry.length >= 4,
      label + ": structural diagram shapes are missing",
    );
    assert.ok(
      presentation.texts.filter(
        (text) => text.text && text.box.width > 0 && text.box.height > 0,
      ).length >= 3,
      label + ": structural diagram labels are missing",
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
      await applyTheme(page, themeCases[0]);
      await instrumentMermaidRuntime(page);
      const count = await edits(page);
      const dialog = await open(page);
      await expectFooter(dialog, "picker");
      await preview(page);
      const initialStats = await mermaidRuntimeStats(page);
      assert.equal(
        initialStats.instrumented,
        true,
        "runtime spy was not installed",
      );
      assert.equal(
        initialStats.explicitValidationParses,
        0,
        "the first built-in candidate must skip user-input validation",
      );
      assert.equal(
        initialStats.renderCalls,
        1,
        "first built-in candidate should render once after lazy runtime load",
      );
      if (!capturedInitial) {
        await page.screenshot({
          path: resolve(output, "initial-picker.png"),
        });
        capturedInitial = true;
      }
      await dialog.locator(`[data-template-id="${template.id}"]`).click();
      if (direction)
        await dialog.getByLabel("Template direction").selectOption(direction);
      const candidatePreview = await preview(page);
      await visibleLabels(
        candidatePreview,
        labels[template.id],
        `${template.id} ${direction ?? ""}`,
      );
      await assertDiagramPresentation(
        candidatePreview,
        template.id,
        themeCases[0].backdrop,
        `${template.id} candidate preview`,
      );
      const statsAtCandidate = await mermaidRuntimeStats(page);
      const tdSource = buildSource(template.id, { direction: "TD" });
      const targetSource = buildSource(template.id, { direction });
      const expectedCandidateRenders =
        1 +
        Number(
          tdSource !== buildSource("flowchart-basic", { direction: "TD" }),
        ) +
        Number(targetSource !== tdSource);
      assert.equal(
        statsAtCandidate.explicitValidationParses,
        0,
        `${template.id}: selecting a built-in candidate ran prevalidation`,
      );
      assert.equal(
        statsAtCandidate.renderCalls,
        expectedCandidateRenders,
        `${template.id}: candidate cache/render count was wrong`,
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
      await assertDiagramPresentation(
        codePreview,
        template.id,
        themeCases[0].backdrop,
        `${template.id} applied code preview`,
      );
      const unchangedTemplateStats = await mermaidRuntimeStats(page);
      assert.equal(
        unchangedTemplateStats.explicitValidationParses,
        0,
        `${template.id}: editor entry prevalidated an unchanged template`,
      );
      assert.equal(
        unchangedTemplateStats.renderCalls,
        expectedCandidateRenders,
        `${template.id}: cached template rendered again on editor entry`,
      );
      assert.equal(
        await codePreview.getAttribute("data-preview-cache"),
        "hit",
        `${template.id}: editor entry did not reuse candidate SVG`,
      );
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
      const currentSource = await input.inputValue();
      const unicodeSource =
        template.id === "er-order"
          ? currentSource.replaceAll("USER", "日本語ラベル")
          : currentSource.replace(labels[template.id][0], "日本語ラベル");
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
      assert.equal(
        (await mermaidRuntimeStats(page)).explicitValidationParses,
        1,
        `${template.id}: user input did not use ordinary validation exactly once`,
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
      assert.equal(
        (await mermaidRuntimeStats(page)).explicitValidationParses,
        1,
        `${template.id}: insert repeated validation for the successful snapshot`,
      );
      const markdown = await saved(page);
      assert.ok(markdown.includes("```mermaid\n" + unicodeSource + "\n```"));
      const rendered = page.locator(".mm-rich-panel .mm-mermaid");
      await rendered.locator("svg").waitFor();
      await visibleLabels(rendered, ["日本語ラベル"], "document");
      await assertDiagramPresentation(
        rendered,
        template.id,
        themeCases[0].backdrop,
        `${template.id} inserted document`,
      );
      if (template.id === "gitgraph-branch-merge") {
        await assertGitGraphPresentation(rendered, "inserted document");
        await rendered.screenshot({
          path: resolve(output, "gitgraph-document.png"),
        });
      }
      await rendered.dblclick();
      await preview(page);
      assert.equal(
        (await mermaidRuntimeStats(page)).explicitValidationParses,
        2,
        `${template.id}: existing source did not use ordinary validation`,
      );
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
      await assertDiagramPresentation(
        reopenedPreview,
        template.id,
        themeCases[0].backdrop,
        `${template.id} existing diagram editor`,
      );
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
      assert.equal(
        (await mermaidRuntimeStats(page)).explicitValidationParses,
        2,
        `${template.id}: no-op update repeated existing-source validation`,
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
    "rendering",
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
  assert.ok(
    ["rendering", "rendered"].includes(
      await previewElement.getAttribute("data-preview-state"),
    ),
  );
  assert.equal(
    await previewElement.getAttribute("aria-busy"),
    String(
      (await previewElement.getAttribute("data-preview-state")) === "rendering",
    ),
  );
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
  await page.keyboard.press("Escape");
  await page.locator(dialogSelector).waitFor({ state: "detached" });
  assert.equal(
    await page.locator(".mm-discard-changes-dialog").count(),
    0,
    "Escape from the clean initial picker should close the modal directly",
  );
  assert.equal(await edits(page), count);

  dialog = await open(page);
  await expectFooter(dialog, "picker");
  await preview(page);
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
  const discard = page.locator(".mm-discard-changes-dialog");
  await discard.waitFor({ state: "visible" });
  assert.equal(
    await dialog.isVisible(),
    true,
    "Escape from an unapplied Mermaid template should keep the modal behind discard confirmation",
  );
  await discard.getByRole("button", { name: "Discard", exact: true }).click();
  await page.locator(dialogSelector).waitFor({ state: "detached" });
  assert.equal(
    await discard.count(),
    0,
    "discard confirmation remained after Escape cancel",
  );
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
  const backToTemplates = dialog.getByRole("button", {
    name: "Back to Mermaid templates",
    exact: true,
  });
  assert.equal(
    await backToTemplates.evaluate((button) =>
      Boolean(
        button.compareDocumentPosition(button.form.querySelector("h2")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ),
    true,
    "template navigation should precede the editor title in the DOM",
  );
  await input.focus();
  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await backToTemplates.evaluate(
      (button) => document.activeElement === button,
    ),
    true,
    "template navigation should be reachable from the editor input by Tab",
  );
  await page.keyboard.press("Space");
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
  await input.focus();
  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await backToTemplates.evaluate(
      (button) => document.activeElement === button,
    ),
    true,
  );
  await page.keyboard.press("Enter");
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
    await page.locator(".mm-discard-changes-dialog").isVisible(),
    true,
    "Escape during replacement should enter whole-modal discard handling",
  );
  await page
    .locator(".mm-discard-changes-dialog")
    .getByRole("button", { name: "Keep editing", exact: true })
    .click();
  assert.equal(
    await dialog.locator(".mm-mermaid-replacement-confirmation").isVisible(),
    true,
    "Escape confirmation should leave the replacement prompt intact",
  );
  await dialog
    .getByRole("button", { name: "Keep current code", exact: true })
    .click();
  assert.equal(
    await dialog.locator(".mm-mermaid-replacement-confirmation").isVisible(),
    false,
  );
  assert.equal(
    await dialog.locator(".mm-mermaid-template-picker").isVisible(),
    true,
  );
  await page.keyboard.press("Escape");
  assert.equal(
    await page.locator(".mm-discard-changes-dialog").isVisible(),
    true,
    "Escape in the revisit picker should use the modal's dirty policy",
  );
  await page
    .locator(".mm-discard-changes-dialog")
    .getByRole("button", { name: "Keep editing", exact: true })
    .click();
  assert.equal(
    await dialog.locator(".mm-mermaid-template-picker").isVisible(),
    true,
  );
  assert.equal(await input.inputValue(), original);
  await dialog
    .getByRole("button", { name: "Back to code", exact: true })
    .click();
  await expectFooter(dialog, "editor");
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
  await dialog
    .getByRole("button", { name: "Back to Mermaid templates", exact: true })
    .click();
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
  assert.equal(
    await input.inputValue(),
    buildMermaidTemplateSource("gantt-project"),
    "confirmed replacement did not apply the selected template",
  );
  assert.equal(
    await dialog.getByRole("button", { name: /Undo replacement/ }).count(),
    0,
    "the editor exposed a template-specific undo action",
  );
  assert.equal(await edits(page), count, "replacement edited the document");
  await input.fill(
    (await input.inputValue()) + "\n    %% typed after replacement",
  );
  await dialog
    .getByRole("button", { name: "Back to Mermaid templates", exact: true })
    .click();
  await dialog.locator('[data-template-id="gitgraph-branch-merge"]').click();
  await dialog
    .getByRole("button", { name: "Next: Edit code", exact: true })
    .click();
  await expectFooter(dialog, "picker", "Keep current code", "Replace and edit");
  assert.ok((await input.inputValue()).includes("typed after replacement"));
  await dialog
    .getByRole("button", { name: "Keep current code", exact: true })
    .click();
  assert.ok((await input.inputValue()).includes("typed after replacement"));
  await dialog
    .getByRole("button", { name: "Next: Edit code", exact: true })
    .click();
  await expectFooter(dialog, "picker", "Keep current code", "Replace and edit");
  await dialog
    .getByRole("button", { name: "Replace and edit", exact: true })
    .click();
  await expectFooter(dialog, "editor");
  assert.equal(
    await input.inputValue(),
    buildMermaidTemplateSource("gitgraph-branch-merge"),
    "confirmed edited replacement did not apply",
  );
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
    await dialog.getByRole("button", { name: /Undo replacement/ }).count(),
    0,
  );
  assert.equal(
    await dialog
      .getByRole("button", { name: "Back to Mermaid templates", exact: true })
      .count(),
    0,
    "initial picker showed editor navigation",
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
    "Passed keyboard, replacement, composition events, cancellation, and Undo/Redo boundaries",
  );
}

async function inputValidationChecks(page) {
  await load(page);
  await instrumentMermaidRuntime(page);
  const before = await saved(page);
  const count = await edits(page);
  const dialog = await open(page);
  await preview(page);
  await dialog
    .getByRole("button", { name: "Next: Edit code", exact: true })
    .click();
  await preview(page);
  assert.equal(
    (await mermaidRuntimeStats(page)).explicitValidationParses,
    0,
    "entering the applied built-in template should not prevalidate",
  );

  const input = dialog.locator(sourceSelector);
  await input.fill("flowchart TD\n    A -->");
  await page.waitForFunction(
    (selector) =>
      document.querySelector(selector)?.getAttribute("data-preview-state") ===
      "invalid",
    `${dialogSelector} .mm-mermaid-preview`,
  );
  assert.equal((await mermaidRuntimeStats(page)).explicitValidationParses, 1);
  assert.equal(
    await dialog.getByRole("button", { name: "Insert diagram" }).isDisabled(),
    true,
  );

  await dialog
    .getByRole("button", { name: "Back to Mermaid templates", exact: true })
    .click();
  await dialog.locator('[data-template-id="gitgraph-branch-merge"]').click();
  await preview(page);
  assert.equal((await mermaidRuntimeStats(page)).explicitValidationParses, 1);
  await dialog
    .getByRole("button", { name: "Back to code", exact: true })
    .click();
  await page.waitForFunction(
    (selector) =>
      document.querySelector(selector)?.getAttribute("data-preview-state") ===
      "invalid",
    `${dialogSelector} .mm-mermaid-preview`,
  );
  assert.equal(await input.inputValue(), "flowchart TD\n    A -->");
  assert.match(
    await dialog.locator(".mm-mermaid-validation-status").textContent(),
    /Syntax error/i,
  );
  assert.equal((await mermaidRuntimeStats(page)).explicitValidationParses, 1);

  await dialog.locator("form").evaluate((form) => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
  await page.waitForFunction(
    () =>
      performance.getEntriesByName("markdown-mint-mermaid-validation-parse")
        .length === 2,
  );
  assert.equal(await saved(page), before, "invalid input was inserted");
  assert.equal(await edits(page), count, "invalid input emitted an edit");
  await page.keyboard.press("Escape");
  await page
    .locator(".mm-discard-changes-dialog")
    .getByRole("button", { name: "Discard", exact: true })
    .click();
  console.log(
    "Passed invalid user input, candidate browsing without validation bypass, and guarded submit",
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
  const beforeExistingTemplate = await edits(page);
  await dialog
    .getByRole("button", { name: "Back to Mermaid templates", exact: true })
    .click();
  await dialog.locator('[data-template-id="mindmap-basic"]').click();
  await preview(page);
  await dialog
    .getByRole("button", { name: "Next: Edit code", exact: true })
    .click();
  await expectFooter(dialog, "picker", "Keep current code", "Replace and edit");
  assert.equal(
    await dialog.locator(sourceSelector).inputValue(),
    original,
    "replacement confirmation changed an existing draft",
  );
  assert.equal(await edits(page), beforeExistingTemplate);
  assert.equal(await saved(page), source);
  await dialog
    .getByRole("button", { name: "Keep current code", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Back to code", exact: true })
    .click();
  assert.equal(await dialog.locator(sourceSelector).inputValue(), original);
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
  const selectedEdits = await edits(page);
  await dialog
    .getByRole("button", { name: "Back to Mermaid templates", exact: true })
    .click();
  await dialog.locator('[data-template-id="pie-composition"]').click();
  await dialog
    .getByRole("button", { name: "Next: Edit code", exact: true })
    .click();
  await expectFooter(dialog, "picker", "Keep current code", "Replace and edit");
  assert.equal(
    await dialog.locator(sourceSelector).inputValue(),
    "flowchart LR A-->B",
  );
  assert.equal(await edits(page), selectedEdits);
  assert.equal(await saved(page), "flowchart LR A-->B");
  await dialog
    .getByRole("button", { name: "Keep current code", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Back to code", exact: true })
    .click();
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
  await instrumentMermaidRuntime(page);
  const dialog = await open(page);
  await preview(page);
  const presentationDirectory = resolve(
    repository,
    "docs/screenshots/issue-141",
  );
  await mkdir(presentationDirectory, { recursive: true });
  const screenshotIds = new Set(["mindmap-basic", "gantt-project"]);
  const templates = getMermaidTemplates();
  assert.equal(templates.length, 13, "visual registry expects 13 templates");
  assert.equal(
    templatePresentationKinds.size,
    templates.length,
    "every built-in template must have a presentation assertion",
  );
  for (const template of templates)
    assert.ok(
      templatePresentationKinds.has(template.id),
      `visual registry is missing ${template.id}`,
    );
  assert.equal(
    templates.reduce(
      (total, template) => total + (template.directions?.length ?? 1),
      0,
    ),
    16,
    "visual registry expects 16 source variants",
  );
  const themeGeometry = new Map();
  for (const theme of themeCases) {
    await applyThemeToOpenPreview(page, theme);
    for (const template of templates) {
      for (const direction of template.directions ?? [undefined]) {
        const id = template.id;
        await dialog.locator(`[data-template-id="${id}"]`).click();
        if (direction)
          await dialog.getByLabel("Template direction").selectOption(direction);
        const diagramPreview = await preview(page);
        await visibleLabels(
          diagramPreview,
          labels[id],
          `${id} ${direction ?? ""} ${theme.id}`,
        );
        const presentation = await assertDiagramPresentation(
          diagramPreview,
          id,
          theme.backdrop,
          `${id} ${direction ?? ""} candidate preview in ${theme.id}`,
        );
        const variantId = `${id}${direction ? `-${direction}` : ""}`;
        const themeSuffix = theme.id.replace("vscode-", "");
        await captureSvgPreview(
          page,
          diagramPreview,
          resolve(output, `catalog-${variantId}-${themeSuffix}.png`),
        );
        if (id === "mindmap-basic" || id === "gantt-project") {
          const geometry =
            id === "mindmap-basic"
              ? {
                  viewBox: presentation.viewBox,
                  nodes: presentation.nodes.map((node) => ({
                    classes: node.classes,
                    label: node.label,
                    box: node.shape.box,
                  })),
                  edges: presentation.edges.map((edge) => ({
                    classes: edge.classes,
                    box: edge.box,
                  })),
                }
              : {
                  viewBox: presentation.viewBox,
                  tasks: presentation.tasks.map((task) => ({
                    classes: task.classes,
                    box: task.box,
                  })),
                  labels: presentation.labels.map((item) => ({
                    text: item.text,
                    box: item.box,
                  })),
                };
          const previous = themeGeometry.get(id);
          if (previous)
            assert.deepEqual(
              geometry,
              previous,
              `${id}: theme switching changed source-driven geometry`,
            );
          else themeGeometry.set(id, geometry);
        }
        if (screenshotIds.has(id)) {
          const suffix = theme.id.replace("vscode-", "");
          await captureSvgPreview(
            page,
            diagramPreview,
            resolve(presentationDirectory, `${id}-${suffix}.png`),
          );
          await captureSvgPreview(
            page,
            diagramPreview,
            resolve(output, `${id}-${suffix}.png`),
          );
        }
      }
    }
    await page.screenshot({
      path: resolve(output, `${theme.id}-picker.png`),
    });
  }

  const customTheme = {
    id: "vscode-light",
    backdrop: "#fff8e7",
    surface: "#e0f2fe",
    foreground: "#182230",
    line: "#334155",
    accent: "#1d4ed8",
    charts: ["#6d28d9", "#c2410c", "#166534", "#b91c1c", "#075985", "#9d174d"],
  };
  const customThemeBefore = await mermaidRuntimeStats(page);
  await applyTheme(page, customTheme);
  await page.waitForFunction(
    (renderCalls) =>
      window.__markdownMintMermaidTemplateStats?.renderCalls > renderCalls,
    customThemeBefore.renderCalls,
  );
  await preview(page);
  for (const id of ["er-order", "pie-composition", "timeline-roadmap"]) {
    await dialog.locator(`[data-template-id="${id}"]`).click();
    const diagramPreview = await preview(page);
    await assertDiagramPresentation(
      diagramPreview,
      id,
      customTheme.backdrop,
      `${id} custom theme preview`,
    );
    if (id === "pie-composition") {
      const pie = await assertPiePresentation(
        diagramPreview,
        customTheme.backdrop,
        "custom theme pie",
      );
      assert.deepEqual(
        new Set(pie.paths.map((path) => path.fill)),
        new Set(
          customTheme.charts.slice(0, 3).map((hex) => {
            const value = hex.slice(1);
            return `rgb(${parseInt(value.slice(0, 2), 16)}, ${parseInt(value.slice(2, 4), 16)}, ${parseInt(value.slice(4, 6), 16)})`;
          }),
        ),
        "custom VS Code chart variables should color the pie sectors",
      );
    }
  }

  await dialog
    .getByRole("button", { name: "Next: Edit code", exact: true })
    .click();
  await preview(page);
  await page.setViewportSize({ width: 380, height: 640 });
  for (const selector of [
    ".mm-mermaid-back-to-templates",
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
  const navigationBox = await dialog
    .getByRole("button", { name: "Back to Mermaid templates", exact: true })
    .boundingBox();
  const titleBox = await dialog.locator("h2").boundingBox();
  assert.ok(
    navigationBox &&
      titleBox &&
      navigationBox.y + navigationBox.height <= titleBox.y,
    "template navigation should remain above the editor title on narrow screens",
  );
  await page.screenshot({ path: resolve(output, "narrow-code.png") });
  await dialog
    .getByRole("button", { name: "Back to Mermaid templates", exact: true })
    .click();
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
  for (const theme of themeCases) {
    const graphPreview = await applyThemeToOpenPreview(page, theme);
    await visibleLabels(
      graphPreview,
      labels["gitgraph-branch-merge"],
      "Git graph " + theme,
    );
    await assertGitGraphPresentation(graphPreview, "Git graph " + theme);
    const suffix = theme.id.replace("vscode-", "");
    await graphPreview.screenshot({
      path: resolve(presentationDirectory, `gitgraph-${suffix}.png`),
    });
    await graphPreview.screenshot({
      path: resolve(output, `gitgraph-${suffix}.png`),
    });
  }
  console.log(
    "Passed all 13 templates and 16 variants in four live themes, plus Git graph theme switching, Mindmap/Gantt captures, narrow layout, and lazy runtime loading",
  );
}

function millisecondsBetween(marks, firstName, secondName, templateId) {
  const find = (name) =>
    [...marks]
      .reverse()
      .find(
        (mark) =>
          mark.name === `markdown-mint-mermaid-template-${name}` &&
          mark.detail?.templateId === templateId,
      );
  const first = find(firstName);
  const second = find(secondName);
  return first && second ? second.startTime - first.startTime : 0;
}

async function waitForCandidateFrame(
  page,
  templateId,
  useAnimationFrame = false,
) {
  if (useAnimationFrame) {
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => resolve())),
    );
    return;
  }
  await page.waitForFunction(
    (id) =>
      performance
        .getEntriesByType("mark")
        .some(
          (entry) =>
            entry.name === "markdown-mint-mermaid-template-next-frame" &&
            entry.detail?.templateId === id,
        ),
    templateId,
  );
}

async function measureCandidateSelectionToPaint(page, templateIds, role) {
  return page.evaluate(
    ({ selector, ids, expectedRole }) => {
      const preview = document.querySelector(`${selector} .mm-mermaid-preview`);
      if (!preview) throw new Error("Mermaid candidate preview is missing.");
      const started = performance.now();
      return new Promise((resolve, reject) => {
        const observer = new MutationObserver(() => {
          if (preview.dataset.previewState !== "rendered") return;
          const svg = preview.querySelector("svg");
          if (
            !svg ||
            (expectedRole &&
              svg.getAttribute("aria-roledescription") !== expectedRole)
          )
            return;
          observer.disconnect();
          requestAnimationFrame(() => resolve(performance.now() - started));
        });
        observer.observe(preview, {
          attributes: true,
          childList: true,
          subtree: true,
        });
        for (const id of ids) {
          const option = document.querySelector(
            `${selector} [data-template-id="${id}"]`,
          );
          if (!option) {
            observer.disconnect();
            reject(new Error(`Mermaid candidate ${id} is missing.`));
            return;
          }
          option.click();
        }
      });
    },
    { selector: dialogSelector, ids: templateIds, expectedRole: role },
  );
}

function templateMarkdown(templates, buildSource, ids) {
  return ids
    .map((id) => {
      const template = templates.find((item) => item.id === id);
      assert.ok(template, `missing template ${id}`);
      return `## ${template.name}\n\n\`\`\`mermaid\n${buildSource(id)}\n\`\`\``;
    })
    .join("\n\n");
}

async function dedicatedPreviewChecks(page, templates, buildSource) {
  const ids = [
    "er-order",
    "pie-composition",
    "timeline-roadmap",
    "gantt-project",
    "mindmap-basic",
  ];
  const markdown = templateMarkdown(templates, buildSource, ids);
  await page.goto(`${baseUrl}/?mode=preview`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(() => window.markdownMint?.view);
  await applyTheme(page, themeCases[0]);
  await page.evaluate((source) => {
    window.__markdownMintHarness.deliverExternal(source, "github");
  }, markdown);
  await page.waitForFunction((count) => {
    const diagrams = Array.from(
      document.querySelectorAll(".mm-preview-panel .markdown-body .mm-mermaid"),
    );
    return (
      diagrams.length === count &&
      diagrams.every((diagram) => diagram.querySelector("svg"))
    );
  }, ids.length);
  const diagrams = page.locator(".mm-preview-panel .markdown-body .mm-mermaid");
  for (const [index, id] of ids.entries()) {
    const diagram = diagrams.nth(index);
    await visibleLabels(diagram, labels[id], `${id} dedicated preview`);
    await assertDiagramPresentation(
      diagram,
      id,
      themeCases[0].backdrop,
      `${id} dedicated preview`,
    );
  }
}

async function nativePreviewChecks(page) {
  await page.goto(`${baseUrl}/native.html?fixture=mermaid`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(() => {
    const diagrams = Array.from(
      document.querySelectorAll(".markdown-body .mm-mermaid"),
    );
    return (
      diagrams.length === 10 &&
      diagrams.every((diagram) => diagram.querySelector("svg"))
    );
  });
  for (const theme of themeCases) {
    const before = await page
      .locator(".markdown-body .mm-mermaid svg")
      .evaluateAll((svgs) => svgs.map((svg) => svg.getAttribute("style")));
    await applyTheme(page, theme);
    await page.waitForFunction((previous) => {
      const svgs = Array.from(
        document.querySelectorAll(".markdown-body .mm-mermaid svg"),
      );
      return (
        svgs.length === previous.length &&
        svgs.every(
          (svg, index) =>
            svg.closest(".mm-mermaid")?.dataset.mmMermaidState === "rendered" &&
            svg.getAttribute("style") !== previous[index],
        )
      );
    }, before);
    const content = page.locator(".markdown-body");
    await assertErPresentation(
      content.locator('.mm-mermaid:has(svg[aria-roledescription="er"])'),
      theme.backdrop,
      `native ER preview ${theme.id}`,
    );
    await assertPiePresentation(
      content.locator('.mm-mermaid:has(svg[aria-roledescription="pie"])'),
      theme.backdrop,
      `native pie preview ${theme.id}`,
    );
    await assertTimelinePresentation(
      content.locator('.mm-mermaid:has(svg[aria-roledescription="timeline"])'),
      theme.backdrop,
      `native timeline preview ${theme.id}`,
    );
    await assertGanttPresentation(
      content.locator('.mm-mermaid:has(svg[aria-roledescription="gantt"])'),
      theme.backdrop,
      `native Gantt preview ${theme.id}`,
    );
    await assertMindmapPresentation(
      content.locator('.mm-mermaid:has(svg[aria-roledescription="mindmap"])'),
      theme.backdrop,
      `native Mindmap preview ${theme.id}`,
    );
    const nativeClasses = content.locator(
      '.mm-mermaid:has(svg[aria-roledescription="classDiagram"])',
    );
    const nativeClass = nativeClasses.nth(0);
    await assertClassDiagramMarkerPresentation(
      nativeClass,
      theme.backdrop,
      `native class diagram ${theme.id}`,
    );
    const nativeClassLr = nativeClasses.nth(1);
    await visibleLabels(
      nativeClassLr,
      ["1", "many", "places"],
      `native LR class diagram ${theme.id}`,
    );
    await assertClassDiagramMarkerPresentation(
      nativeClassLr,
      theme.backdrop,
      `native LR class diagram ${theme.id}`,
      {
        expectedKinds: ["dependency"],
        minimumCards: 2,
        minimumRelations: 1,
      },
    );
    const nativeClassNeo = nativeClasses.nth(2);
    await assertClassDiagramMarkerPresentation(
      nativeClassNeo,
      theme.backdrop,
      `native neo class diagram ${theme.id}`,
      {
        minimumCards: 5,
        minimumRelations: 4,
        requireSuffixedHollowMarkerIds: true,
      },
    );
    const suffix = theme.id.replace("vscode-", "");
    await nativeClass.scrollIntoViewIfNeeded();
    await captureSvgPreview(
      page,
      nativeClass,
      resolve(output, `native-class-markers-${suffix}.png`),
    );
    await nativeClassLr.scrollIntoViewIfNeeded();
    await captureSvgPreview(
      page,
      nativeClassLr,
      resolve(output, `native-class-markers-lr-${suffix}.png`),
    );
  }
}

async function complexDiagramInputChecks(page, templates, buildSource) {
  await load(page);
  await applyTheme(page, themeCases[0]);
  let dialog = await open(page);
  await preview(page);
  await dialog.locator('[data-template-id="er-order"]').click();
  await dialog
    .getByRole("button", { name: "Next: Edit code", exact: true })
    .click();
  const erInput = dialog.locator(sourceSelector);
  const erSource = [
    "erDiagram",
    "    USER ||--o{ ORDER : places",
    "    USER {",
    '        int id PK "Primary key"',
    '        string name "Display name"',
    "    }",
    "    ORDER {",
    '        int id PK "Order identifier"',
    '        string status "Current state"',
    "    }",
  ].join("\n");
  await erInput.fill(erSource);
  const erPreview = await preview(page);
  await visibleLabels(
    erPreview,
    ["Primary key", "Display name"],
    "ER comments",
  );
  await assertErPresentation(erPreview, themeCases[0].backdrop, "ER comments");

  await load(page);
  await applyTheme(page, themeCases[0]);
  dialog = await open(page);
  await preview(page);
  await dialog.locator('[data-template-id="pie-composition"]').click();
  await dialog
    .getByRole("button", { name: "Next: Edit code", exact: true })
    .click();
  const pieInput = dialog.locator(sourceSelector);
  const duplicateShares = [
    "pie showData",
    "    title Equal category shares",
    '    "First" : 20',
    '    "Second" : 20',
    '    "Third" : 60',
  ].join("\n");
  await pieInput.fill(duplicateShares);
  let piePreview = await preview(page);
  const duplicatePresentation = await assertPiePresentation(
    piePreview,
    themeCases[0].backdrop,
    "duplicate percentage values",
  );
  const percentageLabels = await piePreview
    .locator("text.slice")
    .allTextContents();
  assert.ok(
    new Set(percentageLabels).size < percentageLabels.length,
    "the pie fixture must contain duplicate percentage labels",
  );
  assert.equal(duplicatePresentation.paths.length, 3);

  const reorderedShares = [
    "pie showData",
    "    title Reordered category shares",
    '    "First" : 60',
    '    "Second" : 20',
    '    "Third" : 20',
  ].join("\n");
  await pieInput.fill(reorderedShares);
  piePreview = await preview(page);
  await assertPiePresentation(
    piePreview,
    themeCases[0].backdrop,
    "reordered pie values",
  );

  await load(page);
  await applyTheme(page, themeCases[0]);
  dialog = await open(page);
  await preview(page);
  await dialog.locator('[data-template-id="timeline-roadmap"]').click();
  await dialog
    .getByRole("button", { name: "Next: Edit code", exact: true })
    .click();
  const timelineSource = [
    "timeline",
    "    title Roadmap without sections",
    "    2026-01 : Design",
    "    2026-02 : Build",
    "    2026-03 : Release",
  ].join("\n");
  await dialog.locator(sourceSelector).fill(timelineSource);
  const timelinePreview = await preview(page);
  await visibleLabels(
    timelinePreview,
    ["Roadmap without sections", "Design", "Build", "Release"],
    "sectionless timeline",
  );
  await assertTimelinePresentation(
    timelinePreview,
    themeCases[0].backdrop,
    "sectionless timeline",
    false,
  );
  console.log(
    "Passed ER key/type/comment labels, duplicate and reordered pie values, and a sectionless timeline through the validated user-input path",
  );
}

async function mindmapGanttFixtureChecks(page) {
  await load(page);
  await applyTheme(page, themeCases[0]);
  await instrumentMermaidRuntime(page);
  let dialog = await open(page);
  await preview(page);
  await dialog.locator('[data-template-id="mindmap-basic"]').click();
  await dialog
    .getByRole("button", { name: "Next: Edit code", exact: true })
    .click();
  const mindmapSource = [
    "mindmap",
    "    root((日本語の中心テーマ))",
    "        機能設計",
    "            入力と編集の流れをわかりやすく整理する長いラベル",
    "            表示設計<br/>二行目",
    "                モーダル内のプレビュー",
    "        利用者",
    "            開発チーム",
    "            読者",
  ].join("\n");
  await dialog.locator(sourceSelector).fill(mindmapSource);
  const mindmap = await preview(page);
  await visibleLabels(
    mindmap,
    [
      "日本語の中心テーマ",
      "機能設計",
      "入力と編集の流れ",
      "表示設計",
      "二行目",
      "モーダル内のプレビュー",
      "利用者",
      "開発チーム",
      "読者",
    ],
    "Japanese and deep mindmap fixture",
  );
  await assertMindmapPresentation(
    mindmap,
    themeCases[0].backdrop,
    "Japanese and deep mindmap fixture",
    { expectedNodes: 8, expectedEdges: 7 },
  );
  for (const theme of themeCases.slice(1)) {
    const before = await mermaidRuntimeStats(page);
    await applyTheme(page, theme);
    await page.waitForFunction(
      (renderCalls) =>
        window.__markdownMintMermaidTemplateStats?.renderCalls > renderCalls,
      before.renderCalls,
    );
    const themedMindmap = await preview(page);
    await assertMindmapPresentation(
      themedMindmap,
      theme.backdrop,
      `Japanese and deep Mindmap in ${theme.id}`,
      { expectedNodes: 8, expectedEdges: 7 },
    );
  }

  const dates = await page.evaluate(() => {
    const date = (offset) => {
      const value = new Date();
      value.setDate(value.getDate() + offset);
      const pad = (part) => String(part).padStart(2, "0");
      return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
    };
    return [-2, -1, 0, 1, 2, 4].map(date);
  });
  const ganttSource = [
    "gantt",
    "    title 日本語の短期リリース計画",
    "    dateFormat YYYY-MM-DD",
    "    axisFormat %m/%d",
    "    section 開発",
    `    仕様と実装をまとめて確認する長いタスク名 :long, ${dates[0]}, 1d`,
    `    Active critical task :active, crit, active, ${dates[1]}, 2d`,
    `    Done task :done, done, ${dates[2]}, 1d`,
    `    Release milestone :milestone, release, ${dates[3]}, 0d`,
    "    section 検証",
    `    Critical task :crit, critical, ${dates[4]}, 1d`,
  ].join("\n");
  await load(page);
  await applyTheme(page, themeCases[0]);
  await instrumentMermaidRuntime(page);
  dialog = await open(page);
  await preview(page);
  await dialog.locator('[data-template-id="gantt-project"]').click();
  await dialog
    .getByRole("button", { name: "Next: Edit code", exact: true })
    .click();
  await dialog.locator(sourceSelector).fill(ganttSource);
  const gantt = await preview(page);
  await visibleLabels(
    gantt,
    [
      "日本語の短期リリース計画",
      "開発",
      "検証",
      "仕様と実装をまとめて確認する長いタスク名",
      "Active critical task",
      "Done task",
      "Release milestone",
      "Critical task",
    ],
    "Gantt status and milestone fixture",
  );
  let ganttPresentation = await assertGanttPresentation(
    gantt,
    themeCases[0].backdrop,
    "Gantt status and milestone fixture",
    {
      expectedTaskCount: 5,
      checkDurationOrder: false,
      requireStatuses: true,
      requireSections: true,
      requireTodayInRange: true,
    },
  );
  assert.ok(
    ganttPresentation.labels.some((item) =>
      item.classes.includes("taskTextOutside"),
    ),
    "the long short-duration task should exercise an outside label",
  );
  for (const theme of themeCases.slice(1)) {
    const before = await mermaidRuntimeStats(page);
    await applyTheme(page, theme);
    await page.waitForFunction(
      (renderCalls) =>
        window.__markdownMintMermaidTemplateStats?.renderCalls > renderCalls,
      before.renderCalls,
    );
    const themedGantt = await preview(page);
    ganttPresentation = await assertGanttPresentation(
      themedGantt,
      theme.backdrop,
      `Gantt status and milestone fixture in ${theme.id}`,
      {
        expectedTaskCount: 5,
        checkDurationOrder: false,
        requireStatuses: true,
        requireSections: true,
        requireTodayInRange: true,
      },
    );
  }

  const outOfRangeSource = [
    "gantt",
    "    title Historical task range",
    "    dateFormat YYYY-MM-DD",
    "    axisFormat %Y-%m-%d",
    "    section Archive",
    "    Archived task :archive, 2000-01-01, 1d",
  ].join("\n");
  await dialog.locator(sourceSelector).fill(outOfRangeSource);
  const outOfRange = await preview(page);
  await assertGanttPresentation(
    outOfRange,
    themeCases.at(-1).backdrop,
    "Gantt out-of-range today fixture",
    {
      expectedTaskCount: 1,
      checkDurationOrder: false,
      requireTodayOutOfRange: true,
    },
  );
  console.log(
    "Passed Japanese/deep Mindmap geometry and Gantt short-duration labels, status colors, milestone, multiple sections, and today inside/outside the date range",
  );
}

async function classDiagramCachePerformanceChecks(page) {
  const missSamples = [];
  for (let index = 0; index < 20; index += 1) {
    await load(page);
    await applyTheme(page, themeCases[0]);
    await instrumentMermaidRuntime(page);
    const dialog = await open(page);
    await preview(page);
    await clearPerformanceMarks(page);
    const before = await mermaidRuntimeStats(page);
    const started = performance.now();
    const browserDisplayMs = await measureCandidateSelectionToPaint(
      page,
      ["class-basic"],
      "classDiagram",
    );
    await preview(page);
    const wallMs = performance.now() - started;
    const after = await mermaidRuntimeStats(page);
    assert.equal(
      await page
        .locator(`${dialogSelector} .mm-mermaid-preview`)
        .getAttribute("data-preview-cache"),
      "miss",
      "class diagram warm measurement must use a cache miss",
    );
    assert.equal(
      after.explicitValidationParses,
      before.explicitValidationParses,
      "class diagram cache miss ran input prevalidation",
    );
    assert.equal(after.renderCalls - before.renderCalls, 1);
    assert.equal(
      await dialog
        .locator(".mm-mermaid-preview svg")
        .getAttribute("aria-roledescription"),
      "classDiagram",
    );
    missSamples.push({
      browserDisplayMs,
      wallMs,
      renderMs: after.renderDurations.at(-1),
    });
  }

  await load(page);
  await applyTheme(page, themeCases[0]);
  await instrumentMermaidRuntime(page);
  const dialog = await open(page);
  await preview(page);
  await dialog.locator('[data-template-id="class-basic"]').click();
  await preview(page);
  assert.equal(
    await page
      .locator(`${dialogSelector} .mm-mermaid-preview`)
      .getAttribute("data-preview-cache"),
    "miss",
  );
  const hitSamples = [];
  for (let index = 0; index < 20; index += 1) {
    await dialog.locator('[data-template-id="flowchart-basic"]').click();
    await preview(page);
    await clearPerformanceMarks(page);
    const before = await mermaidRuntimeStats(page);
    const started = performance.now();
    const browserDisplayMs = await measureCandidateSelectionToPaint(
      page,
      ["class-basic"],
      "classDiagram",
    );
    await preview(page);
    const wallMs = performance.now() - started;
    const after = await mermaidRuntimeStats(page);
    assert.equal(
      await page
        .locator(`${dialogSelector} .mm-mermaid-preview`)
        .getAttribute("data-preview-cache"),
      "hit",
      "class diagram revisit must use its normalized SVG cache",
    );
    assert.equal(
      after.explicitValidationParses,
      before.explicitValidationParses,
    );
    assert.equal(after.renderCalls, before.renderCalls);
    hitSamples.push({ browserDisplayMs, wallMs });
  }

  return {
    conditions: "Headless Chrome 153, Light, 1280x900, 20 samples",
    cacheMiss: {
      mintPrevalidationCalls: 0,
      rendererCalls: 1,
      renderMs: distribution(missSamples.map((sample) => sample.renderMs)),
      selectionToDisplayMs: distribution(
        missSamples.map((sample) => sample.browserDisplayMs),
      ),
      playwrightRoundTripMs: distribution(
        missSamples.map((sample) => sample.wallMs),
      ),
    },
    cacheHit: {
      mintPrevalidationCalls: 0,
      rendererCalls: 0,
      selectionToDisplayMs: distribution(
        hitSamples.map((sample) => sample.browserDisplayMs),
      ),
      playwrightRoundTripMs: distribution(
        hitSamples.map((sample) => sample.wallMs),
      ),
    },
  };
}

async function templatePerformanceChecks(page) {
  const coldPage = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  coldPage.setDefaultTimeout(10000);
  await load(coldPage);
  await instrumentMermaidRuntime(coldPage);
  await clearPerformanceMarks(coldPage);
  const coldStarted = performance.now();
  const coldDialog = await open(coldPage);
  await preview(coldPage);
  await waitForCandidateFrame(coldPage, "flowchart-basic");
  const coldElapsed = performance.now() - coldStarted;
  const coldMarks = await candidatePerformanceMarks(coldPage);
  const coldStats = await mermaidRuntimeStats(coldPage);
  const runtimeResource = await coldPage.evaluate(
    () =>
      performance
        .getEntriesByType("resource")
        .find((entry) => entry.name.endsWith("/mermaid.js"))?.duration ?? 0,
  );
  assert.equal(coldStats.explicitValidationParses, 0);
  assert.equal(coldStats.renderCalls, 1);
  const firstUse = {
    openToDisplayedMs: Number(coldElapsed.toFixed(2)),
    runtimeResourceMs: Number((runtimeResource ?? 0).toFixed(2)),
    mintPrevalidationCalls: coldStats.explicitValidationParses,
    mintPrevalidationMs: 0,
    renderMs: Number(
      (
        millisecondsBetween(
          coldMarks,
          "render-start",
          "render-end",
          "flowchart-basic",
        ) ||
        coldStats.renderDurations[0] ||
        0
      ).toFixed(2),
    ),
  };
  await coldPage.close();

  const warmMissSamples = [];
  for (let index = 0; index < 20; index += 1) {
    await load(page);
    await applyTheme(page, themeCases[0]);
    await instrumentMermaidRuntime(page);
    const dialog = await open(page);
    await preview(page);
    await clearPerformanceMarks(page);
    const before = await mermaidRuntimeStats(page);
    const started = performance.now();
    const browserDisplayMs = await measureCandidateSelectionToPaint(
      page,
      ["er-order"],
      "er",
    );
    await preview(page);
    const wallMs = performance.now() - started;
    const marks = await candidatePerformanceMarks(page);
    const after = await mermaidRuntimeStats(page);
    assert.equal(
      after.explicitValidationParses,
      before.explicitValidationParses,
      "built-in cache miss ran user-input prevalidation",
    );
    assert.equal(
      await page
        .locator(`${dialogSelector} .mm-mermaid-preview`)
        .getAttribute("data-preview-cache"),
      "miss",
    );
    const candidateRenderCalls = after.renderCalls - before.renderCalls;
    assert.equal(candidateRenderCalls, 1);
    warmMissSamples.push({
      browserDisplayMs,
      wallMs,
      prevalidationCalls:
        after.explicitValidationParses - before.explicitValidationParses,
      renderCalls: candidateRenderCalls,
      mintPrevalidationMs: 0,
      renderMs:
        millisecondsBetween(marks, "render-start", "render-end", "er-order") ||
        after.renderDurations.at(-1),
      rendererMs: after.renderDurations.at(-1),
      renderToDomMs: millisecondsBetween(
        marks,
        "render-end",
        "dom",
        "er-order",
      ),
      selectionToDisplayMs: millisecondsBetween(
        marks,
        "selected",
        "next-frame",
        "er-order",
      ),
    });
  }

  let dialog = page.locator(dialogSelector);
  const currentErPreview = await preview(page);
  assert.equal(
    await currentErPreview.getAttribute("data-preview-cache"),
    "miss",
  );
  await dialog.locator('[data-template-id="flowchart-basic"]').click();
  await preview(page);
  await dialog.locator('[data-template-id="er-order"]').click();
  await preview(page);
  const hitSamples = [];
  for (let index = 0; index < 20; index += 1) {
    await dialog.locator('[data-template-id="flowchart-basic"]').click();
    await preview(page);
    await clearPerformanceMarks(page);
    const before = await mermaidRuntimeStats(page);
    const started = performance.now();
    const browserDisplayMs = await measureCandidateSelectionToPaint(
      page,
      ["er-order"],
      "er",
    );
    const cachedPreview = await preview(page);
    const wallMs = performance.now() - started;
    assert.equal(await cachedPreview.getAttribute("data-preview-cache"), "hit");
    const marks = await candidatePerformanceMarks(page);
    const after = await mermaidRuntimeStats(page);
    assert.equal(
      after.parseCalls,
      before.parseCalls,
      "cache hit parsed a candidate",
    );
    assert.equal(
      after.renderCalls,
      before.renderCalls,
      "cache hit rendered a candidate",
    );
    hitSamples.push({
      browserDisplayMs,
      wallMs,
      selectionToDisplayMs: millisecondsBetween(
        marks,
        "selected",
        "next-frame",
        "er-order",
      ),
      renderToDomMs: millisecondsBetween(marks, "selected", "dom", "er-order"),
    });
  }

  const burstSamples = [];
  for (let index = 0; index < 20; index += 1) {
    await load(page);
    await applyTheme(page, themeCases[0]);
    await instrumentMermaidRuntime(page);
    dialog = await open(page);
    await preview(page);
    await clearPerformanceMarks(page);
    const before = await mermaidRuntimeStats(page);
    const burstStarted = performance.now();
    const browserDisplayMs = await measureCandidateSelectionToPaint(
      page,
      ["sequence-alternative", "state-workflow", "pie-composition"],
      "pie",
    );
    await preview(page);
    const burstWallMs = performance.now() - burstStarted;
    const marks = await candidatePerformanceMarks(page);
    const after = await mermaidRuntimeStats(page);
    assert.equal(
      after.explicitValidationParses,
      before.explicitValidationParses,
      "built-in burst ran user-input prevalidation",
    );
    const burstRenderCalls = after.renderCalls - before.renderCalls;
    assert.ok(
      burstRenderCalls >= 1 && burstRenderCalls <= 2,
      `one running and one latest pending render expected, got ${burstRenderCalls}`,
    );
    assert.equal(
      await page
        .locator(`${dialogSelector} .mm-mermaid-preview svg`)
        .getAttribute("aria-roledescription"),
      "pie",
      "burst did not render the last selected candidate",
    );
    burstSamples.push({
      browserDisplayMs,
      wallMs: burstWallMs,
      prevalidationCalls:
        after.explicitValidationParses - before.explicitValidationParses,
      renderCalls: burstRenderCalls,
      lastSelectionToDisplayMs: millisecondsBetween(
        marks,
        "selected",
        "next-frame",
        "pie-composition",
      ),
      mintPrevalidationMs: 0,
      renderMs: millisecondsBetween(
        marks,
        "render-start",
        "render-end",
        "pie-composition",
      ),
      renderToDomMs: millisecondsBetween(
        marks,
        "render-end",
        "dom",
        "pie-composition",
      ),
    });
  }

  const classDiagramPerformance =
    await classDiagramCachePerformanceChecks(page);

  const summarize = (samples, key) =>
    distribution(samples.map((sample) => sample[key] ?? 0));
  const result = {
    browser: await page.evaluate(() => navigator.userAgent),
    viewport: "1280x900",
    firstUse,
    warmCacheMiss: {
      samples: warmMissSamples.length,
      mintPrevalidationCallsPerSample: summarize(
        warmMissSamples,
        "prevalidationCalls",
      ),
      rendererCallsPerSample: summarize(warmMissSamples, "renderCalls"),
      mintPrevalidationMs: 0,
      renderMs: summarize(warmMissSamples, "renderMs"),
      rendererMs: summarize(warmMissSamples, "rendererMs"),
      renderToDomMs: summarize(warmMissSamples, "renderToDomMs"),
      selectionToDisplayMs: summarize(warmMissSamples, "browserDisplayMs"),
      playwrightRoundTripMs: summarize(warmMissSamples, "wallMs"),
    },
    cacheHit: {
      samples: hitSamples.length,
      parseCalls: 0,
      renderCalls: 0,
      selectionToDomMs: summarize(hitSamples, "renderToDomMs"),
      selectionToDisplayMs: summarize(hitSamples, "browserDisplayMs"),
      playwrightRoundTripMs: summarize(hitSamples, "wallMs"),
    },
    rapidLatestOnlyBurst: {
      samples: burstSamples.length,
      mintPrevalidationCallsPerSample: summarize(
        burstSamples,
        "prevalidationCalls",
      ),
      rendererCallsPerSample: summarize(burstSamples, "renderCalls"),
      selectionToDisplayMs: summarize(burstSamples, "browserDisplayMs"),
      playwrightRoundTripMs: summarize(burstSamples, "wallMs"),
      mintPrevalidationMs: 0,
      renderMs: summarize(burstSamples, "renderMs"),
      renderToDomMs: summarize(burstSamples, "renderToDomMs"),
      endToEndMs: summarize(burstSamples, "wallMs"),
    },
    classDiagramGeometry: classDiagramPerformance,
  };
  console.log("Mermaid template performance (ms): " + JSON.stringify(result));
  return result;
}

async function templateRuntimeValidationChecks(page, templates, buildSource) {
  await load(page);
  const dialog = await open(page);
  await preview(page);
  const sources = templates.flatMap((template) =>
    (template.directions ?? [undefined]).map((direction) =>
      buildSource(template.id, direction ? { direction } : {}),
    ),
  );
  const detectedTypes = await page.evaluate(async (allSources) => {
    const runtime = window.markdownMintMermaid;
    if (!runtime || typeof runtime.parse !== "function")
      throw new Error("The packaged Mermaid parser is unavailable.");
    const types = [];
    for (const source of allSources) {
      const parsed = await Promise.resolve(runtime.parse(source.trim()));
      types.push(parsed?.diagramType ?? null);
    }
    return types;
  }, sources);
  assert.equal(sources.length, 16, "expected 13 templates and 16 variants");
  assert.equal(detectedTypes.length, sources.length);
  for (const [index, diagramType] of detectedTypes.entries())
    assert.ok(diagramType, `bundled parser rejected template variant ${index}`);
  console.log(
    `Release-gate test parsed all ${detectedTypes.length} built-in sources with the packaged Mermaid runtime; this test is separate from interactive candidate validation.`,
  );
  assert.equal(await dialog.isVisible(), true);
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
  let templatePreviewPerformance = null;
  if (!filter || "templateRuntimeValidationChecks".includes(filter))
    await templateRuntimeValidationChecks(
      page,
      getMermaidTemplates(),
      buildMermaidTemplateSource,
    );
  for (const check of [
    pickerUxChecks,
    interactionChecks,
    inputValidationChecks,
    guardChecks,
    themeChecks,
    complexDiagramInputChecks,
    mindmapGanttFixtureChecks,
    dedicatedPreviewChecks,
    nativePreviewChecks,
    templatePerformanceChecks,
  ]) {
    if (!filter || check.name.includes(filter)) {
      const result =
        check === complexDiagramInputChecks
          ? await check(page, getMermaidTemplates(), buildMermaidTemplateSource)
          : check === dedicatedPreviewChecks
            ? await check(
                page,
                getMermaidTemplates(),
                buildMermaidTemplateSource,
              )
            : await check(page);
      if (check === templatePerformanceChecks)
        templatePreviewPerformance = result;
    }
  }
  assert.deepEqual(external, [], "template flow requested external resources");
  await writeFile(
    resolve(output, "results.json"),
    JSON.stringify({ results, templatePreviewPerformance, external }, null, 2),
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
