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

describe("Copilot Language Server protocol", () => {
  it("keeps auto suggestions off by default and exposes only manual trigger and sign-in commands", () => {
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
        .map((command: { command: string }) => command.command)
        .sort(),
    ).toEqual([
      "markdownMint.aiSuggestions.signIn",
      "markdownMint.aiSuggestions.trigger",
    ]);
  });
  it("accepts source-position requests and bounded completion results", () => {
    expect(parseWebviewMessage(request)).toEqual(request);
    expect(isAiWebviewMessage(request)).toBe(true);
    expect(
      isHostMessage({
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
        candidateId: "c-1",
        partialAcceptanceOffset: 5,
        text: " world🌿",
        reason: "ready",
      }),
    ).toBe(true);
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
  ])("rejects malformed request %j", (patch) => {
    expect(parseWebviewMessage({ ...request, ...patch })).toBeUndefined();
  });
  it.each([
    { text: "x".repeat(32_769) },
    { text: "a\0b" },
    { text: "", reason: "ready" },
    { text: "text", reason: "failed" },
    { reason: "unknown" },
    { candidateId: undefined },
    { partialAcceptanceOffset: 32_769 },
  ])("rejects malformed result %j", (patch) => {
    expect(
      isHostMessage({
        ...request,
        type: "ai-suggestion-result",
        candidateId: "c-1",
        text: " next",
        reason: "ready",
        ...patch,
      }),
    ).toBe(false);
  });
  it("validates cancellation, status, trigger, and SDK feedback messages", () => {
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
      parseWebviewMessage({
        protocolVersion: 1,
        type: "ai-suggestion-feedback",
        sessionId: "s1",
        candidateId: "c-1",
        action: "partially-accepted",
        acceptedLength: 4,
      }),
    ).toBeDefined();
    expect(
      parseWebviewMessage({
        protocolVersion: 1,
        type: "ai-suggestion-feedback",
        sessionId: "s1",
        candidateId: "c-1",
        action: "partially-accepted",
        acceptedLength: -1,
      }),
    ).toBeUndefined();
    expect(
      isAiHostMessage({
        protocolVersion: 1,
        type: "ai-suggestion-state",
        sessionId: "s1",
        settingsGeneration: 1,
        autoTrigger: false,
        availability: "needs-sign-in",
        statusText: "Sign in",
      }),
    ).toBe(true);
    expect(
      isAiHostMessage({
        protocolVersion: 1,
        type: "ai-suggestion-trigger",
        sessionId: "s1",
        settingsGeneration: 1,
      }),
    ).toBe(true);
  });
});
