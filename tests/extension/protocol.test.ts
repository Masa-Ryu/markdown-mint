import { describe, expect, it } from "vitest";
import {
  MAX_CLIPBOARD_TEXT_LENGTH,
  MAX_RESOURCE_URL_LENGTH,
  PROTOCOL_VERSION,
  isHostMessage,
  parseWebviewMessage,
} from "../../src/shared/protocol";

describe("Markdown Mint wire protocol", () => {
  it("accepts a versioned edit with a bounded operation id", () => {
    const message = parseWebviewMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: "edit",
      baseVersion: 3,
      operationId: "edit:3:abc",
      markdown: "# Updated\n",
    });

    expect(message).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      type: "edit",
      baseVersion: 3,
      operationId: "edit:3:abc",
      markdown: "# Updated\n",
    });
  });

  it("rejects unversioned, oversized, and unsafe payloads", () => {
    expect(
      parseWebviewMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "edit",
        baseVersion: 0,
        operationId: "edit:invalid",
        markdown: "candidate",
      }),
    ).toBeUndefined();
    expect(
      parseWebviewMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "edit",
        baseVersion: 1,
        operationId: "edit with spaces",
        markdown: "candidate",
      }),
    ).toBeUndefined();
    expect(
      parseWebviewMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "edit",
        baseVersion: 1,
        operationId: "edit:1:abc",
        markdown: "x".repeat(2_000_001),
      }),
    ).toBeUndefined();
  });

  it("distinguishes an acknowledgement from a stale recovery snapshot", () => {
    expect(
      isHostMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "document",
        markdown: "# Current\n",
        version: 5,
        profile: "github",
        reason: "ack",
        operationId: "edit:4:abc",
        resourceBaseUrl: "vscode-webview://resource/file:///workspace/",
      }),
    ).toBe(true);
    expect(
      isHostMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "document",
        markdown: "# Current\n",
        version: 5,
        profile: "github",
        reason: "recovery",
        draftMarkdown: "# Unsaved draft\n",
      }),
    ).toBe(true);
    expect(
      isHostMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "document",
        markdown: "# Current\n",
        version: 5,
        profile: "github",
        reason: "unknown",
      }),
    ).toBe(false);
  });

  it("validates a versioned save request and authoritative save result", () => {
    expect(
      parseWebviewMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "save",
        baseVersion: 5,
        operationId: "save:5:abc",
      }),
    ).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      type: "save",
      baseVersion: 5,
      operationId: "save:5:abc",
    });
    expect(
      isHostMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "save-result",
        operationId: "save:5:abc",
        saved: true,
        requestedVersion: 5,
        savedVersion: 6,
        version: 6,
        isDirty: false,
      }),
    ).toBe(true);
    expect(
      parseWebviewMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "save",
        baseVersion: 0,
        operationId: "save:bad",
      }),
    ).toBeUndefined();
  });

  it("accepts bounded user notifications without making them document state", () => {
    expect(
      parseWebviewMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "notify",
        level: "error",
        message: "The local draft needs attention.",
      }),
    ).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      type: "notify",
      level: "error",
      message: "The local draft needs attention.",
    });
    expect(
      parseWebviewMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "notify",
        level: "error",
        message: "x".repeat(1_025),
      }),
    ).toBeUndefined();
  });

  it("accepts all supported profile selections", () => {
    expect(
      parseWebviewMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "set-profile",
        profile: "gitlab",
        baseVersion: 5,
        operationId: "profile:5:gitlab",
      }),
    ).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      type: "set-profile",
      profile: "gitlab",
      baseVersion: 5,
      operationId: "profile:5:gitlab",
    });
    expect(
      parseWebviewMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "set-profile",
        profile: "commonmark",
        baseVersion: 5,
        operationId: "profile:5:commonmark",
      }),
    ).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      type: "set-profile",
      profile: "commonmark",
      baseVersion: 5,
      operationId: "profile:5:commonmark",
    });
    expect(
      parseWebviewMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "set-profile",
        profile: "github",
        baseVersion: 0,
        operationId: "profile:0:github",
      }),
    ).toBeUndefined();
    expect(
      parseWebviewMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "set-profile",
        profile: "github",
        baseVersion: 5,
        operationId: "profile with spaces",
      }),
    ).toBeUndefined();
  });

  it("validates clipboard requests and correlated host results", () => {
    expect(
      parseWebviewMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "clipboard-write",
        requestId: "copy:1:abc",
        text: "\tcode\n",
      }),
    ).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      type: "clipboard-write",
      requestId: "copy:1:abc",
      text: "\tcode\n",
    });
    expect(
      parseWebviewMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "clipboard-write",
        requestId: "copy:1:abc",
        text: "x".repeat(MAX_CLIPBOARD_TEXT_LENGTH + 1),
      }),
    ).toBeUndefined();
    expect(
      isHostMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "clipboard-result",
        requestId: "copy:1:abc",
        success: false,
        message: "Clipboard unavailable",
      }),
    ).toBe(true);
    expect(
      isHostMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "clipboard-result",
        requestId: "copy with spaces",
        success: true,
      }),
    ).toBe(false);
  });

  it("accepts a raw link href at the protocol boundary and enforces its cap", () => {
    const href = "../docs/guide.md#section";
    expect(
      parseWebviewMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "open-link",
        href,
      }),
    ).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      type: "open-link",
      href,
    });
    for (const validHref of [
      "https://example.com",
      "mailto:user@example.com",
      "../README.md",
      "./docs/guide.md",
      "/docs/guide.md",
    ]) {
      expect(
        parseWebviewMessage({
          protocolVersion: PROTOCOL_VERSION,
          type: "open-link",
          href: validHref,
        }),
      ).toMatchObject({
        protocolVersion: PROTOCOL_VERSION,
        type: "open-link",
        href: validHref,
      });
    }
    expect(
      parseWebviewMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "open-link",
        href: "x".repeat(MAX_RESOURCE_URL_LENGTH),
      }),
    ).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      type: "open-link",
      href: "x".repeat(MAX_RESOURCE_URL_LENGTH),
    });
    expect(
      parseWebviewMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "open-link",
        href: "x".repeat(MAX_RESOURCE_URL_LENGTH + 1),
      }),
    ).toBeUndefined();
    expect(
      parseWebviewMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "open-link",
        href: "",
      }),
    ).toBeUndefined();
    expect(
      parseWebviewMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "open-link",
        href: 42,
      }),
    ).toBeUndefined();
    expect(
      parseWebviewMessage({
        protocolVersion: PROTOCOL_VERSION + 1,
        type: "open-link",
        href,
      }),
    ).toBeUndefined();
  });

  it("validates bounded workspace file search requests and results", () => {
    expect(
      parseWebviewMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "workspace-file-search",
        requestId: "file-search:1",
        query: "hoge",
        filter: "image",
      }),
    ).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      type: "workspace-file-search",
      requestId: "file-search:1",
      query: "hoge",
      filter: "image",
    });
    expect(
      isHostMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "workspace-file-search-result",
        requestId: "file-search:1",
        candidates: [
          {
            fileName: "hoge manual.pdf",
            directory: "specs/",
            relativePath: "../specs/hoge%20manual.pdf",
          },
        ],
      }),
    ).toBe(true);
    expect(
      parseWebviewMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "workspace-file-search",
        requestId: "file-search:1",
        query: "x".repeat(257),
        filter: "all",
      }),
    ).toBeUndefined();
    expect(
      isHostMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "workspace-file-search-result",
        requestId: "file-search:1",
        candidates: [
          {
            fileName: "unsafe.md",
            directory: "docs/",
            relativePath: "./unsafe#fragment.md",
          },
        ],
      }),
    ).toBe(false);
  });
});
