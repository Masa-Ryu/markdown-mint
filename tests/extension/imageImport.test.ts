import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_IMPORT_BYTES,
  PROTOCOL_VERSION,
  type ImageImportMessage,
} from "../../src/shared/protocol";
import {
  decodeImageImportBase64,
  saveImageImport,
  type ImageImportDependencies,
  type ImageImportUriLike,
} from "../../src/extension/imageImport";

class TestUri implements ImageImportUriLike {
  public constructor(
    public readonly scheme: string,
    public readonly path: string,
  ) {}

  public toString(): string {
    return `${this.scheme}:${this.path}`;
  }
}

class TestFileSystem {
  readonly directories = new Set<string>();
  readonly files = new Map<string, Uint8Array>();
  failWrite = false;
  failRename = false;
  holdWrites = false;
  writeFileCalls = 0;
  readonly renameTargets: string[] = [];
  private writeReleases: Array<() => void> = [];

  async createDirectory(uri: TestUri): Promise<void> {
    this.directories.add(uri.toString());
  }

  async writeFile(uri: TestUri, bytes: Uint8Array): Promise<void> {
    this.writeFileCalls += 1;
    if (this.failWrite) throw new Error("disk full");
    if (this.holdWrites)
      await new Promise<void>((resolve) => {
        this.writeReleases.push(resolve);
        if (this.writeReleases.length < 2) return;
        this.holdWrites = false;
        const releases = this.writeReleases;
        this.writeReleases = [];
        for (const release of releases) release();
      });
    this.files.set(uri.toString(), new Uint8Array(bytes));
  }

  async rename(
    source: TestUri,
    target: TestUri,
    options: { readonly overwrite: boolean },
  ): Promise<void> {
    this.renameTargets.push(target.toString());
    if (this.failRename) throw new Error("permission denied");
    const targetKey = target.toString();
    if (!options.overwrite && this.files.has(targetKey))
      throw Object.assign(new Error("already exists"), { code: "FileExists" });
    const sourceKey = source.toString();
    const bytes = this.files.get(sourceKey);
    if (!bytes)
      throw Object.assign(new Error("not found"), { code: "FileNotFound" });
    this.files.set(targetKey, new Uint8Array(bytes));
    this.files.delete(sourceKey);
  }

  async delete(uri: TestUri): Promise<void> {
    if (this.files.delete(uri.toString())) return;
    throw Object.assign(new Error("not found"), { code: "FileNotFound" });
  }
}

function joinPath(base: TestUri, ...parts: string[]): TestUri {
  const segments = base.path.split("/");
  for (const part of parts) {
    if (part === "..") segments.pop();
    else if (part && part !== ".") segments.push(part);
  }
  const path = segments.join("/").replace(/\/\/+/g, "/") || "/";
  return new TestUri(base.scheme, path);
}

function dependencies(fileSystem = new TestFileSystem()): {
  deps: ImageImportDependencies<TestUri>;
  fileSystem: TestFileSystem;
} {
  return {
    fileSystem,
    deps: { fs: fileSystem, joinPath },
  };
}

function request(
  overrides: Partial<
    Pick<ImageImportMessage, "requestId" | "fileName" | "mimeType" | "base64">
  > = {},
): ImageImportMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "image-import",
    requestId: "image:1",
    fileName: "architecture.png",
    mimeType: "image/png",
    base64: "AA==",
    ...overrides,
  };
}

describe("Extension Host image import", () => {
  it("creates images and writes a new image beside the Markdown document", async () => {
    const { deps, fileSystem } = dependencies();
    const result = await saveImageImport(
      new TestUri("file", "/workspace/docs/README.md"),
      request(),
      deps,
    );

    expect(result).toEqual({
      success: true,
      relativePath: "./images/architecture.png",
    });
    expect(fileSystem.directories).toContain("file:/workspace/docs/images");
    expect(
      fileSystem.files.get("file:/workspace/docs/images/architecture.png"),
    ).toEqual(new Uint8Array([0]));
  });

  it("increments duplicate names without overwriting existing images", async () => {
    const { deps, fileSystem } = dependencies();
    fileSystem.files.set(
      "file:/workspace/docs/images/architecture.png",
      new Uint8Array([1]),
    );
    fileSystem.files.set(
      "file:/workspace/docs/images/architecture-1.png",
      new Uint8Array([2]),
    );

    const result = await saveImageImport(
      new TestUri("file", "/workspace/docs/README.md"),
      request(),
      deps,
    );

    expect(result).toEqual({
      success: true,
      relativePath: "./images/architecture-2.png",
    });
    expect(
      fileSystem.files.get("file:/workspace/docs/images/architecture.png"),
    ).toEqual(new Uint8Array([1]));
    expect(
      fileSystem.files.get("file:/workspace/docs/images/architecture-1.png"),
    ).toEqual(new Uint8Array([2]));
    expect(
      [...fileSystem.files.keys()].some((key) =>
        key.includes(".markdown-mint-image-"),
      ),
    ).toBe(false);
  });

  it("writes image bytes once while retrying several collision-safe names", async () => {
    const { deps, fileSystem } = dependencies();
    for (const [suffix, byte] of [
      ["", 1],
      ["-1", 2],
      ["-2", 3],
    ] as const)
      fileSystem.files.set(
        `file:/workspace/docs/images/architecture${suffix}.png`,
        new Uint8Array([byte]),
      );

    const result = await saveImageImport(
      new TestUri("file", "/workspace/docs/README.md"),
      request(),
      deps,
    );

    expect(result).toEqual({
      success: true,
      relativePath: "./images/architecture-3.png",
    });
    expect(fileSystem.writeFileCalls).toBe(1);
    expect(fileSystem.renameTargets).toEqual([
      "file:/workspace/docs/images/architecture.png",
      "file:/workspace/docs/images/architecture-1.png",
      "file:/workspace/docs/images/architecture-2.png",
      "file:/workspace/docs/images/architecture-3.png",
    ]);
    expect(
      [...fileSystem.files.keys()].some((key) =>
        key.includes(".markdown-mint-image-"),
      ),
    ).toBe(false);
  });

  it("atomically keeps both payloads for concurrent imports with the same name", async () => {
    const fileSystem = new TestFileSystem();
    fileSystem.holdWrites = true;
    const { deps } = dependencies(fileSystem);
    const [first, second] = await Promise.all([
      saveImageImport(
        new TestUri("file", "/workspace/docs/README.md"),
        request({ requestId: "image:concurrent-1", base64: "AQ==" }),
        deps,
      ),
      saveImageImport(
        new TestUri("file", "/workspace/docs/OTHER.md"),
        request({ requestId: "image:concurrent-2", base64: "Ag==" }),
        deps,
      ),
    ]);

    expect(
      [first, second]
        .map((result) =>
          result.success ? result.relativePath : "unexpected failure",
        )
        .sort(),
    ).toEqual(["./images/architecture-1.png", "./images/architecture.png"]);
    expect(
      fileSystem.files.get("file:/workspace/docs/images/architecture.png"),
    ).toEqual(new Uint8Array([1]));
    expect(
      fileSystem.files.get("file:/workspace/docs/images/architecture-1.png"),
    ).toEqual(new Uint8Array([2]));
    expect(
      [...fileSystem.files.keys()].some((key) =>
        key.includes(".markdown-mint-image-"),
      ),
    ).toBe(false);
  });

  it("URL-encodes only the returned basename while preserving the real file name", async () => {
    const { deps, fileSystem } = dependencies();
    const fileName = "architecture #2%?.png";
    const result = await saveImageImport(
      new TestUri("file", "/workspace/docs/README.md"),
      request({ fileName }),
      deps,
    );

    expect(result).toEqual({
      success: true,
      relativePath: "./images/architecture%20%232%25%3F.png",
    });
    expect(
      fileSystem.files.get(`file:/workspace/docs/images/${fileName}`),
    ).toEqual(new Uint8Array([0]));
  });

  it("keeps collision suffixes within the 255-character file name limit", async () => {
    const { deps, fileSystem } = dependencies();
    const fileName = `${"a".repeat(251)}.png`;
    fileSystem.files.set(
      `file:/workspace/docs/images/${fileName}`,
      new Uint8Array([1]),
    );

    const result = await saveImageImport(
      new TestUri("file", "/workspace/docs/README.md"),
      request({ fileName }),
      deps,
    );

    const targetName = `${"a".repeat(249)}-1.png`;
    expect(result).toEqual({
      success: true,
      relativePath: `./images/${targetName}`,
    });
    expect(targetName.length).toBe(255);
    expect(
      fileSystem.files.get(`file:/workspace/docs/images/${targetName}`),
    ).toEqual(new Uint8Array([0]));
  });

  it.each([
    ["../escape.png", "image/png"],
    ["nested/escape.png", "image/png"],
    ["escape\\file.png", "image/png"],
  ])("rejects unsafe file name %s", async (fileName, mimeType) => {
    const { deps, fileSystem } = dependencies();
    const result = await saveImageImport(
      new TestUri("file", "/workspace/docs/README.md"),
      request({ fileName, mimeType }),
      deps,
    );

    expect(result.success).toBe(false);
    expect(fileSystem.directories.size).toBe(0);
    expect(fileSystem.files.size).toBe(0);
  });

  it("rejects unsupported extensions and MIME types", async () => {
    const { deps: extensionDeps } = dependencies();
    const unsupportedExtension = await saveImageImport(
      new TestUri("file", "/workspace/docs/README.md"),
      request({ fileName: "diagram.svg", mimeType: "image/svg+xml" }),
      extensionDeps,
    );
    expect(unsupportedExtension).toMatchObject({ success: false });

    const { deps: mimeDeps } = dependencies();
    const unsupportedMime = await saveImageImport(
      new TestUri("file", "/workspace/docs/README.md"),
      request({ mimeType: "image/svg+xml" }),
      mimeDeps,
    );
    expect(unsupportedMime).toMatchObject({ success: false });
  });

  it("rejects oversized and malformed payloads before creating a directory", async () => {
    const { deps, fileSystem } = dependencies();
    const oversized = await saveImageImport(
      new TestUri("file", "/workspace/docs/README.md"),
      request({
        base64: "A".repeat(Math.ceil(MAX_IMAGE_IMPORT_BYTES / 3) * 4 + 4),
      }),
      deps,
    );
    expect(oversized).toMatchObject({ success: false });
    expect(oversized).toMatchObject({
      message: expect.stringContaining("10 MB"),
    });
    expect(fileSystem.directories.size).toBe(0);

    expect(decodeImageImportBase64("")).toEqual(new Uint8Array());
    expect(() => decodeImageImportBase64("not base64?")).toThrow(
      "valid base64",
    );
  });

  it.each([
    ["zero-byte image", { base64: "" }, "empty"],
    [
      "generic MIME for a PNG",
      { mimeType: "application/octet-stream" },
      "MIME type",
    ],
  ])(
    "returns a semantic failure for %s before filesystem creation",
    async (_, overrides, message) => {
      const { deps, fileSystem } = dependencies();
      const result = await saveImageImport(
        new TestUri("file", "/workspace/docs/README.md"),
        request(overrides),
        deps,
      );

      expect(result).toMatchObject({
        success: false,
        message: expect.stringContaining(message),
      });
      expect(fileSystem.directories.size).toBe(0);
      expect(fileSystem.files.size).toBe(0);
    },
  );

  it("returns a write error without claiming that the image was imported", async () => {
    const fileSystem = new TestFileSystem();
    fileSystem.failWrite = true;
    const { deps } = dependencies(fileSystem);
    const result = await saveImageImport(
      new TestUri("file", "/workspace/docs/README.md"),
      request(),
      deps,
    );

    expect(result).toEqual({ success: false, message: "disk full" });
    expect(fileSystem.files.size).toBe(0);
  });

  it("cleans the temporary file when the final rename fails", async () => {
    const fileSystem = new TestFileSystem();
    fileSystem.failRename = true;
    const { deps } = dependencies(fileSystem);
    const result = await saveImageImport(
      new TestUri("file", "/workspace/docs/README.md"),
      request(),
      deps,
    );

    expect(result).toEqual({ success: false, message: "permission denied" });
    expect(fileSystem.files.size).toBe(0);
  });

  it("rejects a document without a safe writable directory", async () => {
    const { deps, fileSystem } = dependencies();
    const result = await saveImageImport(
      new TestUri("untitled", "draft.md"),
      request(),
      deps,
    );

    expect(result).toMatchObject({ success: false });
    expect(fileSystem.directories.size).toBe(0);
  });
});
