/** Bounded protocol for host-owned Copilot Language Server requests. */
export const AI_LIMITS = {
  debounceMs: 300,
  deadlineMs: 35_000,
  maxDocumentLength: 4_000_000,
  maxCompletionLength: 32_768,
  maxCompletionCandidates: 10,
  maxRequestIdLength: 160,
} as const;

export const AI_AVAILABILITY = [
  "disabled",
  "preparing",
  "needs-sign-in",
  "ready",
  "untrusted",
  "excluded",
  "unavailable",
  "blocked",
] as const;
export type AiAvailability = (typeof AI_AVAILABILITY)[number];
export const AI_REASONS = [
  "ready",
  "disabled",
  "unsupported",
  "needs-sign-in",
  "untrusted",
  "blocked",
  "no-suggestion",
  "excluded",
  "unsafe-suggestion",
  "invalid-context",
  "failed",
  "timeout",
  "stale",
  "cancelled",
] as const;
export type AiSuggestionReason = (typeof AI_REASONS)[number];
export type AiTrigger = "auto" | "manual";
export type AiTargetKind = "paragraph" | "heading";

export interface AiSuggestionIdentity {
  readonly requestId: string;
  readonly sessionId: string;
  readonly documentId: string;
  readonly baseVersion: number;
  readonly editorRevision: number;
  readonly settingsGeneration: number;
  /** UTF-16 offset in the synchronized native Markdown document. */
  readonly position: number;
  readonly targetKind: AiTargetKind;
}
export interface AiSuggestionRequest extends AiSuggestionIdentity {
  readonly protocolVersion: 1;
  readonly type: "ai-suggestion-request";
  readonly trigger: AiTrigger;
}
export interface AiSuggestionCancel {
  readonly protocolVersion: 1;
  readonly type: "ai-suggestion-cancel";
  readonly requestId: string;
  readonly sessionId: string;
}
export interface AiSuggestionFeedback {
  readonly protocolVersion: 1;
  readonly type: "ai-suggestion-feedback";
  readonly requestId: string;
  readonly sessionId: string;
  readonly candidateId: string;
  readonly action: "shown" | "accepted" | "partially-accepted" | "rejected";
  readonly rejectionReason?: "unsafe-suggestion" | "cancelled";
  /** SDK-defined UTF-16 count from the original completion item's start. */
  readonly acceptedLength?: number;
}
export interface AiSuggestionCandidate {
  readonly candidateId: string;
  readonly text: string;
  readonly partialAcceptanceOffset?: number;
}
export interface AiSuggestionState {
  readonly protocolVersion: 1;
  readonly type: "ai-suggestion-state";
  readonly sessionId: string;
  readonly settingsGeneration: number;
  readonly autoTrigger: boolean;
  readonly availability: AiAvailability;
  readonly active?: boolean;
  readonly statusText?: string;
}
export interface AiSuggestionTrigger {
  readonly protocolVersion: 1;
  readonly type: "ai-suggestion-trigger";
  readonly sessionId: string;
  readonly settingsGeneration: number;
}
export interface AiSuggestionResult extends AiSuggestionIdentity {
  readonly protocolVersion: 1;
  readonly type: "ai-suggestion-result";
  readonly candidateId?: string;
  readonly partialAcceptanceOffset?: number;
  readonly candidates?: readonly AiSuggestionCandidate[];
  readonly text: string;
  readonly reason: AiSuggestionReason;
}
export type AiWebviewMessage =
  AiSuggestionRequest | AiSuggestionCancel | AiSuggestionFeedback;
export type AiHostMessage =
  AiSuggestionState | AiSuggestionTrigger | AiSuggestionResult;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function id(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= AI_LIMITS.maxRequestIdLength &&
    /^[a-zA-Z0-9._:-]+$/.test(value)
  );
}
function counter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function identity(value: Record<string, unknown>): boolean {
  return (
    id(value.requestId) &&
    id(value.sessionId) &&
    typeof value.documentId === "string" &&
    value.documentId.length > 0 &&
    value.documentId.length <= 2_048 &&
    !hasAsciiControl(value.documentId) &&
    counter(value.baseVersion) &&
    value.baseVersion > 0 &&
    counter(value.editorRevision) &&
    counter(value.settingsGeneration) &&
    counter(value.position) &&
    value.position <= AI_LIMITS.maxDocumentLength &&
    (value.targetKind === "paragraph" || value.targetKind === "heading")
  );
}
function validCompletionText(text: unknown): text is string {
  return (
    typeof text === "string" &&
    text.length <= AI_LIMITS.maxCompletionLength &&
    !hasCompletionControl(text)
  );
}

function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function hasCompletionControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      code === 0x7f
    )
      return true;
  }
  return false;
}

export function isAiWebviewMessage(value: unknown): value is AiWebviewMessage {
  if (!record(value) || value.protocolVersion !== 1) return false;
  if (value.type === "ai-suggestion-cancel")
    return (
      onlyKeys(value, ["protocolVersion", "type", "requestId", "sessionId"]) &&
      id(value.requestId) &&
      id(value.sessionId)
    );
  if (value.type === "ai-suggestion-feedback")
    return (
      onlyKeys(value, [
        "protocolVersion",
        "type",
        "requestId",
        "sessionId",
        "candidateId",
        "action",
        "acceptedLength",
        "rejectionReason",
      ]) &&
      id(value.requestId) &&
      id(value.sessionId) &&
      id(value.candidateId) &&
      (value.action === "shown" ||
        value.action === "accepted" ||
        (value.action === "rejected" &&
          (value.rejectionReason === "unsafe-suggestion" ||
            value.rejectionReason === "cancelled")) ||
        (value.action === "partially-accepted" &&
          counter(value.acceptedLength) &&
          value.acceptedLength > 0)) &&
      (value.rejectionReason === undefined || value.action === "rejected") &&
      (value.acceptedLength === undefined ||
        (counter(value.acceptedLength) && value.acceptedLength > 0))
    );
  return (
    value.type === "ai-suggestion-request" &&
    onlyKeys(value, [
      "protocolVersion",
      "type",
      "requestId",
      "sessionId",
      "documentId",
      "baseVersion",
      "editorRevision",
      "settingsGeneration",
      "position",
      "targetKind",
      "trigger",
    ]) &&
    identity(value) &&
    (value.trigger === "auto" || value.trigger === "manual")
  );
}
export function isAiHostMessage(value: unknown): value is AiHostMessage {
  if (!record(value) || value.protocolVersion !== 1) return false;
  if (value.type === "ai-suggestion-state")
    return (
      onlyKeys(value, [
        "protocolVersion",
        "type",
        "sessionId",
        "settingsGeneration",
        "autoTrigger",
        "availability",
        "active",
        "statusText",
      ]) &&
      id(value.sessionId) &&
      counter(value.settingsGeneration) &&
      typeof value.autoTrigger === "boolean" &&
      (value.active === undefined || typeof value.active === "boolean") &&
      (value.statusText === undefined ||
        (typeof value.statusText === "string" &&
          value.statusText.length <= 512)) &&
      AI_AVAILABILITY.includes(value.availability as AiAvailability)
    );
  if (value.type === "ai-suggestion-trigger")
    return (
      onlyKeys(value, [
        "protocolVersion",
        "type",
        "sessionId",
        "settingsGeneration",
      ]) &&
      id(value.sessionId) &&
      counter(value.settingsGeneration)
    );
  return (
    value.type === "ai-suggestion-result" &&
    onlyKeys(value, [
      "protocolVersion",
      "type",
      "requestId",
      "sessionId",
      "documentId",
      "baseVersion",
      "editorRevision",
      "settingsGeneration",
      "position",
      "targetKind",
      "candidateId",
      "partialAcceptanceOffset",
      "candidates",
      "text",
      "reason",
    ]) &&
    identity(value) &&
    validCompletionText(value.text) &&
    (value.candidateId === undefined || id(value.candidateId)) &&
    (value.partialAcceptanceOffset === undefined ||
      (counter(value.partialAcceptanceOffset) &&
        value.partialAcceptanceOffset <= AI_LIMITS.maxCompletionLength)) &&
    (value.candidates === undefined || validCandidates(value.candidates)) &&
    AI_REASONS.includes(value.reason as AiSuggestionReason) &&
    (value.reason === "ready"
      ? value.text.length > 0 &&
        id(value.candidateId) &&
        (value.candidates === undefined ||
          (value.candidates[0]?.candidateId === value.candidateId &&
            value.candidates[0]?.text === value.text))
      : value.text === "" &&
        value.candidateId === undefined &&
        value.candidates === undefined)
  );
}

function validCandidates(value: unknown): value is AiSuggestionCandidate[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > AI_LIMITS.maxCompletionCandidates
  )
    return false;
  return value.every(
    (candidate) =>
      record(candidate) &&
      onlyKeys(candidate, ["candidateId", "text", "partialAcceptanceOffset"]) &&
      id(candidate.candidateId) &&
      validCompletionText(candidate.text) &&
      candidate.text.length > 0 &&
      (candidate.partialAcceptanceOffset === undefined ||
        (counter(candidate.partialAcceptanceOffset) &&
          candidate.partialAcceptanceOffset <= AI_LIMITS.maxCompletionLength)),
  );
}
