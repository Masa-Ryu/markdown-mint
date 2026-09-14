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

  async createDirectory(uri: TestUri): Promise<void> {
    this.directories.add(uri.toString());
  }

  async stat(uri: TestUri): Promise<unknown> {
    if (this.directories.has(uri.toString()) || this.files.has(uri.toString()))
      return {};
    throw Object.assign(new Error("not found"), { code: "FileNotFound" });
  }

  async writeFile(uri: TestUri, bytes: Uint8Array): Promise<void> {
    if (this.failWrite) throw new Error("disk full");
    this.files.set(uri.toString(), new Uint8Array(bytes));
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
    Pick<ImageImportMessage, "fileName" | "mimeType" | "base64">
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

    expect(() => decodeImageImportBase64("not base64?")).toThrow(
      "valid base64",
    );
  });

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
