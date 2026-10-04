import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("pinned Copilot Language Server packages", () => {
  const manifest = JSON.parse(
    readFileSync(
      resolve(process.cwd(), "scripts/copilot-language-server-packages.json"),
      "utf8",
    ),
  ) as {
    version: string;
    license: { source: string; file: string; sha256: string };
    packages: Record<string, { integrity: string; binary: string }>;
  };

  it("pins the official server version and all six native platform artifacts", () => {
    expect(manifest.version).toBe("1.551.2");
    expect(Object.keys(manifest.packages)).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "win32-arm64",
      "win32-x64",
    ]);
    for (const [target, artifact] of Object.entries(manifest.packages)) {
      expect(artifact.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+={0,2}$/);
      expect(artifact.binary).toBe(
        target.startsWith("win32-")
          ? "copilot-language-server.exe"
          : "copilot-language-server",
      );
    }
  });

  it("pins the exact upstream MIT license shipped with each VSIX", () => {
    const license = readFileSync(resolve(process.cwd(), manifest.license.file));
    expect(manifest.license.source).toBe(
      "https://github.com/github/copilot-language-server-release/blob/1.551.2/LICENSE",
    );
    expect(createHash("sha256").update(license).digest("hex")).toBe(
      manifest.license.sha256,
    );
    expect(license.toString("utf8")).toContain("MIT License");
  });
});
