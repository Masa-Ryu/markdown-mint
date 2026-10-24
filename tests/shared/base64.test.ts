import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_IMPORT_BASE64_LENGTH,
  MAX_IMAGE_IMPORT_BYTES,
  PROTOCOL_VERSION,
  parseWebviewMessage,
} from "../../src/shared/protocol";
import { decodeImageImportBase64 } from "../../src/extension/imageImport";

function imageImportMessage(base64: string): unknown {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "image-import",
    requestId: "image:base64-test",
    fileName: "sample.png",
    mimeType: "image/png",
    base64,
  };
}

describe("bounded image Base64 validation", () => {
  it.each([1, 2, 5, 10])(
    "accepts and decodes a %i MiB image through the real protocol and decoder",
    (mib) => {
      const source = Buffer.alloc(mib * 1024 * 1024, 0xaa);
      const base64 = source.toString("base64");

      expect(parseWebviewMessage(imageImportMessage(base64))).toMatchObject({
        type: "image-import",
        base64,
      });
      expect(Buffer.from(decodeImageImportBase64(base64)).equals(source)).toBe(
        true,
      );
    },
  );

  it("rejects decoded bytes above the limit even when encoded length is allowed", () => {
    const base64 = Buffer.alloc(MAX_IMAGE_IMPORT_BYTES + 1, 0xaa).toString(
      "base64",
    );

    expect(base64.length).toBe(MAX_IMAGE_IMPORT_BASE64_LENGTH);
    expect(parseWebviewMessage(imageImportMessage(base64))).toBeUndefined();
    expect(() => decodeImageImportBase64(base64)).toThrow("10 MB");
  });

  it("rejects encoded payloads above the limit before scanning their contents", () => {
    const base64 = "A".repeat(MAX_IMAGE_IMPORT_BASE64_LENGTH + 4);

    expect(parseWebviewMessage(imageImportMessage(base64))).toBeUndefined();
    expect(() => decodeImageImportBase64(base64)).toThrow("10 MB");
  });

  it.each([
    "A",
    "AA=A",
    "A===",
    "AA===",
    " AA==",
    "AA== ",
    "-A==",
    "_A==",
    "AA==junk",
  ])("rejects malformed Base64 %j", (base64) => {
    expect(parseWebviewMessage(imageImportMessage(base64))).toBeUndefined();
    expect(() => decodeImageImportBase64(base64)).toThrow("valid base64");
  });

  it("preserves empty Base64 acceptance at the protocol and decoder boundary", () => {
    expect(parseWebviewMessage(imageImportMessage(""))).toMatchObject({
      type: "image-import",
      base64: "",
    });
    expect(decodeImageImportBase64("")).toEqual(new Uint8Array());
  });
});
