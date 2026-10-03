/** Bounded, dependency-free AI wire contract shared by both runtimes. */
export const AI_LIMITS = {
  before: 4_000,
  after: 1_000,
  heading: 512,
  context: 6_000,
  blocks: 64,
  paragraphOutput: 240,
  headingOutput: 80,
  inputTokens: 4_096,
  debounceMs: 1_000,
  autoIntervalMs: 2_000,
  manualIntervalMs: 1_000,
  windowMs: 60_000,
  requestsPerWindow: 12,
  deadlineMs: 15_000,
  cooldownMs: 30_000,
} as const;

export const AI_AVAILABILITY = [
  "ready",
  "unsupported",
  "no-model",
  "needs-authorization",
  "untrusted",
  "blocked",
] as const;
export type AiAvailability = (typeof AI_AVAILABILITY)[number];
export const AI_REASONS = [
  ...AI_AVAILABILITY,
  "no-suggestion",
  "rate-limited",
  "failed",
  "timeout",
  "stale",
  "cancelled",
  "invalid-context",
] as const;
export type AiSuggestionReason = (typeof AI_REASONS)[number];
export type AiTrigger = "auto" | "manual";
export type AiTargetKind = "paragraph" | "heading";
export interface AiSuggestionContext {
  readonly before: string;
  readonly after: string;
  readonly heading: string;
}
export interface AiSuggestionIdentity {
  readonly requestId: string;
  readonly sessionId: string;
  readonly documentId: string;
  readonly baseVersion: number;
  readonly editorRevision: number;
  readonly settingsGeneration: number;
  readonly position: number;
  readonly targetKind: AiTargetKind;
}
export interface AiSuggestionRequest extends AiSuggestionIdentity {
  readonly protocolVersion: 1;
  readonly type: "ai-suggestion-request";
  readonly trigger: AiTrigger;
  readonly invocationId?: string;
  readonly context: AiSuggestionContext;
}
export interface AiSuggestionCancel {
  readonly protocolVersion: 1;
  readonly type: "ai-suggestion-cancel";
  readonly requestId: string;
  readonly sessionId: string;
}
export interface AiSuggestionState {
  readonly protocolVersion: 1;
  readonly type: "ai-suggestion-state";
  readonly sessionId: string;
  readonly settingsGeneration: number;
  readonly autoTrigger: boolean;
  readonly modelName: string;
  readonly availability: AiAvailability;
  readonly active?: boolean;
}
export interface AiSuggestionTrigger {
  readonly protocolVersion: 1;
  readonly type: "ai-suggestion-trigger";
  readonly sessionId: string;
  readonly settingsGeneration: number;
  readonly invocationId: string;
}
export interface AiSuggestionResult extends AiSuggestionIdentity {
  readonly protocolVersion: 1;
  readonly type: "ai-suggestion-result";
  readonly text: string;
  readonly reason: AiSuggestionReason;
}
export type AiWebviewMessage = AiSuggestionRequest | AiSuggestionCancel;
export type AiHostMessage =
  AiSuggestionState | AiSuggestionTrigger | AiSuggestionResult;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function hasAiControlCharacters(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (
      code < 32 ||
      (code >= 127 && code <= 159) ||
      code === 0x2028 ||
      code === 0x2029
    )
      return true;
  }
  return false;
}
function id(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 160 &&
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
    !hasAiControlCharacters(value.documentId) &&
    counter(value.baseVersion) &&
    value.baseVersion > 0 &&
    counter(value.editorRevision) &&
    counter(value.settingsGeneration) &&
    counter(value.position) &&
    value.position > 0 &&
    value.position <= 4_000_000 &&
    (value.targetKind === "paragraph" || value.targetKind === "heading")
  );
}
export function isAiSuggestionContext(
  value: unknown,
): value is AiSuggestionContext {
  return (
    record(value) &&
    Object.keys(value).length === 3 &&
    typeof value.before === "string" &&
    value.before.length <= AI_LIMITS.before &&
    typeof value.after === "string" &&
    value.after.length <= AI_LIMITS.after &&
    typeof value.heading === "string" &&
    value.heading.length <= AI_LIMITS.heading &&
    value.before.length + value.after.length + value.heading.length <=
      AI_LIMITS.context &&
    value.before.trim().length > 0
  );
}
export function isAiWebviewMessage(value: unknown): value is AiWebviewMessage {
  if (!record(value) || value.protocolVersion !== 1) return false;
  if (value.type === "ai-suggestion-cancel")
    return id(value.requestId) && id(value.sessionId);
  return (
    value.type === "ai-suggestion-request" &&
    identity(value) &&
    isAiSuggestionContext(value.context) &&
    (value.trigger === "auto"
      ? value.invocationId === undefined
      : value.trigger === "manual" && id(value.invocationId))
  );
}
export function isAiHostMessage(value: unknown): value is AiHostMessage {
  if (!record(value) || value.protocolVersion !== 1) return false;
  if (value.type === "ai-suggestion-state")
    return (
      id(value.sessionId) &&
      counter(value.settingsGeneration) &&
      typeof value.autoTrigger === "boolean" &&
      (value.active === undefined || typeof value.active === "boolean") &&
      typeof value.modelName === "string" &&
      value.modelName.length <= 512 &&
      AI_AVAILABILITY.includes(value.availability as AiAvailability)
    );
  if (value.type === "ai-suggestion-trigger")
    return (
      id(value.sessionId) &&
      counter(value.settingsGeneration) &&
      id(value.invocationId)
    );
  return (
    value.type === "ai-suggestion-result" &&
    identity(value) &&
    typeof value.text === "string" &&
    value.text.length <=
      2 *
        (value.targetKind === "heading"
          ? AI_LIMITS.headingOutput
          : AI_LIMITS.paragraphOutput) &&
    Array.from(value.text).length <=
      (value.targetKind === "heading"
        ? AI_LIMITS.headingOutput
        : AI_LIMITS.paragraphOutput) &&
    !hasAiControlCharacters(value.text) &&
    AI_REASONS.includes(value.reason as AiSuggestionReason) &&
    (value.reason === "ready"
      ? value.text.trim().length > 0
      : value.text === "")
  );
}

/** Slice by UTF-16 budgets without splitting surrogate pairs. */
export function aiContextTail(text: string, limit: number): string {
  let start = Math.max(0, text.length - limit);
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start] ?? "")) start += 1;
  return text.slice(start);
}
export function aiContextHead(text: string, limit: number): string {
  let end = Math.min(text.length, limit);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? ""))
    end -= 1;
  return text.slice(0, end);
}
