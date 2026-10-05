/** Bounded host/webview protocol for public VS Code Language Model requests. */
import { MAX_MERMAID_SOURCE_LENGTH } from "./mermaid";

export const AI_LIMITS = {
  debounceMs: 300,
  deadlineMs: 35_000,
  snapshotCheckDeadlineMs: 3_000,
  modelValidationDeadlineMs: 3_000,
  maxDocumentLength: 4_000_000,
  maxCompletionLength: 32_768,
  maxRequestIdLength: 160,
  maxCodeLanguageLength: 64,
} as const;

export const AI_AVAILABILITY = [
  "disabled",
  "preparing",
  "needs-authorization",
  "ready",
  "untrusted",
  "no-model",
  "unavailable",
  "temporarily-unavailable",
  "blocked",
] as const;
export type AiAvailability = (typeof AI_AVAILABILITY)[number];
export const AI_REASONS = [
  "ready",
  "disabled",
  "unsupported",
  "needs-authorization",
  "untrusted",
  "blocked",
  "no-model",
  "no-suggestion",
  "unsafe-suggestion",
  "invalid-context",
  "failed",
  "timeout",
  "backoff",
  "stale",
  "cancelled",
] as const;
export type AiSuggestionReason = (typeof AI_REASONS)[number];
export type AiTrigger = "auto" | "manual";
export type AiTargetKind = "paragraph" | "heading" | "code" | "mermaid";

export interface AiSuggestionIdentity {
  readonly requestId: string;
  readonly sessionId: string;
  readonly documentId: string;
  readonly baseVersion: number;
  readonly editorRevision: number;
  readonly settingsGeneration: number;
  /** UTF-16 offset in the host-owned Markdown snapshot. */
  readonly position: number;
  readonly targetKind: AiTargetKind;
}
export interface AiSuggestionRequest extends AiSuggestionIdentity {
  readonly protocolVersion: 1;
  readonly type: "ai-suggestion-request";
  readonly trigger: AiTrigger;
  /** True only for auto requests scheduled after a real user text edit. */
  readonly afterUserInput?: boolean;
  /** Only host-issued manual triggers have an invocation id. */
  readonly invocationId?: string;
  /** Present only for source-code completions. Derived again from host Markdown. */
  readonly language?: string;
  /** Unsaved Mermaid editor draft; present only for Mermaid completions. */
  readonly surfaceText?: string;
  /** UTF-16 caret offset within surfaceText. Present only for Mermaid requests. */
  readonly surfacePosition?: number;
}
export interface AiSuggestionCancel {
  readonly protocolVersion: 1;
  readonly type: "ai-suggestion-cancel";
  readonly requestId: string;
  readonly sessionId: string;
}
export interface AiSuggestionSnapshotValidation {
  readonly protocolVersion: 1;
  readonly type: "ai-suggestion-snapshot-validation";
  readonly requestId: string;
  readonly sessionId: string;
  readonly current: boolean;
}
export interface AiSuggestionAdoptionCheck extends AiSuggestionIdentity {
  readonly protocolVersion: 1;
  readonly type: "ai-suggestion-adoption-check";
  readonly attemptId: string;
}
export interface AiSuggestionAdoptionValidation {
  readonly protocolVersion: 1;
  readonly type: "ai-suggestion-adoption-validation";
  readonly attemptId: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly available: boolean;
}
export interface AiSuggestionState {
  readonly protocolVersion: 1;
  readonly type: "ai-suggestion-state";
  readonly sessionId: string;
  readonly settingsGeneration: number;
  readonly autoTrigger: boolean;
  readonly availability: AiAvailability;
  /** Non-secret setup marker; this never represents model access permission. */
  readonly autoRestoreOnInput?: boolean;
  /** True when a model-list event requires user-initiated membership recheck. */
  readonly modelSelectionStale?: boolean;
  readonly active?: boolean;
  readonly statusText?: string;
  readonly modelName?: string;
}
export interface AiSuggestionToolbarAction {
  readonly protocolVersion: 1;
  readonly type: "ai-suggestion-toolbar-action";
  readonly sessionId: string;
}
export interface AiSuggestionTrigger {
  readonly protocolVersion: 1;
  readonly type: "ai-suggestion-trigger";
  readonly sessionId: string;
  readonly settingsGeneration: number;
  readonly invocationId: string;
}
export interface AiSuggestionSnapshotCheck {
  readonly protocolVersion: 1;
  readonly type: "ai-suggestion-snapshot-check";
  readonly requestId: string;
  readonly sessionId: string;
}
export interface AiSuggestionResult extends AiSuggestionIdentity {
  readonly protocolVersion: 1;
  readonly type: "ai-suggestion-result";
  readonly text: string;
  readonly reason: AiSuggestionReason;
}
export type AiWebviewMessage =
  | AiSuggestionRequest
  | AiSuggestionCancel
  | AiSuggestionToolbarAction
  | AiSuggestionSnapshotValidation
  | AiSuggestionAdoptionCheck;
export type AiHostMessage =
  | AiSuggestionState
  | AiSuggestionTrigger
  | AiSuggestionSnapshotCheck
  | AiSuggestionAdoptionValidation
  | AiSuggestionResult;

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
    (value.targetKind === "paragraph" ||
      value.targetKind === "heading" ||
      value.targetKind === "code" ||
      value.targetKind === "mermaid")
  );
}
function validRequestTarget(value: Record<string, unknown>): boolean {
  if (value.targetKind === "paragraph" || value.targetKind === "heading")
    return (
      value.language === undefined &&
      value.surfaceText === undefined &&
      value.surfacePosition === undefined
    );
  if (value.targetKind === "code")
    return (
      value.surfaceText === undefined &&
      value.surfacePosition === undefined &&
      (value.language === undefined || validCodeLanguage(value.language))
    );
  if (value.targetKind !== "mermaid") return false;
  return (
    value.language === undefined &&
    typeof value.surfaceText === "string" &&
    value.surfaceText.length <= MAX_MERMAID_SOURCE_LENGTH &&
    !hasForbiddenControl(value.surfaceText) &&
    counter(value.surfacePosition) &&
    value.surfacePosition <= value.surfaceText.length &&
    !isLowSurrogate(value.surfaceText.charCodeAt(value.surfacePosition))
  );
}
function validCodeLanguage(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= AI_LIMITS.maxCodeLanguageLength &&
    !hasAsciiControl(value)
  );
}
function validCompletionText(value: unknown): value is string {
  if (typeof value !== "string" || value.length > AI_LIMITS.maxCompletionLength)
    return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      code === 0x7f
    )
      return false;
  }
  return true;
}
function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
function hasForbiddenControl(value: string): boolean {
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
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export function isAiWebviewMessage(value: unknown): value is AiWebviewMessage {
  if (!record(value) || value.protocolVersion !== 1) return false;
  if (value.type === "ai-suggestion-toolbar-action")
    return (
      onlyKeys(value, ["protocolVersion", "type", "sessionId"]) &&
      id(value.sessionId)
    );
  if (value.type === "ai-suggestion-cancel")
    return (
      onlyKeys(value, ["protocolVersion", "type", "requestId", "sessionId"]) &&
      id(value.requestId) &&
      id(value.sessionId)
    );
  if (value.type === "ai-suggestion-snapshot-validation")
    return (
      onlyKeys(value, [
        "protocolVersion",
        "type",
        "requestId",
        "sessionId",
        "current",
      ]) &&
      id(value.requestId) &&
      id(value.sessionId) &&
      typeof value.current === "boolean"
    );
  if (value.type === "ai-suggestion-adoption-check")
    return (
      onlyKeys(value, [
        "protocolVersion",
        "type",
        "attemptId",
        "requestId",
        "sessionId",
        "documentId",
        "baseVersion",
        "editorRevision",
        "settingsGeneration",
        "position",
        "targetKind",
      ]) &&
      id(value.attemptId) &&
      identity(value)
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
      "afterUserInput",
      "invocationId",
      "language",
      "surfaceText",
      "surfacePosition",
    ]) &&
    identity(value) &&
    validRequestTarget(value) &&
    (value.trigger === "auto" || value.trigger === "manual") &&
    (value.trigger === "manual"
      ? id(value.invocationId) && value.afterUserInput === undefined
      : value.invocationId === undefined &&
        (value.afterUserInput === undefined ||
          typeof value.afterUserInput === "boolean"))
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
        "autoRestoreOnInput",
        "modelSelectionStale",
        "active",
        "statusText",
        "modelName",
      ]) &&
      id(value.sessionId) &&
      counter(value.settingsGeneration) &&
      typeof value.autoTrigger === "boolean" &&
      (value.autoRestoreOnInput === undefined ||
        typeof value.autoRestoreOnInput === "boolean") &&
      (value.modelSelectionStale === undefined ||
        typeof value.modelSelectionStale === "boolean") &&
      (value.active === undefined || typeof value.active === "boolean") &&
      (value.statusText === undefined ||
        (typeof value.statusText === "string" &&
          value.statusText.length <= 512)) &&
      (value.modelName === undefined ||
        (typeof value.modelName === "string" &&
          value.modelName.length <= 256)) &&
      AI_AVAILABILITY.includes(value.availability as AiAvailability)
    );
  if (value.type === "ai-suggestion-trigger")
    return (
      onlyKeys(value, [
        "protocolVersion",
        "type",
        "sessionId",
        "settingsGeneration",
        "invocationId",
      ]) &&
      id(value.sessionId) &&
      counter(value.settingsGeneration) &&
      id(value.invocationId)
    );
  if (value.type === "ai-suggestion-snapshot-check")
    return (
      onlyKeys(value, ["protocolVersion", "type", "requestId", "sessionId"]) &&
      id(value.requestId) &&
      id(value.sessionId)
    );
  if (value.type === "ai-suggestion-adoption-validation")
    return (
      onlyKeys(value, [
        "protocolVersion",
        "type",
        "attemptId",
        "requestId",
        "sessionId",
        "available",
      ]) &&
      id(value.attemptId) &&
      id(value.requestId) &&
      id(value.sessionId) &&
      typeof value.available === "boolean"
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
      "text",
      "reason",
    ]) &&
    identity(value) &&
    validCompletionText(value.text) &&
    AI_REASONS.includes(value.reason as AiSuggestionReason) &&
    (value.reason === "ready" ? value.text.length > 0 : value.text === "")
  );
}
