import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const browserMocks = vi.hoisted(() => ({
  computeExecutablePath: vi.fn(() => "/global/chromium/chrome"),
  install: vi.fn(
    async (_options: {
      downloadProgressCallback?: (
        downloadedBytes: number,
        totalBytes: number,
      ) => void;
    }) => ({ executablePath: "/global/chromium/chrome" }),
  ),
}));

vi.mock("@puppeteer/browsers", () => ({
  Browser: { CHROME: "chrome" },
  computeExecutablePath: browserMocks.computeExecutablePath,
  install: browserMocks.install,
}));

import {
  ChromiumExecutableNotFoundError,
  MANAGED_CHROMIUM_VERSION,
  getSystemChromiumCandidates,
  installManagedChromium,
  managedChromiumCachePath,
  resolveChromiumExecutable,
} from "../../../src/extension/export/chromium";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  browserMocks.computeExecutablePath.mockClear();
  browserMocks.install.mockClear();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Chromium executable resolution", () => {
  it("lists stable macOS candidates in preference order", () => {
    expect(getSystemChromiumCandidates("darwin", {}, "/Users/tester")).toEqual([
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Users/tester/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Users/tester/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Users/tester/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]);
  });

  it("lists Windows Chrome, Edge, and Chromium candidates", () => {
    expect(
      getSystemChromiumCandidates("win32", {
        ProgramFiles: "C:\\Program Files",
        "ProgramFiles(x86)": "C:\\Program Files (x86)",
        LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
      }),
    ).toEqual([
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Users\\tester\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Users\\tester\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Chromium\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe",
    ]);
  });

  it("includes Linux package and PATH candidates", () => {
    const candidates = getSystemChromiumCandidates("linux", {
      PATH: "/opt/chrome/bin:/usr/local/bin",
    });
    expect(candidates.slice(0, 7)).toEqual([
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge",
      "/usr/bin/microsoft-edge-stable",
      "/snap/bin/chromium",
    ]);
    expect(candidates).toContain("/opt/chrome/bin/google-chrome");
    expect(candidates).toContain("/usr/local/bin/microsoft-edge-stable");
  });

  it("uses a valid configured path before system and managed browsers", async () => {
    const isExecutable = vi.fn(
      async (candidate: string) => candidate === "/custom/chrome",
    );
    await expect(
      resolveChromiumExecutable({
        configuredPath: "/custom/chrome",
        globalStoragePath: "/global",
        platform: "linux",
        isExecutable,
      }),
    ).resolves.toBe("/custom/chrome");
    expect(isExecutable).toHaveBeenCalledExactlyOnceWith("/custom/chrome");
    expect(browserMocks.computeExecutablePath).not.toHaveBeenCalled();
  });

  it("fails an invalid configured path without silently falling back", async () => {
    const isExecutable = vi.fn(async () => false);
    await expect(
      resolveChromiumExecutable({
        configuredPath: "/missing/chrome",
        globalStoragePath: "/global",
        platform: "linux",
        isExecutable,
      }),
    ).rejects.toThrow("configured Chromium executable does not exist");
    expect(isExecutable).toHaveBeenCalledExactlyOnceWith("/missing/chrome");
    expect(browserMocks.computeExecutablePath).not.toHaveBeenCalled();
  });

  it("checks installed system browsers before the managed browser", async () => {
    const isExecutable = vi.fn(
      async (candidate: string) =>
        candidate === "/usr/bin/google-chrome-stable",
    );
    await expect(
      resolveChromiumExecutable({
        globalStoragePath: "/global",
        platform: "linux",
        env: {},
        isExecutable,
      }),
    ).resolves.toBe("/usr/bin/google-chrome-stable");
    expect(browserMocks.computeExecutablePath).not.toHaveBeenCalled();
  });

  it("uses the pinned managed browser only when no system browser exists", async () => {
    const isExecutable = vi.fn(
      async (candidate: string) => candidate === "/global/chromium/chrome",
    );
    await expect(
      resolveChromiumExecutable({
        globalStoragePath: "/global",
        platform: "linux",
        env: {},
        isExecutable,
      }),
    ).resolves.toBe("/global/chromium/chrome");
    expect(browserMocks.computeExecutablePath).toHaveBeenCalledWith({
      cacheDir: "/global/chromium",
      browser: "chrome",
      buildId: MANAGED_CHROMIUM_VERSION,
    });
    expect(managedChromiumCachePath("/global")).toBe("/global/chromium");
  });

  it("asks its caller to offer installation when no browser is installed", async () => {
    await expect(
      resolveChromiumExecutable({
        globalStoragePath: "/global",
        platform: "unsupported" as NodeJS.Platform,
        isExecutable: async () => false,
      }),
    ).rejects.toBeInstanceOf(ChromiumExecutableNotFoundError);
  });

  it("installs the fixed Chrome for Testing build only when called", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "markdown-mint-managed-chrome-"),
    );
    temporaryDirectories.push(directory);
    const progress = vi.fn();
    browserMocks.install.mockImplementation(async (options) => {
      options.downloadProgressCallback?.(50, 100);
      return { executablePath: "/installed/chrome" };
    });

    await expect(installManagedChromium(directory, progress)).resolves.toBe(
      "/installed/chrome",
    );
    expect(browserMocks.install).toHaveBeenCalledWith({
      browser: "chrome",
      buildId: MANAGED_CHROMIUM_VERSION,
      cacheDir: path.join(directory, "chromium"),
      downloadProgressCallback: progress,
    });
    expect(progress).toHaveBeenCalledWith(50, 100);
  });
});
