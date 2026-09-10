import * as path from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * The formatter reads project files through this small interface so that the
 * extension can use vscode.workspace.fs for local and remote workspaces while
 * the policy itself remains easy to test without touching a user's files.
 */
export interface FormatterFileSystem {
  readonly readFile: (filePath: string) => Promise<string | undefined>;
}

export interface FormatterConfigResolver {
  readonly resolveConfigFile?: (
    filePath: string,
  ) => Promise<string | undefined>;
  readonly resolveTrustedConfig?: (
    filePath: string,
  ) => Promise<Record<string, unknown> | undefined>;
}

export interface FormatterConfigResult {
  readonly options: Record<string, unknown>;
  readonly ignored: boolean;
  readonly diagnostics: readonly string[];
  readonly configPath?: string;
}

const CONFIG_FILES = [
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.yaml",
  ".prettierrc.yml",
  "prettier.config.json",
  "prettier.config.yaml",
  "prettier.config.yml",
  ".prettierrc.js",
  ".prettierrc.cjs",
  ".prettierrc.mjs",
  "prettier.config.js",
  "prettier.config.cjs",
  "prettier.config.mjs",
  "package.json",
] as const;

const EXECUTABLE_CONFIG_RE = /\.(?:js|cjs|mjs)$/i;

/** Prettier options that affect Markdown output and are safe scalar values. */
const SAFE_OPTION_NAMES = new Set([
  "bracketSameLine",
  "bracketSpacing",
  "endOfLine",
  "embeddedLanguageFormatting",
  "htmlWhitespaceSensitivity",
  "insertPragma",
  "printWidth",
  "proseWrap",
  "quoteProps",
  "semi",
  "singleAttributePerLine",
  "singleQuote",
  "tabWidth",
  "trailingWhitespace",
  "useTabs",
]);

const KNOWN_END_OF_LINE = new Set(["lf", "crlf", "cr", "auto"]);
const KNOWN_PROSE_WRAP = new Set(["always", "never", "preserve"]);

/**
 * Resolve the nearest project formatter files and return only options that
 * can be passed to the bundled Markdown formatter. Executable JavaScript
 * configuration is never evaluated unless the caller marks the workspace
 * trusted and supplies a resolver for it.
 */
export async function loadFormatterConfig(
  filePath: string,
  fileSystem: FormatterFileSystem,
  options: {
    readonly workspaceRoot?: string;
    readonly isTrusted: boolean;
    readonly resolver?: FormatterConfigResolver;
  },
): Promise<FormatterConfigResult> {
  const diagnostics: string[] = [];
  const absoluteFile = path.resolve(filePath);
  const startDirectory = path.dirname(absoluteFile);
  const workspaceRoot = options.workspaceRoot
    ? path.resolve(options.workspaceRoot)
    : undefined;

  const configPath = await resolveConfigFile(
    absoluteFile,
    startDirectory,
    workspaceRoot,
    fileSystem,
    options.resolver?.resolveConfigFile,
  );
  let configOptions: Record<string, unknown> = {};
  if (configPath) {
    if (EXECUTABLE_CONFIG_RE.test(configPath)) {
      if (!options.isTrusted) {
        diagnostics.push(
          `Skipped executable Prettier config in the untrusted workspace: ${configPath}`,
        );
      } else if (options.resolver?.resolveTrustedConfig) {
        try {
          configOptions = sanitizeOptions(
            await options.resolver.resolveTrustedConfig(absoluteFile),
            absoluteFile,
          );
        } catch (error) {
          diagnostics.push(
            `Prettier executable config could not be loaded: ${formatError(error)}`,
          );
        }
      } else {
        diagnostics.push(
          `Skipped executable Prettier config because no trusted resolver is available: ${configPath}`,
        );
      }
    } else {
      const source = await fileSystem.readFile(configPath);
      if (source === undefined) {
        diagnostics.push(`Prettier config could not be read: ${configPath}`);
      } else {
        try {
          const parsed = parseConfig(source, configPath);
          configOptions = sanitizeOptions(
            selectConfigOptions(parsed, absoluteFile, path.dirname(configPath)),
            absoluteFile,
          );
        } catch (error) {
          diagnostics.push(
            `Prettier config could not be parsed (${configPath}): ${formatError(error)}`,
          );
        }
      }
    }
  }

  const editorConfigPaths = await findUpAll(
    ".editorconfig",
    startDirectory,
    workspaceRoot,
    fileSystem,
  );
  const editorConfigs: Array<{
    path: string;
    options: Record<string, unknown>;
    root: boolean;
  }> = [];
  for (const editorConfigPath of editorConfigPaths) {
    const source = await fileSystem.readFile(editorConfigPath);
    if (source === undefined) {
      diagnostics.push(`EditorConfig could not be read: ${editorConfigPath}`);
    } else {
      try {
        const editorConfig = parseEditorConfig(
          source,
          absoluteFile,
          path.dirname(editorConfigPath),
        );
        editorConfigs.push({
          path: editorConfigPath,
          options: editorConfig.options,
          root: editorConfig.root,
        });
        if (editorConfig.root) break;
      } catch (error) {
        diagnostics.push(
          `EditorConfig could not be parsed (${editorConfigPath}): ${formatError(error)}`,
        );
      }
    }
  }
  for (const editorConfig of editorConfigs.reverse()) {
    configOptions = { ...configOptions, ...editorConfig.options };
    void editorConfig.path;
  }

  const ignorePath = await findUp(
    ".prettierignore",
    startDirectory,
    workspaceRoot,
    fileSystem,
  );
  let ignored = false;
  if (ignorePath) {
    const source = await fileSystem.readFile(ignorePath);
    if (source === undefined) {
      diagnostics.push(`Prettier ignore file could not be read: ${ignorePath}`);
    } else {
      ignored = isIgnored(absoluteFile, source, path.dirname(ignorePath));
    }
  }

  return {
    options: configOptions,
    ignored,
    diagnostics,
    ...(configPath ? { configPath } : {}),
  };
}

async function resolveConfigFile(
  filePath: string,
  startDirectory: string,
  workspaceRoot: string | undefined,
  fileSystem: FormatterFileSystem,
  resolver: ((filePath: string) => Promise<string | undefined>) | undefined,
): Promise<string | undefined> {
  if (resolver) {
    try {
      const resolved = await resolver(filePath);
      if (resolved) return path.resolve(resolved);
    } catch {
      // The local, dependency-free walk below still handles JSON/YAML and
      // gives the caller a diagnostic only when the selected file is unreadable.
    }
  }
  for (const directory of ancestorDirectories(startDirectory, workspaceRoot)) {
    for (const fileName of CONFIG_FILES) {
      const candidate = path.join(directory, fileName);
      const source = await fileSystem.readFile(candidate);
      if (source === undefined) continue;
      if (fileName === "package.json") {
        try {
          const packageJson = JSON.parse(source) as unknown;
          if (!isRecord(packageJson) || !isRecord(packageJson.prettier))
            continue;
        } catch {
          continue;
        }
      }
      if (source !== undefined) return candidate;
    }
  }
  return undefined;
}

async function findUp(
  fileName: string,
  startDirectory: string,
  workspaceRoot: string | undefined,
  fileSystem: FormatterFileSystem,
): Promise<string | undefined> {
  for (const directory of ancestorDirectories(startDirectory, workspaceRoot)) {
    const candidate = path.join(directory, fileName);
    if ((await fileSystem.readFile(candidate)) !== undefined) return candidate;
  }
  return undefined;
}

async function findUpAll(
  fileName: string,
  startDirectory: string,
  workspaceRoot: string | undefined,
  fileSystem: FormatterFileSystem,
): Promise<string[]> {
  const result: string[] = [];
  for (const directory of ancestorDirectories(startDirectory, workspaceRoot)) {
    const candidate = path.join(directory, fileName);
    if ((await fileSystem.readFile(candidate)) !== undefined)
      result.push(candidate);
  }
  return result;
}

function ancestorDirectories(
  startDirectory: string,
  workspaceRoot: string | undefined,
): string[] {
  const result: string[] = [];
  let directory = path.resolve(startDirectory);
  const stop = workspaceRoot ? path.resolve(workspaceRoot) : undefined;
  while (true) {
    result.push(directory);
    if (directory === stop || directory === path.dirname(directory)) break;
    directory = path.dirname(directory);
  }
  return result;
}

function parseConfig(source: string, filePath: string): unknown {
  const trimmed = source.trim();
  if (trimmed.length === 0) return {};
  if (filePath.endsWith("package.json")) {
    const packageJson = JSON.parse(trimmed) as unknown;
    return isRecord(packageJson) && isRecord(packageJson.prettier)
      ? packageJson.prettier
      : {};
  }
  if (filePath.endsWith(".json") || /^[{[]/.test(trimmed))
    return JSON.parse(trimmed) as unknown;
  return parseYaml(trimmed) as unknown;
}

function selectConfigOptions(
  value: unknown,
  filePath: string,
  configDirectory: string,
): unknown {
  if (!isRecord(value)) return {};
  const result: Record<string, unknown> = { ...value };
  delete result.overrides;
  delete result.plugins;
  delete result.parser;
  const overrides = value.overrides;
  if (Array.isArray(overrides)) {
    for (const entry of overrides) {
      if (!isRecord(entry)) continue;
      const patterns = normalizePatterns(entry.files);
      const excluded = normalizePatterns(entry.excludeFiles);
      if (
        patterns.some((pattern) =>
          matchesGlob(path.relative(configDirectory, filePath), pattern),
        ) &&
        !excluded.some((pattern) =>
          matchesGlob(path.relative(configDirectory, filePath), pattern),
        )
      ) {
        const nested = isRecord(entry.options) ? entry.options : entry;
        for (const [key, option] of Object.entries(nested)) {
          if (key !== "files" && key !== "excludeFiles" && key !== "options")
            result[key] = option;
        }
      }
    }
  }
  return result;
}

function normalizePatterns(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (pattern): pattern is string => typeof pattern === "string",
  );
}

function sanitizeOptions(
  value: unknown,
  filePath: string,
): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, option] of Object.entries(value)) {
    if (!SAFE_OPTION_NAMES.has(key)) continue;
    if (typeof option === "string") {
      if (key === "endOfLine" && !KNOWN_END_OF_LINE.has(option)) continue;
      if (key === "proseWrap" && !KNOWN_PROSE_WRAP.has(option)) continue;
      result[key] = option;
    } else if (typeof option === "boolean") {
      result[key] = option;
    } else if (typeof option === "number" && Number.isFinite(option)) {
      result[key] = option;
    }
  }
  // Keep this argument in the signature for diagnostics/debugging without
  // allowing an arbitrary config path to enter the formatted source.
  void filePath;
  return result;
}

function parseEditorConfig(
  source: string,
  filePath: string,
  configDirectory: string,
): { options: Record<string, unknown>; root: boolean } {
  let patterns: string[] = ["*"];
  let root = false;
  const sections: Array<{
    patterns: string[];
    values: Record<string, string>;
  }> = [];
  let values: Record<string, string> = {};
  const flush = (): void => {
    sections.push({ patterns, values });
    values = {};
  };
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      flush();
      patterns = splitSectionPatterns(line.slice(1, -1));
      continue;
    }
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line
      .slice(separator + 1)
      .trim()
      .toLowerCase();
    if (
      key === "root" &&
      value === "true" &&
      patterns.length === 1 &&
      patterns[0] === "*"
    )
      root = true;
    else values[key] = value;
  }
  flush();
  const relative = path.relative(configDirectory, filePath);
  const selected: Record<string, string> = {};
  for (const section of sections) {
    if (
      section.patterns.some((pattern) =>
        matchesEditorConfigGlob(relative, pattern),
      )
    )
      Object.assign(selected, section.values);
  }
  const result: Record<string, unknown> = {};
  const endOfLine = selected.end_of_line;
  if (endOfLine && KNOWN_END_OF_LINE.has(endOfLine))
    result.endOfLine = endOfLine;
  const tabWidth = Number(selected.indent_size);
  if (Number.isSafeInteger(tabWidth) && tabWidth > 0 && tabWidth <= 32)
    result.tabWidth = tabWidth;
  if (selected.indent_style === "tab") result.useTabs = true;
  else if (selected.indent_style === "space") result.useTabs = false;
  return { options: result, root };
}

function isIgnored(
  filePath: string,
  source: string,
  rootDirectory: string,
): boolean {
  const relative = path
    .relative(rootDirectory, filePath)
    .split(path.sep)
    .join("/");
  if (!relative || relative.startsWith("../")) return false;
  let ignored = false;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    const pattern = (negated ? line.slice(1) : line).trim();
    if (!pattern) continue;
    const normalized = pattern.replace(/\\/g, "/");
    const directoryPattern = normalized.endsWith("/");
    const candidate = normalized.startsWith("/")
      ? relative
      : normalized.includes("/")
        ? relative
        : path.posix.basename(relative);
    const glob = normalized.replace(/^\/+/, "").replace(/\/+$/, "");
    if (
      matchesGlob(candidate, glob) ||
      (directoryPattern && relative.startsWith(`${glob.replace(/\*+$/, "")}/`))
    )
      ignored = !negated;
  }
  return ignored;
}

function matchesGlob(value: string, pattern: string): boolean {
  let normalized = pattern.replace(/\\/g, "/");
  normalized = normalized.replace(/^\/+/, "").replace(/\/+$/, "");
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const expression = escaped
    .replace(/\*\*/g, "§DOUBLE_STAR§")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/§DOUBLE_STAR§\//g, "(?:.*/)?")
    .replace(/§DOUBLE_STAR§/g, ".*");
  return new RegExp(`^${expression}$`, "i").test(value.replace(/\\/g, "/"));
}

function matchesEditorConfigGlob(value: string, pattern: string): boolean {
  if (pattern === "*") return true;
  const candidate = pattern.includes("/") ? value : path.posix.basename(value);
  return expandBraces(pattern).some((expanded) =>
    matchesGlob(candidate, expanded),
  );
}

function splitSectionPatterns(value: string): string[] {
  const result: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "{") depth += 1;
    else if (character === "}" && depth > 0) depth -= 1;
    else if (character === "," && depth === 0) {
      const pattern = value.slice(start, index).trim();
      if (pattern) result.push(pattern);
      start = index + 1;
    }
  }
  const finalPattern = value.slice(start).trim();
  if (finalPattern) result.push(finalPattern);
  return result;
}

function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf("{");
  if (open < 0) return [pattern];
  const close = pattern.indexOf("}", open + 1);
  if (close < 0) return [pattern];
  const choices = pattern
    .slice(open + 1, close)
    .split(",")
    .map((choice) => choice.trim())
    .filter(Boolean);
  if (choices.length === 0) return [pattern];
  return choices.flatMap((choice) =>
    expandBraces(
      `${pattern.slice(0, open)}${choice}${pattern.slice(close + 1)}`,
    ),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : String(error);
}
