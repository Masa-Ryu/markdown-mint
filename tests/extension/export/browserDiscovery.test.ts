import { describe, expect, it, vi } from "vitest";
import {
  PdfBrowserExecutableNotFoundError,
  getSystemChromiumCandidates,
  resolvePdfBrowserExecutable,
} from "../../../src/extension/export/browserDiscovery";

describe("system PDF browser discovery", () => {
  it("finds Chrome, Edge, and Chromium in Windows installation roots", () => {
    const candidates = getSystemChromiumCandidates("win32", {
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
    });
    expect(candidates).toContain(
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    );
    expect(candidates).toContain(
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    );
    expect(candidates).toContain(
      "C:\\Users\\tester\\AppData\\Local\\Chromium\\Application\\chrome.exe",
    );
  });

  it("finds the macOS system and per-user applications", () => {
    expect(getSystemChromiumCandidates("darwin", {}, "/Users/tester")).toEqual([
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Users/tester/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Users/tester/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Users/tester/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]);
  });

  it("finds Linux Chrome-family names in standard paths and PATH", () => {
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
      "/usr/local/bin/google-chrome",
    ]);
    expect(candidates).toContain("/opt/chrome/bin/google-chrome");
    expect(candidates).toContain("/opt/chrome/bin/microsoft-edge-stable");
  });

  it("searches Windows PATH using executable names", () => {
    const candidates = getSystemChromiumCandidates("win32", {
      PATH: "C:\\Tools;C:\\Browsers",
    });
    expect(candidates).toContain("C:\\Browsers\\chrome.exe");
    expect(candidates).toContain("C:\\Browsers\\microsoft-edge.exe");
  });

  it("checks an explicit configured path before all system candidates", async () => {
    const check = vi.fn(
      async (candidate: string) => candidate === "/custom/chrome",
    );
    await expect(
      resolvePdfBrowserExecutable({
        configuredPath: "/custom/chrome",
        platform: "linux",
        isExecutable: check,
      }),
    ).resolves.toBe("/custom/chrome");
    expect(check).toHaveBeenCalledExactlyOnceWith("/custom/chrome");
  });

  it("does not fall back when the configured path is invalid", async () => {
    const check = vi.fn(async () => false);
    await expect(
      resolvePdfBrowserExecutable({
        configuredPath: "/missing/chrome",
        platform: "linux",
        isExecutable: check,
      }),
    ).rejects.toBeInstanceOf(PdfBrowserExecutableNotFoundError);
    expect(check).toHaveBeenCalledExactlyOnceWith("/missing/chrome");
  });

  it("resolves the first executable system candidate", async () => {
    const check = vi.fn(
      async (candidate: string) => candidate === "/usr/bin/microsoft-edge",
    );
    await expect(
      resolvePdfBrowserExecutable({
        platform: "linux",
        env: {},
        isExecutable: check,
      }),
    ).resolves.toBe("/usr/bin/microsoft-edge");
  });

  it("reports a clear error when no browser is installed", async () => {
    await expect(
      resolvePdfBrowserExecutable({
        platform: "unsupported" as NodeJS.Platform,
        isExecutable: async () => false,
      }),
    ).rejects.toThrow("PDF export requires Chrome, Edge, or Chromium");
  });
});
