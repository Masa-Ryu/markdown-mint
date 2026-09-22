import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const BROWSER_NAMES = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "microsoft-edge",
  "microsoft-edge-stable",
];

export class PdfBrowserExecutableNotFoundError extends Error {
  public constructor(message?: string) {
    super(
      message ??
        "PDF export requires Chrome, Edge, or Chromium. Install one of these browsers and try again. When using Remote SSH, WSL, or Dev Containers, the browser must be installed in the remote environment.",
    );
    this.name = "PdfBrowserExecutableNotFoundError";
  }
}

function envValue(
  env: NodeJS.ProcessEnv,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value) return value;
  }
  return undefined;
}

function pathCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string[] {
  const pathValue = envValue(env, "PATH", "Path");
  if (!pathValue) return [];
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  const names =
    platform === "win32"
      ? [
          "chrome.exe",
          "msedge.exe",
          "chromium.exe",
          ...BROWSER_NAMES.map((name) => `${name}.exe`),
          ...BROWSER_NAMES,
        ]
      : BROWSER_NAMES;
  return pathValue
    .split(platform === "win32" ? ";" : path.delimiter)
    .filter(Boolean)
    .flatMap((directory) => names.map((name) => join(directory, name)));
}

/** Return the platform candidates in browser preference order. */
export function getSystemChromiumCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = envValue(env, "HOME", "USERPROFILE") ?? os.homedir(),
): string[] {
  let candidates: string[];
  if (platform === "darwin") {
    const join = path.posix.join;
    candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      join(
        homeDirectory,
        "Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ),
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      join(
        homeDirectory,
        "Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      ),
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      join(homeDirectory, "Applications/Chromium.app/Contents/MacOS/Chromium"),
    ];
  } else if (platform === "win32") {
    const join = path.win32.join;
    const programFiles = envValue(env, "ProgramFiles", "PROGRAMFILES");
    const programFilesX86 = envValue(
      env,
      "ProgramFiles(x86)",
      "PROGRAMFILES(X86)",
    );
    const localAppData = envValue(env, "LOCALAPPDATA");
    const roots = [programFiles, programFilesX86, localAppData].filter(
      (value): value is string => Boolean(value),
    );
    candidates = [
      ...roots.map((root) =>
        join(root, "Google/Chrome/Application/chrome.exe"),
      ),
      ...roots.map((root) =>
        join(root, "Microsoft/Edge/Application/msedge.exe"),
      ),
      ...roots.map((root) => join(root, "Chromium/Application/chrome.exe")),
    ];
  } else if (platform === "linux") {
    candidates = [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge",
      "/usr/bin/microsoft-edge-stable",
      "/usr/local/bin/google-chrome",
      "/usr/local/bin/google-chrome-stable",
      "/usr/local/bin/chromium",
      "/usr/local/bin/chromium-browser",
      "/usr/local/bin/microsoft-edge",
      "/usr/local/bin/microsoft-edge-stable",
      "/snap/bin/chromium",
    ];
  } else {
    candidates = [];
  }

  return Array.from(new Set([...candidates, ...pathCandidates(platform, env)]));
}

async function isExecutable(
  candidate: string,
  platform: NodeJS.Platform,
): Promise<boolean> {
  try {
    await access(
      candidate,
      platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
}

export interface ResolvePdfBrowserExecutableOptions {
  readonly configuredPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly isExecutable?: (candidate: string) => Promise<boolean>;
}

/** Resolve an explicit executable first, then an installed system browser. */
export async function resolvePdfBrowserExecutable({
  configuredPath,
  platform = process.platform,
  env = process.env,
  isExecutable: check = (candidate) => isExecutable(candidate, platform),
}: ResolvePdfBrowserExecutableOptions = {}): Promise<string> {
  const configured = configuredPath?.trim();
  if (configured) {
    if (!(await check(configured)))
      throw new PdfBrowserExecutableNotFoundError(
        `The configured browser executable does not exist or cannot be launched: ${configured}`,
      );
    return configured;
  }

  for (const candidate of getSystemChromiumCandidates(platform, env)) {
    if (await check(candidate)) return candidate;
  }
  throw new PdfBrowserExecutableNotFoundError();
}
