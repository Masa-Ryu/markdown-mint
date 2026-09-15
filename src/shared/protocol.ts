/**
 * The only wire format used between the extension host and a Markdown Mint
 * webview. Keep this file dependency-free: it is bundled into both runtimes.
 */

export const PROTOCOL_VERSION = 1 as const;
export const MAX_MARKDOWN_LENGTH = 2_000_000;
export const MAX_OPERATION_ID_LENGTH = 160;
export const MAX_RESOURCE_URL_LENGTH = 8_192;
export const MAX_DOCUMENT_ID_LENGTH = 2_048;
export const MAX_CLIPBOARD_TEXT_LENGTH = MAX_MARKDOWN_LENGTH;
export const MAX_FILE_SEARCH_QUERY_LENGTH = 256;
export const MAX_FILE_SEARCH_CANDIDATES = 10;
export const MAX_FILE_SEARCH_PATH_LENGTH = MAX_RESOURCE_URL_LENGTH;
export const MAX_FILE_SEARCH_NAME_LENGTH = 1_024;
export const MAX_IMAGE_IMPORT_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_IMPORT_BASE64_LENGTH =
  Math.ceil(MAX_IMAGE_IMPORT_BYTES / 3) * 4;
export const MAX_IMAGE_IMPORT_FILE_NAME_LENGTH = 512;
export const MAX_IMAGE_IMPORT_MIME_TYPE_LENGTH = 128;

export const MARKDOWN_PROFILES = ["github", "gitlab", "commonmark"] as const;
export type MarkdownProfile = (typeof MARKDOWN_PROFILES)[number];
export const PROFILE_SELECTIONS = MARKDOWN_PROFILES;
export type ProfileSelection = MarkdownProfile;

export const HOST_DOCUMENT_REASONS = [
  "initial",
  "ack",
  "external",
  "format",
  "undo",
  "redo",
  "save",
  "recovery",
] as const;
export type HostDocumentReason = (typeof HOST_DOCUMENT_REASONS)[number];

export type PanelMode = "editor" | "preview";

export interface PreviewTypography {
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly lineHeight: number;
}

export interface DocumentMessage {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly type: "document";
  /** The current text from TextDocument. Webviews must treat this as truth. */
  readonly markdown: string;
  /** VS Code's monotonically increasing TextDocument version. */
  readonly version: number;
  readonly profile: MarkdownProfile;
  /** Stable resource identity used to scope persisted recovery data. */
  readonly documentId?: string;
  readonly operationId?: string;
  readonly reason?: HostDocumentReason;
  /** A webview URI for the document directory, when the document is local. */
  readonly resourceBaseUrl?: string;
  readonly mode?: PanelMode;
  /** Whether the host can provide the authoritative VS Code clipboard route. */
  readonly clipboardAvailable?: boolean;
  readonly typography?: PreviewTypography;
  /** A rejected, unsaved draft may be retained for provenance-aware recovery. */
  readonly draftMarkdown?: string;
}

export interface PreviewMessage {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly type: "preview";
  readonly markdown: string;
  readonly html: string;
  readonly version: number;
  readonly profile: MarkdownProfile;
  readonly resourceBaseUrl?: string;
  readonly clipboardAvailable?: boolean;
  readonly typography?: PreviewTypography;
}

export interface EditRejectedMessage {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly type: "edit-rejected";
  readonly operationId: string;
  readonly reason: "stale" | "invalid" | "apply-failed" | "busy" | "too-large";
  readonly message: string;
  readonly currentMarkdown: string;
  readonly currentVersion: number;
  /** The submitted draft is retained so the webview can protect local input. */
  readonly draftMarkdown?: string;
  readonly diagnostics?: readonly string[];
}

export interface FormatRejectedMessage {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly type: "format-rejected";
  readonly operationId: string;
  readonly reason:
    "invalid" | "apply-failed" | "stale" | "too-large" | "ignored";
  readonly message: string;
  readonly currentMarkdown: string;
  readonly currentVersion: number;
}

export interface RecoveryOpenedMessage {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly type: "recovery-opened";
  readonly operationId: string;
  readonly currentMarkdown: string;
  readonly currentVersion: number;
  readonly profile: MarkdownProfile;
  readonly draftUri?: string;
}

export interface ErrorMessage {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly type: "error";
  readonly message: string;
  readonly operationId?: string;
}

export interface ClipboardWriteMessage {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly type: "clipboard-write";
  readonly requestId: string;
  readonly text: string;
}

export interface OpenLinkMessage {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly type: "open-link";
  /** The raw href attribute from the Rich Editor anchor. */
  readonly href: string;
}

export type WorkspaceFileSearchFilter = "all" | "image";

export interface WorkspaceFileSearchMessage {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly type: "workspace-file-search";
  readonly requestId: string;
  readonly query: string;
  readonly filter: WorkspaceFileSearchFilter;
}

export interface WorkspaceFileSearchWarmupMessage {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly type: "workspace-file-search-warmup";
}

export interface WorkspaceFileSearchCandidateMessage {
  readonly fileName: string;
  readonly directory: string;
  readonly relativePath: string;
}

export interface WorkspaceFileSearchResultMessage {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly type: "workspace-file-search-result";
  readonly requestId: string;
  readonly candidates: readonly WorkspaceFileSearchCandidateMessage[];
}

export interface ClipboardResultMessage {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly type: "clipboard-result";
  readonly requestId: string;
  readonly success: boolean;
  readonly message?: string;
}

export interface ImageImportMessage {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly type: "image-import";
  readonly requestId: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly base64: string;
}

export interface ImageImportUriMessage {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly type: "image-import-uri";
  readonly requestId: string;
  readonly resourceUri: string;
}

export interface ImageImportResultMessage {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly type: "image-import-result";
  readonly requestId: string;
  readonly success: boolean;
  readonly relativePath?: string;
  readonly message?: string;
}

export interface ReadyMessage {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly type: "ready";
  readonly requestId?: string;
}

export interface EditMessage {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly type: "edit";
  readonly baseVersion: number;
  readonly operationId: string;
  readonly markdown: string;
}

export interface UndoMessage {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly type: "undo";
  readonly baseVersion?: number;
  readonly operationId: string;
}

export interface RedoMessage {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly type: "redo";
  readonly baseVersion?: number;
  readonly operationId: string;
}

export interface SourceMessage {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly type: "source";
  readonly operationId?: string;
}

export interface SetProfileMessage {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly type: "set-profile";
  readonly profile: ProfileSelection;
  readonly baseVersion: number;
  readonly operationId: string;
}

export interface FormatMessage {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly type: "format";
  readonly baseVersion: number;
  readonly operationId: string;
}

export interface SaveMessage {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly type: "save";
  /** The TextDocument version the webview has observed after its edits. */
  readonly baseVersion: number;
  readonly operationId: string;
}

export interface SaveResultMessage {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly type: "save-result";
  readonly operationId: string;
  readonly saved: boolean;
  /** Version observed when the save request was accepted. */
  readonly requestedVersion: number;
  /** Version known to have reached disk, when it can be identified safely. */
  readonly savedVersion?: number;
  readonly version: number;
  readonly isDirty: boolean;
  readonly message?: string;
}

export interface PreviewRequestMessage {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly type: "preview";
  readonly baseVersion?: number;
  readonly operationId?: string;
}

export interface RecoverDraftMessage {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly type: "recoverDraft";
  readonly baseVersion: number;
  readonly operationId: string;
  readonly markdown: string;
}

export interface UserNotificationMessage {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly type: "notify";
  readonly level: "info" | "warning" | "error";
  readonly message: string;
  readonly operationId?: string;
}

export type WebviewMessage =
  | ReadyMessage
  | EditMessage
  | UndoMessage
  | RedoMessage
  | SourceMessage
  | SetProfileMessage
  | FormatMessage
  | SaveMessage
  | PreviewRequestMessage
  | RecoverDraftMessage
  | ClipboardWriteMessage
  | OpenLinkMessage
  | WorkspaceFileSearchMessage
  | WorkspaceFileSearchWarmupMessage
  | ImageImportMessage
  | ImageImportUriMessage
  | UserNotificationMessage;

export type HostMessage =
  | DocumentMessage
  | PreviewMessage
  | EditRejectedMessage
  | FormatRejectedMessage
  | SaveResultMessage
  | RecoveryOpenedMessage
  | ClipboardResultMessage
  | WorkspaceFileSearchResultMessage
  | ImageImportResultMessage
  | ErrorMessage;

export function isMarkdownProfile(value: unknown): value is MarkdownProfile {
  return (
    typeof value === "string" &&
    (MARKDOWN_PROFILES as readonly string[]).includes(value)
  );
}

export function isProfileSelection(value: unknown): value is ProfileSelection {
  return (
    typeof value === "string" &&
    (PROFILE_SELECTIONS as readonly string[]).includes(value)
  );
}

export function isSafeMarkdownSource(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_MARKDOWN_LENGTH;
}

export function isOperationId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_OPERATION_ID_LENGTH &&
    /^[a-zA-Z0-9._:-]+$/.test(value)
  );
}

export function isDocumentMessage(value: unknown): value is DocumentMessage {
  if (!isRecord(value)) return false;
  return (
    value.protocolVersion === PROTOCOL_VERSION &&
    value.type === "document" &&
    isSafeMarkdownSource(value.markdown) &&
    isVersion(value.version) &&
    isMarkdownProfile(value.profile) &&
    optionalString(value.operationId) &&
    optionalDocumentId(value.documentId) &&
    optionalReason(value.reason) &&
    optionalResourceUrl(value.resourceBaseUrl) &&
    optionalMode(value.mode) &&
    optionalBoolean(value.clipboardAvailable) &&
    optionalTypography(value.typography) &&
    optionalSafeMarkdownSource(value.draftMarkdown)
  );
}

export function isHostMessage(value: unknown): value is HostMessage {
  if (
    !isRecord(value) ||
    value.protocolVersion !== PROTOCOL_VERSION ||
    typeof value.type !== "string"
  ) {
    return false;
  }
  if (value.type === "document") return isDocumentMessage(value);
  if (value.type === "preview") {
    return (
      isSafeMarkdownSource(value.markdown) &&
      typeof value.html === "string" &&
      isVersion(value.version) &&
      isMarkdownProfile(value.profile) &&
      optionalResourceUrl(value.resourceBaseUrl) &&
      optionalBoolean(value.clipboardAvailable) &&
      optionalTypography(value.typography)
    );
  }
  if (value.type === "edit-rejected") {
    return (
      isOperationId(value.operationId) &&
      isRejectReason(value.reason) &&
      typeof value.message === "string" &&
      isSafeMarkdownSource(value.currentMarkdown) &&
      isVersion(value.currentVersion) &&
      optionalSafeMarkdownSource(value.draftMarkdown) &&
      optionalStringArray(value.diagnostics)
    );
  }
  if (value.type === "format-rejected") {
    return (
      isOperationId(value.operationId) &&
      isFormatRejectReason(value.reason) &&
      typeof value.message === "string" &&
      isSafeMarkdownSource(value.currentMarkdown) &&
      isVersion(value.currentVersion)
    );
  }
  if (value.type === "save-result") {
    return (
      isOperationId(value.operationId) &&
      typeof value.saved === "boolean" &&
      isVersion(value.requestedVersion) &&
      optionalVersion(value.savedVersion) &&
      isVersion(value.version) &&
      typeof value.isDirty === "boolean" &&
      optionalString(value.message)
    );
  }
  if (value.type === "recovery-opened") {
    return (
      isOperationId(value.operationId) &&
      isSafeMarkdownSource(value.currentMarkdown) &&
      isVersion(value.currentVersion) &&
      isMarkdownProfile(value.profile) &&
      optionalResourceUrl(value.draftUri)
    );
  }
  if (value.type === "clipboard-result") {
    return (
      isOperationId(value.requestId) &&
      typeof value.success === "boolean" &&
      optionalMessage(value.message)
    );
  }
  if (value.type === "workspace-file-search-result") {
    return (
      isOperationId(value.requestId) &&
      Array.isArray(value.candidates) &&
      value.candidates.length <= MAX_FILE_SEARCH_CANDIDATES &&
      value.candidates.every(isWorkspaceFileSearchCandidate)
    );
  }
  if (value.type === "image-import-result") {
    if (
      !isOperationId(value.requestId) ||
      typeof value.success !== "boolean" ||
      !optionalMessage(value.message)
    )
      return false;
    if (value.success)
      return (
        isRelativeImagePath(value.relativePath) && value.message === undefined
      );
    return value.relativePath === undefined;
  }
  if (value.type === "error") {
    return (
      typeof value.message === "string" && optionalString(value.operationId)
    );
  }
  return false;
}

/** Decode and validate an untrusted postMessage payload. */
export function parseWebviewMessage(
  value: unknown,
): WebviewMessage | undefined {
  if (
    !isRecord(value) ||
    value.protocolVersion !== PROTOCOL_VERSION ||
    typeof value.type !== "string"
  ) {
    return undefined;
  }

  switch (value.type) {
    case "ready":
      return value.requestId === undefined
        ? { protocolVersion: PROTOCOL_VERSION, type: "ready" }
        : typeof value.requestId === "string" &&
            value.requestId.length <= MAX_OPERATION_ID_LENGTH
          ? {
              protocolVersion: PROTOCOL_VERSION,
              type: "ready",
              requestId: value.requestId,
            }
          : undefined;
    case "edit":
      return isVersion(value.baseVersion) &&
        isOperationId(value.operationId) &&
        isSafeMarkdownSource(value.markdown)
        ? {
            protocolVersion: PROTOCOL_VERSION,
            type: "edit",
            baseVersion: value.baseVersion,
            operationId: value.operationId,
            markdown: value.markdown,
          }
        : undefined;
    case "undo":
      return isOperationId(value.operationId) &&
        optionalVersion(value.baseVersion)
        ? {
            protocolVersion: PROTOCOL_VERSION,
            type: "undo",
            operationId: value.operationId,
            ...(value.baseVersion === undefined
              ? {}
              : { baseVersion: value.baseVersion }),
          }
        : undefined;
    case "redo":
      return isOperationId(value.operationId) &&
        optionalVersion(value.baseVersion)
        ? {
            protocolVersion: PROTOCOL_VERSION,
            type: "redo",
            operationId: value.operationId,
            ...(value.baseVersion === undefined
              ? {}
              : { baseVersion: value.baseVersion }),
          }
        : undefined;
    case "source":
      return optionalString(value.operationId)
        ? {
            protocolVersion: PROTOCOL_VERSION,
            type: "source",
            ...(value.operationId === undefined
              ? {}
              : { operationId: value.operationId }),
          }
        : undefined;
    case "set-profile":
      return isProfileSelection(value.profile) &&
        isVersion(value.baseVersion) &&
        isOperationId(value.operationId)
        ? {
            protocolVersion: PROTOCOL_VERSION,
            type: "set-profile",
            profile: value.profile,
            baseVersion: value.baseVersion,
            operationId: value.operationId,
          }
        : undefined;
    case "format":
      return isVersion(value.baseVersion) && isOperationId(value.operationId)
        ? {
            protocolVersion: PROTOCOL_VERSION,
            type: "format",
            baseVersion: value.baseVersion,
            operationId: value.operationId,
          }
        : undefined;
    case "save":
      return isVersion(value.baseVersion) && isOperationId(value.operationId)
        ? {
            protocolVersion: PROTOCOL_VERSION,
            type: "save",
            baseVersion: value.baseVersion,
            operationId: value.operationId,
          }
        : undefined;
    case "preview":
      return optionalVersion(value.baseVersion) &&
        optionalString(value.operationId)
        ? {
            protocolVersion: PROTOCOL_VERSION,
            type: "preview",
            ...(value.baseVersion === undefined
              ? {}
              : { baseVersion: value.baseVersion }),
            ...(value.operationId === undefined
              ? {}
              : { operationId: value.operationId }),
          }
        : undefined;
    case "recoverDraft":
      return isVersion(value.baseVersion) &&
        isOperationId(value.operationId) &&
        isSafeMarkdownSource(value.markdown)
        ? {
            protocolVersion: PROTOCOL_VERSION,
            type: "recoverDraft",
            baseVersion: value.baseVersion,
            operationId: value.operationId,
            markdown: value.markdown,
          }
        : undefined;
    case "clipboard-write":
      return isOperationId(value.requestId) && isSafeClipboardText(value.text)
        ? {
            protocolVersion: PROTOCOL_VERSION,
            type: "clipboard-write",
            requestId: value.requestId,
            text: value.text,
          }
        : undefined;
    case "open-link":
      return isSafeLinkHref(value.href)
        ? {
            protocolVersion: PROTOCOL_VERSION,
            type: "open-link",
            href: value.href,
          }
        : undefined;
    case "workspace-file-search":
      return isOperationId(value.requestId) &&
        isSafeFileSearchQuery(value.query) &&
        isWorkspaceFileSearchFilter(value.filter)
        ? {
            protocolVersion: PROTOCOL_VERSION,
            type: "workspace-file-search",
            requestId: value.requestId,
            query: value.query,
            filter: value.filter,
          }
        : undefined;
    case "workspace-file-search-warmup":
      return {
        protocolVersion: PROTOCOL_VERSION,
        type: "workspace-file-search-warmup",
      };
    case "image-import":
      return isOperationId(value.requestId) &&
        isImageImportFileName(value.fileName) &&
        isImageImportMimeType(value.mimeType) &&
        isBase64Payload(value.base64)
        ? {
            protocolVersion: PROTOCOL_VERSION,
            type: "image-import",
            requestId: value.requestId,
            fileName: value.fileName,
            mimeType: value.mimeType,
            base64: value.base64,
          }
        : undefined;
    case "image-import-uri":
      return isOperationId(value.requestId) && isResourceUri(value.resourceUri)
        ? {
            protocolVersion: PROTOCOL_VERSION,
            type: "image-import-uri",
            requestId: value.requestId,
            resourceUri: value.resourceUri,
          }
        : undefined;
    case "notify":
      return (value.level === "info" ||
        value.level === "warning" ||
        value.level === "error") &&
        typeof value.message === "string" &&
        value.message.length <= 1_024 &&
        optionalString(value.operationId)
        ? {
            protocolVersion: PROTOCOL_VERSION,
            type: "notify",
            level: value.level,
            message: value.message,
            ...(value.operationId === undefined
              ? {}
              : { operationId: value.operationId }),
          }
        : undefined;
    default:
      return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function optionalVersion(value: unknown): value is number | undefined {
  return value === undefined || isVersion(value);
}

function optionalString(value: unknown): value is string | undefined {
  return (
    value === undefined ||
    (typeof value === "string" && value.length <= MAX_OPERATION_ID_LENGTH)
  );
}

function optionalMessage(value: unknown): value is string | undefined {
  return (
    value === undefined || (typeof value === "string" && value.length <= 1_024)
  );
}

function optionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function isSafeClipboardText(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_CLIPBOARD_TEXT_LENGTH;
}

function isWorkspaceFileSearchFilter(
  value: unknown,
): value is WorkspaceFileSearchFilter {
  return value === "all" || value === "image";
}

function isSafeFileSearchQuery(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_FILE_SEARCH_QUERY_LENGTH &&
    !hasControlCharacter(value)
  );
}

function isImageImportFileName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_IMAGE_IMPORT_FILE_NAME_LENGTH
  );
}

function isImageImportMimeType(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_IMAGE_IMPORT_MIME_TYPE_LENGTH
  );
}

function isBase64Payload(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_IMAGE_IMPORT_BASE64_LENGTH &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  );
}

function isRelativeImagePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_RESOURCE_URL_LENGTH &&
    /^\.\/images\/[^/\\]+$/.test(value) &&
    !hasControlCharacter(value)
  );
}

function isWorkspaceFileSearchCandidate(
  value: unknown,
): value is WorkspaceFileSearchCandidateMessage {
  if (!isRecord(value)) return false;
  return (
    isSafeFileSearchName(value.fileName) &&
    isSafeFileSearchDirectory(value.directory) &&
    isSafeFileSearchPath(value.relativePath)
  );
}

function isSafeFileSearchName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_FILE_SEARCH_NAME_LENGTH &&
    !hasControlCharacter(value)
  );
}

function isSafeFileSearchDirectory(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_FILE_SEARCH_PATH_LENGTH &&
    !hasControlCharacter(value) &&
    !value.includes("\\")
  );
}

function isSafeFileSearchPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_FILE_SEARCH_PATH_LENGTH &&
    /^(?:\.\/|\.\.\/)/.test(value) &&
    !hasControlCharacter(value) &&
    !value.includes("\\") &&
    !value.includes("?") &&
    !value.includes("#")
  );
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

export function isSafeLinkHref(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_RESOURCE_URL_LENGTH
  );
}

function optionalResourceUrl(value: unknown): value is string | undefined {
  return (
    value === undefined ||
    (typeof value === "string" && value.length <= MAX_RESOURCE_URL_LENGTH)
  );
}

function isResourceUri(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_RESOURCE_URL_LENGTH &&
    !hasControlCharacter(value)
  );
}

function optionalDocumentId(value: unknown): value is string | undefined {
  return (
    value === undefined ||
    (typeof value === "string" &&
      value.length > 0 &&
      value.length <= MAX_DOCUMENT_ID_LENGTH)
  );
}

function optionalTypography(
  value: unknown,
): value is PreviewTypography | undefined {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return (
    typeof value.fontFamily === "string" &&
    value.fontFamily.length <= 1_024 &&
    typeof value.fontSize === "number" &&
    Number.isFinite(value.fontSize) &&
    value.fontSize > 0 &&
    value.fontSize <= 96 &&
    typeof value.lineHeight === "number" &&
    Number.isFinite(value.lineHeight) &&
    value.lineHeight > 0 &&
    value.lineHeight <= 8
  );
}

function optionalSafeMarkdownSource(
  value: unknown,
): value is string | undefined {
  return value === undefined || isSafeMarkdownSource(value);
}

function optionalReason(
  value: unknown,
): value is HostDocumentReason | undefined {
  return (
    value === undefined ||
    (typeof value === "string" &&
      (HOST_DOCUMENT_REASONS as readonly string[]).includes(value))
  );
}

function optionalMode(value: unknown): value is PanelMode | undefined {
  return value === undefined || value === "editor" || value === "preview";
}

function optionalStringArray(
  value: unknown,
): value is readonly string[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
  );
}

function isRejectReason(
  value: unknown,
): value is EditRejectedMessage["reason"] {
  return (
    value === "stale" ||
    value === "invalid" ||
    value === "apply-failed" ||
    value === "busy" ||
    value === "too-large"
  );
}

function isFormatRejectReason(
  value: unknown,
): value is FormatRejectedMessage["reason"] {
  return (
    value === "invalid" ||
    value === "apply-failed" ||
    value === "stale" ||
    value === "too-large" ||
    value === "ignored"
  );
}
