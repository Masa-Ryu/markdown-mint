import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  isAiHostMessage,
  isAiWebviewMessage,
  type AiSuggestionRequest,
} from "../../src/shared/aiSuggestions";
import { isHostMessage, parseWebviewMessage } from "../../src/shared/protocol";

const request: AiSuggestionRequest = {
  protocolVersion: 1,
  type: "ai-suggestion-request",
  requestId: "r1",
  sessionId: "s1",
  documentId: "file:///prose.md",
  baseVersion: 1,
  editorRevision: 0,
  settingsGeneration: 0,
  position: 6,
  targetKind: "paragraph",
  trigger: "auto",
};

const result = {
  protocolVersion: 1,
  type: "ai-suggestion-result",
  requestId: request.requestId,
  sessionId: request.sessionId,
  documentId: request.documentId,
  baseVersion: request.baseVersion,
  editorRevision: request.editorRevision,
  settingsGeneration: request.settingsGeneration,
  position: request.position,
  targetKind: request.targetKind,
  text: " world🌿",
  reason: "ready",
} as const;

describe("VS Code Language Model suggestion protocol", () => {
  it("keeps auto suggestions off by default and exposes a manual command only", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    const properties = manifest.contributes.configuration.properties;
    expect(properties["markdownMint.aiSuggestions.autoTrigger"]).toMatchObject({
      default: false,
      scope: "application",
      type: "boolean",
    });
    expect(properties["markdownMint.aiSuggestions.model"]).toBeUndefined();
    expect(manifest.engines.vscode).toBe("^1.90.0");
    expect(manifest.extensionDependencies).toBeUndefined();
    expect(manifest.contributes.keybindings).toBeUndefined();
    expect(manifest.capabilities.untrustedWorkspaces.supported).toBe("limited");
    expect(
      manifest.contributes.commands
        .filter((command: { command: string }) =>
          command.command.startsWith("markdownMint.aiSuggestions."),
        )
        .map((command: { command: string }) => command.command),
    ).toEqual(["markdownMint.aiSuggestions.trigger"]);
  });

  it("accepts bounded auto/manual source-position requests and result messages", () => {
    expect(parseWebviewMessage(request)).toEqual(request);
    expect(isAiWebviewMessage(request)).toBe(true);
    const manualRequest = {
      ...request,
      trigger: "manual",
      invocationId: "manual-1",
    };
    expect(parseWebviewMessage(manualRequest)).toEqual(manualRequest);
    expect(isHostMessage(result)).toBe(true);
    expect(
      isHostMessage({
        protocolVersion: 1,
        type: "document",
        markdown: "Hi",
        version: 1,
        profile: "github",
      }),
    ).toBe(true);
  });

  it.each([
    { protocolVersion: 2 },
    { requestId: "" },
    { requestId: "x".repeat(161) },
    { requestId: "bad/id" },
    { sessionId: "../path" },
    { documentId: "" },
    { documentId: "x".repeat(2049) },
    { documentId: "a\0b" },
    { baseVersion: 0 },
    { baseVersion: 1.5 },
    { editorRevision: -1 },
    { settingsGeneration: NaN },
    { position: 4_000_001 },
    { targetKind: "code_block" },
    { trigger: "background" },
    { context: { before: "forged host context" } },
    { trigger: "manual", invocationId: undefined },
  ])("rejects malformed request %j", (patch) => {
    expect(parseWebviewMessage({ ...request, ...patch })).toBeUndefined();
  });

  it.each([
    { text: "x".repeat(32_769) },
    { text: "a\0b" },
    { text: "", reason: "ready" },
    { text: "text", reason: "failed" },
    { reason: "unknown" },
    { candidateId: "c-1" },
    { partialAcceptanceOffset: 5 },
  ])("rejects malformed result %j", (patch) => {
    expect(isHostMessage({ ...result, ...patch })).toBe(false);
  });

  it("validates cancellation, availability, and host-issued manual triggers", () => {
    expect(
      parseWebviewMessage({
        protocolVersion: 1,
        type: "ai-suggestion-cancel",
        sessionId: "s1",
        requestId: "r1",
      }),
    ).toBeDefined();
    expect(
      parseWebviewMessage({
        protocolVersion: 1,
        type: "ai-suggestion-cancel",
        sessionId: "s1",
      }),
    ).toBeUndefined();
    expect(
      isAiHostMessage({
        protocolVersion: 1,
        type: "ai-suggestion-state",
        sessionId: "s1",
        settingsGeneration: 1,
        autoTrigger: false,
        availability: "needs-authorization",
        statusText: "Authorization required",
      }),
    ).toBe(true);
    expect(
      isAiHostMessage({
        protocolVersion: 1,
        type: "ai-suggestion-trigger",
        sessionId: "s1",
        settingsGeneration: 1,
        invocationId: "manual-1",
      }),
    ).toBe(true);
    expect(
      isAiHostMessage({
        protocolVersion: 1,
        type: "ai-suggestion-trigger",
        sessionId: "s1",
        settingsGeneration: 1,
      }),
    ).toBe(false);
  });

  it("validates the request-snapshot handshake used after consent UI", () => {
    const check = {
      protocolVersion: 1,
      type: "ai-suggestion-snapshot-check",
      requestId: "r1",
      sessionId: "s1",
    };
    expect(isAiHostMessage(check)).toBe(true);
    expect(isHostMessage(check)).toBe(true);
    expect(isAiHostMessage({ ...check, unexpected: true })).toBe(false);

    const validation = {
      protocolVersion: 1,
      type: "ai-suggestion-snapshot-validation",
      requestId: "r1",
      sessionId: "s1",
      current: true,
    };
    expect(isAiWebviewMessage(validation)).toBe(true);
    expect(parseWebviewMessage(validation)).toEqual(validation);
    expect(isAiWebviewMessage({ ...validation, current: "yes" })).toBe(false);
    expect(isAiWebviewMessage({ ...validation, unexpected: true })).toBe(false);
  });
});
