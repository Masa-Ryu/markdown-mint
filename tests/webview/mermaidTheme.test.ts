import { describe, expect, it } from "vitest";
import {
  mermaidContrastRatio,
  mermaidDiagramColors,
  mermaidTextColorForBackground,
  type MermaidPalette,
} from "../../src/webview/mermaidTheme";

const themes: readonly MermaidPalette[] = [
  {
    background: "#ffffff",
    foreground: "#1f2328",
    surface: "#f6f8fa",
    line: "#57606a",
    accent: "#0969da",
    darkMode: false,
    highContrast: false,
    chartColors: [],
  },
  {
    background: "#1e1e1e",
    foreground: "#d4d4d4",
    surface: "#252526",
    line: "#9da5b4",
    accent: "#3794ff",
    darkMode: true,
    highContrast: false,
    chartColors: [],
  },
  {
    background: "#000000",
    foreground: "#ffffff",
    surface: "#000000",
    line: "#ffffff",
    accent: "#00a8ff",
    darkMode: true,
    highContrast: true,
    chartColors: [],
  },
  {
    background: "#ffffff",
    foreground: "#000000",
    surface: "#ffffff",
    line: "#000000",
    accent: "#0000ee",
    darkMode: false,
    highContrast: true,
    chartColors: [],
  },
];

describe("Mermaid chart and surface palette", () => {
  it("keeps chart colors distinct and pairs every chart color with readable text", () => {
    for (const palette of themes) {
      const colors = mermaidDiagramColors(palette);
      expect(new Set(colors.chart).size).toBe(12);
      expect(colors.chartText).toHaveLength(12);
      colors.chart.forEach((background, index) => {
        expect(
          mermaidContrastRatio(colors.chartText[index]!, background),
        ).toBeGreaterThanOrEqual(4.5);
      });
      for (const row of [colors.rowOdd, colors.rowEven])
        expect(
          mermaidContrastRatio(palette.foreground, row),
        ).toBeGreaterThanOrEqual(4.5);
      expect(colors.gantt.section).toBe(colors.rowOdd);
      expect(colors.gantt.alternateSection).toBe(colors.rowEven);
      for (const [text, surface] of [
        [colors.gantt.taskText, colors.gantt.task],
        [colors.gantt.activeTaskText, colors.gantt.activeTask],
        [colors.gantt.doneTaskText, colors.gantt.doneTask],
        [colors.gantt.criticalTaskText, colors.gantt.criticalTask],
      ] as const)
        expect(mermaidContrastRatio(text, surface)).toBeGreaterThanOrEqual(4.5);
      for (const [border, surface] of [
        [colors.gantt.taskBorder, colors.gantt.task],
        [colors.gantt.activeTaskBorder, colors.gantt.activeTask],
        [colors.gantt.doneTaskBorder, colors.gantt.doneTask],
        [colors.gantt.criticalTaskBorder, colors.gantt.criticalTask],
      ] as const)
        expect(mermaidContrastRatio(border, surface)).toBeGreaterThanOrEqual(3);
    }
  });

  it("uses the preferred text only when it meets the contrast threshold", () => {
    expect(mermaidTextColorForBackground("#0969da", "#ffffff")).toBe("#ffffff");
    expect(mermaidTextColorForBackground("#ffae57", "#ffffff")).toBe("#000000");
    expect(mermaidContrastRatio("rgba(0, 0, 0, 0.5)", "#ffffff")).toBeCloseTo(
      3.98,
      1,
    );
  });

  it("composites translucent diagram surfaces over a resolved theme backdrop", () => {
    const darkSurface = mermaidDiagramColors({
      ...themes[1]!,
      background: "#1e1e1e",
      surface: "rgba(127, 127, 127, 0.12)",
    }).surfaceOpaque;
    const lightSurface = mermaidDiagramColors({
      ...themes[0]!,
      background: "#ffffff",
      surface: "rgba(0, 0, 0, 0.06)",
    }).surfaceOpaque;
    const darkTransparent = mermaidDiagramColors({
      ...themes[1]!,
      background: "transparent",
      surface: "transparent",
    }).surfaceOpaque;
    const lightTransparent = mermaidDiagramColors({
      ...themes[0]!,
      background: "rgba(255, 255, 255, 0.5)",
      surface: "transparent",
    }).surfaceOpaque;
    const darkAlphaBackdrop = mermaidDiagramColors({
      ...themes[1]!,
      background: "rgba(0, 0, 0, 0.5)",
      surface: "transparent",
    }).surfaceOpaque;

    expect(darkSurface).toBe("#2a2a2a");
    expect(lightSurface).toBe("#f0f0f0");
    expect(darkTransparent).toBe("#1e1e1e");
    expect(lightTransparent).toBe("#ffffff");
    expect(darkAlphaBackdrop).toBe("#0f0f0f");
  });

  it("replaces duplicate custom chart colors to keep categories distinguishable", () => {
    const palette: MermaidPalette = {
      ...themes[0]!,
      chartColors: ["#0000ff", "#0000ff", "#00ff00"],
    };
    const colors = mermaidDiagramColors(palette);
    expect(colors.chart[0]).toBe("#0000ff");
    expect(colors.chart[1]).not.toBe(colors.chart[0]);
    expect(new Set(colors.chart).size).toBe(12);
    for (let index = 0; index < colors.chart.length; index += 1)
      expect(
        mermaidContrastRatio(colors.chartText[index]!, colors.chart[index]!),
      ).toBeGreaterThanOrEqual(4.5);
  });
});
