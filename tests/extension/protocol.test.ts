import { describe, expect, it } from "vitest";
import {
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
});
