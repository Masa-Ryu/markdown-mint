export interface MermaidPalette {
  readonly background: string;
  readonly foreground: string;
  readonly surface: string;
  readonly line: string;
  readonly accent: string;
  readonly darkMode: boolean;
  readonly highContrast: boolean;
  readonly chartColors: readonly string[];
  readonly fontFamily?: string;
}

export interface MermaidDiagramColors {
  readonly chart: readonly string[];
  readonly chartText: readonly string[];
  readonly rowOdd: string;
  readonly rowEven: string;
}

interface RgbColor {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly alpha: number;
}

const LIGHT_CHART_COLORS = [
  "#0969da",
  "#bc4c00",
  "#1a7f37",
  "#cf222e",
  "#8250df",
  "#bf3989",
  "#007c84",
  "#9a6700",
  "#0550ae",
  "#6639ba",
  "#116329",
  "#a40e26",
] as const;

const DARK_CHART_COLORS = [
  "#4fc1ff",
  "#ffae57",
  "#89d185",
  "#f48771",
  "#b180d7",
  "#ee9bd3",
  "#4fe9d1",
  "#e5d85c",
  "#7db4ff",
  "#c6a0f6",
  "#a6df75",
  "#ff8b8b",
] as const;

const HIGH_CONTRAST_DARK_CHART_COLORS = [
  "#75beff",
  "#ffb454",
  "#86e89a",
  "#ff8080",
  "#d2a8ff",
  "#ff9bd1",
  "#4fe9d1",
  "#f2e55b",
  "#80c5ff",
  "#d0c8ff",
  "#c3f080",
  "#ffaaa5",
] as const;

const HIGH_CONTRAST_LIGHT_CHART_COLORS = [
  "#005fb8",
  "#924800",
  "#0f6a23",
  "#c74440",
  "#7030a0",
  "#a31570",
  "#005f60",
  "#7a5600",
  "#215f7f",
  "#50449e",
  "#374a95",
  "#7f1d1d",
] as const;

function parseChannel(value: string): number | null {
  const trimmed = value.trim();
  const number = Number.parseFloat(trimmed);
  if (!Number.isFinite(number)) return null;
  return trimmed.endsWith("%")
    ? Math.min(255, Math.max(0, (number / 100) * 255))
    : Math.min(255, Math.max(0, number));
}

function parseAlpha(value: string | undefined): number {
  if (value === undefined) return 1;
  const trimmed = value.trim();
  const number = Number.parseFloat(trimmed);
  if (!Number.isFinite(number)) return 1;
  return Math.min(
    1,
    Math.max(0, trimmed.endsWith("%") ? number / 100 : number),
  );
}

function hslToRgb(
  hue: number,
  saturation: number,
  lightness: number,
): RgbColor {
  const h = (((hue % 360) + 360) % 360) / 360;
  const s = Math.min(1, Math.max(0, saturation));
  const l = Math.min(1, Math.max(0, lightness));
  if (s === 0) {
    const channel = l * 255;
    return { red: channel, green: channel, blue: channel, alpha: 1 };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (offset: number): number => {
    let t = h + offset;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return {
    red: channel(1 / 3) * 255,
    green: channel(0) * 255,
    blue: channel(-1 / 3) * 255,
    alpha: 1,
  };
}

function parseCssColor(value: string): RgbColor | null {
  const color = value.trim().toLowerCase();
  if (color === "transparent") return { red: 0, green: 0, blue: 0, alpha: 0 };
  if (color === "black") return { red: 0, green: 0, blue: 0, alpha: 1 };
  if (color === "white") return { red: 255, green: 255, blue: 255, alpha: 1 };
  if (color === "gray" || color === "grey")
    return { red: 128, green: 128, blue: 128, alpha: 1 };

  const hex = /^#([0-9a-f]{3,8})$/i.exec(color)?.[1];
  if (hex) {
    const expanded =
      hex.length === 3 || hex.length === 4
        ? Array.from(hex, (part) => part + part).join("")
        : hex;
    if (expanded.length !== 6 && expanded.length !== 8) return null;
    return {
      red: Number.parseInt(expanded.slice(0, 2), 16),
      green: Number.parseInt(expanded.slice(2, 4), 16),
      blue: Number.parseInt(expanded.slice(4, 6), 16),
      alpha:
        expanded.length === 8
          ? Number.parseInt(expanded.slice(6, 8), 16) / 255
          : 1,
    };
  }

  const functionMatch = /^(rgba?|hsla?)\((.*)\)$/i.exec(color);
  if (!functionMatch) return null;
  const functionName = functionMatch[1]!;
  const parts = functionMatch[2]!
    .replace(/\s*\/\s*/, " ")
    .split(/[\s,]+/)
    .filter(Boolean);
  if (parts.length < 3) return null;
  if (functionName.startsWith("rgb")) {
    const red = parseChannel(parts[0]!);
    const green = parseChannel(parts[1]!);
    const blue = parseChannel(parts[2]!);
    if (red === null || green === null || blue === null) return null;
    return {
      red,
      green,
      blue,
      alpha: parseAlpha(parts[3]),
    };
  }

  const hue = Number.parseFloat(parts[0]!);
  const saturation = Number.parseFloat(parts[1]!);
  const lightness = Number.parseFloat(parts[2]!);
  if (
    !Number.isFinite(hue) ||
    !Number.isFinite(saturation) ||
    !Number.isFinite(lightness) ||
    !parts[1]!.endsWith("%") ||
    !parts[2]!.endsWith("%")
  )
    return null;
  return {
    ...hslToRgb(hue, saturation / 100, lightness / 100),
    alpha: parseAlpha(parts[3]),
  };
}

function composite(foreground: RgbColor, background: RgbColor): RgbColor {
  const alpha = foreground.alpha + background.alpha * (1 - foreground.alpha);
  if (alpha === 0) return { red: 0, green: 0, blue: 0, alpha: 0 };
  const channel = (front: number, back: number): number =>
    (front * foreground.alpha +
      back * background.alpha * (1 - foreground.alpha)) /
    alpha;
  return {
    red: channel(foreground.red, background.red),
    green: channel(foreground.green, background.green),
    blue: channel(foreground.blue, background.blue),
    alpha,
  };
}

function opaqueColor(
  value: string,
  backdrop: string,
  fallback: string,
): RgbColor {
  const base = parseCssColor(backdrop) ?? parseCssColor("white")!;
  const parsed = parseCssColor(value) ?? parseCssColor(fallback)!;
  return composite(parsed, base);
}

function rgbToHex(color: RgbColor): string {
  const hex = (channel: number): string =>
    Math.round(channel).toString(16).padStart(2, "0");
  return `#${hex(color.red)}${hex(color.green)}${hex(color.blue)}`;
}

function relativeLuminance(color: RgbColor): number {
  const linear = (channel: number): number => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * linear(color.red) +
    0.7152 * linear(color.green) +
    0.0722 * linear(color.blue)
  );
}

/** WCAG 2.2 relative contrast ratio after alpha colors are composited. */
export function mermaidContrastRatio(
  foreground: string,
  background: string,
): number {
  const backgroundColor = opaqueColor(background, "#ffffff", "#ffffff");
  const foregroundColor = composite(
    parseCssColor(foreground) ?? parseCssColor("#000000")!,
    backgroundColor,
  );
  const first = relativeLuminance(foregroundColor);
  const second = relativeLuminance(backgroundColor);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/** Keep a theme foreground when it meets normal-text contrast; otherwise use
 * the higher-contrast black or white against the exact colored surface. */
export function mermaidTextColorForBackground(
  background: string,
  preferredForeground: string,
  minimumRatio = 4.5,
): string {
  const preferred = rgbToHex(
    opaqueColor(preferredForeground, background, "#000000"),
  );
  if (mermaidContrastRatio(preferred, background) >= minimumRatio)
    return preferred;
  const blackRatio = mermaidContrastRatio("#000000", background);
  const whiteRatio = mermaidContrastRatio("#ffffff", background);
  return blackRatio >= whiteRatio ? "#000000" : "#ffffff";
}

function mixColors(
  first: string,
  second: string,
  secondWeight: number,
  backdrop: string,
): string {
  const firstColor = opaqueColor(first, backdrop, "#ffffff");
  const secondColor = opaqueColor(second, backdrop, "#000000");
  const weight = Math.min(1, Math.max(0, secondWeight));
  return rgbToHex({
    red: firstColor.red * (1 - weight) + secondColor.red * weight,
    green: firstColor.green * (1 - weight) + secondColor.green * weight,
    blue: firstColor.blue * (1 - weight) + secondColor.blue * weight,
    alpha: 1,
  });
}

export function mermaidDiagramColors(
  palette: MermaidPalette,
): MermaidDiagramColors {
  const defaults = palette.highContrast
    ? palette.darkMode
      ? HIGH_CONTRAST_DARK_CHART_COLORS
      : HIGH_CONTRAST_LIGHT_CHART_COLORS
    : palette.darkMode
      ? DARK_CHART_COLORS
      : LIGHT_CHART_COLORS;
  const seen = new Set<string>();
  const chart = defaults.map((fallback, index) => {
    let color = rgbToHex(
      opaqueColor(
        palette.chartColors[index] ?? fallback,
        palette.background,
        fallback,
      ),
    );
    if (seen.has(color.toLowerCase())) {
      const available = defaults.find(
        (candidate) => !seen.has(candidate.toLowerCase()),
      );
      color = available ?? fallback;
    }
    seen.add(color.toLowerCase());
    return color;
  });
  const chartText = chart.map((background) =>
    mermaidTextColorForBackground(background, palette.foreground),
  );
  const rowOdd = rgbToHex(
    opaqueColor(
      palette.surface,
      palette.background,
      palette.darkMode ? "#252526" : "#f6f8fa",
    ),
  );
  const rowEven = mixColors(
    rowOdd,
    palette.highContrast
      ? palette.foreground
      : palette.darkMode
        ? "#ffffff"
        : palette.line,
    palette.highContrast ? 0.06 : 0.08,
    palette.background,
  );
  return { chart, chartText, rowOdd, rowEven };
}
