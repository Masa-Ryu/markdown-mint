import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveVSCodeExecutable } from "../../scripts/test-vscode.mjs";

const { download } = vi.hoisted(() => ({ download: vi.fn() }));
vi.mock("@vscode/test-electron", () => ({ downloadAndUnzipVSCode: download }));

describe("VS Code test executable selection", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mm-vscode-resolver-"));
    vi.stubEnv("MARKDOWN_MINT_VSCODE_VERSION", "stable");
    vi.stubEnv("MARKDOWN_MINT_CODE", "");
    download.mockReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  async function executable(relativePath: string): Promise<string> {
    const path = join(root, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "");
    await chmod(path, 0o755);
    // Metadata avoids launching a real process in this resolver-only test.
    const resources = join(root, "resources", "app");
    await mkdir(resources, { recursive: true });
    await writeFile(join(resources, "product.json"), '{"version":"1.143.1"}');
    return path;
  }

  it.each([
    "Code.exe",
    "code",
    "Visual Studio Code.app/Contents/MacOS/Electron",
  ])("preserves the downloaded executable %s", async (path) => {
    const expected = await executable(path);
    download.mockResolvedValue(expected);
    await expect(resolveVSCodeExecutable()).resolves.toBe(expected);
    expect(download).toHaveBeenCalledWith("stable");
  });

  it.each(["Code", "Code - Insiders"])(
    "resolves a renamed macOS bundle executable %s",
    async (name) => {
      const directory = "Visual Studio Code.app/Contents/MacOS";
      const expected = await executable(join(directory, name));
      download.mockResolvedValue(join(root, directory, "Electron"));
      await expect(resolveVSCodeExecutable()).resolves.toBe(expected);
    },
  );

  it("keeps an existing Electron executable when Code is also present", async () => {
    const directory = "Visual Studio Code.app/Contents/MacOS";
    const expected = await executable(join(directory, "Electron"));
    await executable(join(directory, "Code"));
    download.mockResolvedValue(expected);
    await expect(resolveVSCodeExecutable()).resolves.toBe(expected);
  });

  it("honors an explicit executable instead of downloading the selected version", async () => {
    const expected = await executable("explicit-code");
    vi.stubEnv("MARKDOWN_MINT_CODE", expected);
    await expect(resolveVSCodeExecutable()).resolves.toBe(expected);
    expect(download).not.toHaveBeenCalled();
  });

  it("rejects an invalid explicit path even when a renamed sibling exists", async () => {
    const directory = "Visual Studio Code.app/Contents/MacOS";
    await executable(join(directory, "Code"));
    vi.stubEnv("MARKDOWN_MINT_CODE", join(root, directory, "Electron"));
    await expect(resolveVSCodeExecutable()).rejects.toThrow(
      "VS Code executable is missing or not executable",
    );
    expect(download).not.toHaveBeenCalled();
  });

  it("reports a missing download executable instead of choosing an unrelated file", async () => {
    await executable("Code");
    download.mockResolvedValue(join(root, "Electron"));
    await expect(resolveVSCodeExecutable()).rejects.toThrow(
      "VS Code executable is missing or not executable",
    );
  });
});
