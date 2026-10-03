import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  AI_LIMITS,
  aiContextHead,
  aiContextTail,
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
  context: { before: "Hello", after: "", heading: "" },
};
describe("AI protocol boundaries", () => {
  it("ships opt-in, application-scoped settings and commands without a new minimum engine or keybinding", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    const properties = manifest.contributes.configuration.properties;
    expect(properties["markdownMint.aiSuggestions.autoTrigger"]).toMatchObject({
      default: false,
      scope: "application",
      type: "boolean",
    });
    expect(properties["markdownMint.aiSuggestions.model"]).toMatchObject({
      default: "",
      scope: "application",
      type: "string",
    });
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
      "markdownMint.aiSuggestions.selectModel",
      "markdownMint.aiSuggestions.trigger",
    ]);
  });
  it("accepts automatic/manual requests and bounded host replies without changing existing document messages", () => {
    expect(parseWebviewMessage(request)).toEqual(request);
    expect(
      parseWebviewMessage({
        ...request,
        trigger: "manual",
        invocationId: "command-1",
      }),
    ).toBeDefined();
    expect(
      isHostMessage({
        ...request,
        type: "ai-suggestion-result",
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
    { baseVersion: Number.MAX_SAFE_INTEGER + 1 },
    { editorRevision: -1 },
    { settingsGeneration: NaN },
    { position: 0 },
    { position: 4_000_001 },
    { targetKind: "code_block" },
    { trigger: "background" },
    { trigger: "manual" },
    { invocationId: "forged" },
    { context: { before: "", after: "context", heading: "" } },
    {
      context: {
        before: "ok",
        after: "",
        heading: "",
        unbounded: "x".repeat(6001),
      },
    },
    {
      context: {
        before: "x".repeat(AI_LIMITS.before + 1),
        after: "",
        heading: "",
      },
    },
    {
      context: {
        before: "ok",
        after: "x".repeat(AI_LIMITS.after + 1),
        heading: "",
      },
    },
    {
      context: {
        before: "ok",
        after: "",
        heading: "x".repeat(AI_LIMITS.heading + 1),
      },
    },
  ])("rejects malformed request %j", (patch) => {
    expect(parseWebviewMessage({ ...request, ...patch })).toBeUndefined();
  });
  it.each([
    { text: "x".repeat(241) },
    { text: "🌿".repeat(241) },
    { text: "two\nlines" },
    { text: "a\0b" },
    { text: "", reason: "ready" },
    { text: "text", reason: "failed" },
    { reason: "unknown" },
    { targetKind: "heading", text: "x".repeat(81) },
  ])("rejects malformed result %j", (patch) => {
    expect(
      isHostMessage({
        ...request,
        type: "ai-suggestion-result",
        text: " next",
        reason: "ready",
        ...patch,
      }),
    ).toBe(false);
  });
  it("validates cancel, state, and one-time trigger payloads", () => {
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
    const state = {
      protocolVersion: 1,
      type: "ai-suggestion-state",
      sessionId: "s1",
      settingsGeneration: 0,
      autoTrigger: false,
      modelName: "Copilot",
      availability: "ready",
    };
    expect(isHostMessage(state)).toBe(true);
    expect(isHostMessage({ ...state, autoTrigger: "true" })).toBe(false);
    expect(isHostMessage({ ...state, availability: "invented" })).toBe(false);
    expect(
      isHostMessage({
        protocolVersion: 1,
        type: "ai-suggestion-trigger",
        sessionId: "s1",
        settingsGeneration: 1,
        invocationId: "c1",
      }),
    ).toBe(true);
  });
  it("never splits a surrogate pair at either context budget", () => {
    expect(aiContextHead("A🌿B", 2)).toBe("A");
    expect(aiContextTail("A🌿B", 2)).toBe("B");
    expect(aiContextHead("A🌿B", 3)).toBe("A🌿");
    expect(aiContextTail("A🌿B", 3)).toBe("🌿B");
  });
});
