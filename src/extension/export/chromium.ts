import { constants as fsConstants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Browser, computeExecutablePath, install } from "@puppeteer/browsers";

/** Keep the managed browser release independent from Puppeteer dependency updates. */
export const MANAGED_CHROMIUM_VERSION = "153.0.8010.12";

export class ChromiumExecutableNotFoundError extends Error {
  public constructor() {
    super(
      "PDF export requires Chromium in the Markdown Mint extension host environment. Remote SSH, Dev Containers, and WSL require Chromium on that remote host.",
    );
    this.name = "ChromiumExecutableNotFoundError";
  }
}

export interface ResolveChromiumExecutableOptions {
  readonly configuredPath?: string;
  readonly globalStoragePath: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly isExecutable?: (candidate: string) => Promise<boolean>;
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

/** Return browser candidates in deterministic preference order for each OS. */
export function getSystemChromiumCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): string[] {
  if (platform === "darwin") {
    const join = path.posix.join;
    return [
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
  }

  if (platform === "win32") {
    const join = path.win32.join;
    const programFiles = envValue(env, "ProgramFiles", "PROGRAMFILES");
    const programFilesX86 = envValue(
      env,
      "ProgramFiles(x86)",
      "PROGRAMFILES(X86)",
    );
    const localAppData = envValue(env, "LOCALAPPDATA");
    return [
      programFiles &&
        join(programFiles, "Google/Chrome/Application/chrome.exe"),
      programFilesX86 &&
        join(programFilesX86, "Google/Chrome/Application/chrome.exe"),
      localAppData &&
        join(localAppData, "Google/Chrome/Application/chrome.exe"),
      programFiles &&
        join(programFiles, "Microsoft/Edge/Application/msedge.exe"),
      programFilesX86 &&
        join(programFilesX86, "Microsoft/Edge/Application/msedge.exe"),
      localAppData &&
        join(localAppData, "Microsoft/Edge/Application/msedge.exe"),
      programFiles && join(programFiles, "Chromium/Application/chrome.exe"),
      programFilesX86 &&
        join(programFilesX86, "Chromium/Application/chrome.exe"),
    ].filter((candidate): candidate is string => Boolean(candidate));
  }

  if (platform === "linux") {
    const candidates = [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge",
      "/usr/bin/microsoft-edge-stable",
      "/snap/bin/chromium",
    ];
    const pathValue = envValue(env, "PATH", "Path");
    if (pathValue) {
      const names = [
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
        "microsoft-edge",
        "microsoft-edge-stable",
      ];
      for (const directory of pathValue.split(path.delimiter))
        if (directory)
          for (const name of names) candidates.push(path.join(directory, name));
    }
    return Array.from(new Set(candidates));
  }

  return [];
}

export function managedChromiumCachePath(globalStoragePath: string): string {
  return path.join(globalStoragePath, "chromium");
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

/** Resolve configured, system, then managed Chromium without downloading. */
export async function resolveChromiumExecutable({
  configuredPath,
  globalStoragePath,
  platform = process.platform,
  env = process.env,
  isExecutable: check = (candidate) => isExecutable(candidate, platform),
}: ResolveChromiumExecutableOptions): Promise<string> {
  const configured = configuredPath?.trim();
  if (configured) {
    if (!(await check(configured)))
      throw new Error(
        `The configured Chromium executable does not exist or cannot be launched: ${configured}`,
      );
    return configured;
  }

  for (const candidate of getSystemChromiumCandidates(platform, env))
    if (await check(candidate)) return candidate;

  let managedPath: string | undefined;
  try {
    managedPath = computeExecutablePath({
      cacheDir: managedChromiumCachePath(globalStoragePath),
      browser: Browser.CHROME,
      buildId: MANAGED_CHROMIUM_VERSION,
    });
  } catch {
    // The browser package can reject platforms that it does not support.
  }
  if (managedPath && (await check(managedPath))) return managedPath;
  throw new ChromiumExecutableNotFoundError();
}

export type ChromiumDownloadProgress = (
  downloadedBytes: number,
  totalBytes: number,
) => void;

/** Install the pinned browser. Call only after the user chooses the install action. */
export async function installManagedChromium(
  globalStoragePath: string,
  onProgress?: ChromiumDownloadProgress,
): Promise<string> {
  const cacheDir = managedChromiumCachePath(globalStoragePath);
  await mkdir(cacheDir, { recursive: true });
  const installed = await install({
    browser: Browser.CHROME,
    buildId: MANAGED_CHROMIUM_VERSION,
    cacheDir,
    ...(onProgress ? { downloadProgressCallback: onProgress } : {}),
  });
  return installed.executablePath;
}
