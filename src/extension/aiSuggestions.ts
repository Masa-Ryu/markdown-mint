import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import {
  AI_LIMITS,
  isAiWebviewMessage,
  type AiAvailability,
  type AiHostMessage,
  type AiSuggestionFeedback,
  type AiSuggestionReason,
  type AiSuggestionRequest,
} from "../shared/aiSuggestions";
import { normalizeCompletionDetails } from "../core/inlineCompletion";
import {
  CopilotLanguageServer,
  lspPositionToOffset,
  offsetToLspPosition,
  type InlineCompletionItem,
} from "./copilotLanguageServer";

export const AI_TRIGGER_COMMAND = "markdownMint.aiSuggestions.trigger";
export const AI_SIGN_IN_COMMAND = "markdownMint.aiSuggestions.signIn";

export interface AiSettings {
  readonly autoTrigger: boolean;
}
export interface AiPanelSession {
  readonly id: string;
  documentId(): string;
  uri(): string;
  version(): number;
  markdown(): string;
  isReady(): boolean;
  isActive(): boolean;
  canStartRequest(): boolean;
  focus(): void;
  post(message: AiHostMessage): void;
}
export interface AiSuggestionsEnvironment {
  readonly server: CopilotLanguageServer;
  supported(): boolean;
  trusted(): boolean;
  settings(): AiSettings;
  notify(message: string): void;
  tokenSource(): vscode.CancellationTokenSource;
  statusChanged?(
    listener: (status: AiAvailability, text: string) => void,
  ): vscode.Disposable;
}
interface RegisteredSession {
  readonly panel: AiPanelSession;
}
interface ActiveRequest {
  readonly session: RegisteredSession;
  readonly request: AiSuggestionRequest;
  readonly source: vscode.CancellationTokenSource;
  readonly finish: (reason: AiSuggestionReason, text?: string) => void;
  timer: ReturnType<typeof setTimeout>;
}
interface RequestOutcome {
  readonly reason: AiSuggestionReason;
  readonly text: string;
  readonly partialAcceptanceOffset?: number;
  readonly item?: InlineCompletionItem;
}
interface CandidateRecord {
  readonly session: RegisteredSession;
  readonly documentId: string;
  version: number;
  readonly item: InlineCompletionItem;
  readonly expires: number;
  shown: boolean;
  acceptedLength: number;
}

const statusText: Record<AiAvailability, string> = {
  disabled:
    "Copilot suggestions are off. Run Suggest Continuation for a manual suggestion.",
  preparing: "Starting GitHub Copilot Language Server…",
  "needs-sign-in":
    "Sign in to GitHub Copilot to use Markdown Mint suggestions.",
  ready: "GitHub Copilot suggestions are available.",
  untrusted: "Copilot suggestions are disabled in an untrusted workspace.",
  excluded: "Copilot has excluded this document or workspace from suggestions.",
  unavailable: "GitHub Copilot Language Server is unavailable.",
  blocked:
    "GitHub Copilot is unavailable due to an account, policy, or service limit.",
};

/** Coordinates a single active Markdown document with the official LSP. */
export class AiSuggestionsHost implements vscode.Disposable {
  private settings: AiSettings;
  private generation = 0;
  private disposed = false;
  private readonly sessions = new Map<string, RegisteredSession>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private active: ActiveRequest | undefined;
  private readonly candidates = new Map<string, CandidateRecord>();
  private serverAvailability: AiAvailability = "disabled";
  private serverMessage = statusText.disabled;

  constructor(
    private readonly environment: AiSuggestionsEnvironment,
    private readonly reportStatus?: (
      availability: AiAvailability,
      message: string,
      autoTrigger: boolean,
    ) => void,
  ) {
    this.settings = environment.settings();
    if (environment.statusChanged)
      this.subscriptions.push(
        environment.statusChanged((availability, message) => {
          this.serverAvailability = availability;
          this.serverMessage = message.slice(0, 512);
          this.publishAll();
        }),
      );
  }

  public registerSession(panel: AiPanelSession): void {
    if (this.disposed) return;
    this.sessions.set(panel.id, { panel });
    this.publishState(panel.id);
    if (panel.isReady() && panel.isActive() && this.settings.autoTrigger)
      void this.ensureStarted();
  }
  public unregisterSession(id: string): void {
    this.cancelSession(id);
    for (const [candidateId, candidate] of this.candidates)
      if (candidate.session.panel.id === id)
        this.candidates.delete(candidateId);
    const session = this.sessions.get(id);
    if (session)
      void this.environment.server.closeDocument(session.panel.uri());
    this.sessions.delete(id);
  }
  public publishState(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    const availability = this.availability();
    const message =
      availability === "disabled" ? statusText.disabled : this.serverMessage;
    session.panel.post({
      protocolVersion: 1,
      type: "ai-suggestion-state",
      sessionId: id,
      settingsGeneration: this.generation,
      autoTrigger: this.settings.autoTrigger,
      availability,
      statusText: message,
      active: session.panel.isReady() && session.panel.isActive(),
    });
    this.reportStatus?.(availability, message, this.settings.autoTrigger);
  }
  private publishAll(): void {
    for (const id of this.sessions.keys()) this.publishState(id);
  }
  private availability(): AiAvailability {
    if (!this.environment.supported()) return "unavailable";
    if (!this.environment.trusted()) return "untrusted";
    if (
      this.serverAvailability === "needs-sign-in" ||
      this.serverAvailability === "excluded" ||
      this.serverAvailability === "blocked" ||
      this.serverAvailability === "unavailable" ||
      this.serverAvailability === "preparing"
    )
      return this.serverAvailability;
    if (!this.settings.autoTrigger) return "disabled";
    return this.serverAvailability;
  }
  public refreshSettings(): void {
    const next = this.environment.settings();
    if (next.autoTrigger !== this.settings.autoTrigger) {
      this.settings = next;
      this.generation += 1;
      if (!next.autoTrigger && this.active?.request.trigger === "auto")
        this.cancelActive("cancelled");
      if (next.autoTrigger) void this.ensureStarted();
      this.publishAll();
      return;
    }
    this.settings = next;
    this.publishAll();
  }
  public trustChanged(): void {
    this.generation += 1;
    this.cancelActive("cancelled");
    for (const id of this.sessions.keys()) this.publishState(id);
  }

  private async ensureStarted(): Promise<boolean> {
    if (
      this.disposed ||
      !this.environment.supported() ||
      !this.environment.trusted()
    )
      return false;
    this.serverAvailability = "preparing";
    this.serverMessage = statusText.preparing;
    this.publishAll();
    try {
      await this.environment.server.start();
      this.readServerStatus();
      return true;
    } catch (error) {
      this.serverAvailability = "unavailable";
      this.serverMessage =
        error instanceof Error
          ? error.message.slice(0, 512)
          : statusText.unavailable;
      this.publishAll();
      return false;
    }
  }
  private readServerStatus(): void {
    const status = this.environment.server.currentStatus;
    this.serverAvailability = status.busy
      ? "preparing"
      : status.kind === "Normal"
        ? "ready"
        : status.kind === "Inactive"
          ? "excluded"
          : status.kind === "Error"
            ? "needs-sign-in"
            : "unavailable";
    this.serverMessage = status.message || statusText[this.serverAvailability];
    this.publishAll();
  }

  public async signInFromUserAction(): Promise<void> {
    if (!this.environment.supported()) {
      this.environment.notify(
        "This extension host does not support the packaged Copilot server.",
      );
      return;
    }
    if (!this.environment.trusted()) {
      this.environment.notify(
        "Copilot suggestions require a trusted workspace.",
      );
      return;
    }
    const accepted = await this.environment.server.signInFromUserAction(
      async (code) => {
        const choice = await vscode.window.showInformationMessage(
          `Enter code ${code} in the GitHub device sign-in page to authorize Markdown Mint.`,
          { modal: true },
          "Copy Code",
          "Open GitHub",
        );
        if (!choice) return false;
        if (choice === "Copy Code") await vscode.env.clipboard.writeText(code);
        if (choice === "Open GitHub")
          await vscode.env.openExternal(
            vscode.Uri.parse("https://github.com/login/device"),
          );
        return true;
      },
    );
    if (accepted) {
      this.serverAvailability = "preparing";
      this.serverMessage = "Waiting for GitHub Copilot sign-in…";
      this.publishAll();
    }
  }
  public async triggerFromUserAction(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || !session.panel.canStartRequest()) {
      this.environment.notify(
        "Open and focus a ready Markdown Mint editor before requesting a suggestion.",
      );
      return;
    }
    if (!this.environment.supported()) {
      this.environment.notify(
        "The packaged Copilot Language Server is unavailable on this extension host.",
      );
      return;
    }
    if (!this.environment.trusted()) {
      this.environment.notify(
        "Copilot suggestions require a trusted workspace.",
      );
      return;
    }
    if (!(await this.ensureStarted())) {
      this.environment.notify(this.serverMessage);
      return;
    }
    this.readServerStatus();
    if (this.serverAvailability === "needs-sign-in") {
      this.environment.notify(
        "Run Markdown Mint: Sign in to GitHub Copilot, then request a suggestion again.",
      );
      return;
    }
    if (this.serverAvailability !== "ready") {
      this.environment.notify(this.serverMessage || statusText.unavailable);
      return;
    }
    session.panel.focus();
    session.panel.post({
      protocolVersion: 1,
      type: "ai-suggestion-trigger",
      sessionId: id,
      settingsGeneration: this.generation,
    });
  }
  public async sessionActivated(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || !session.panel.isReady() || !session.panel.isActive())
      return;
    if (this.settings.autoTrigger) await this.ensureStarted();
    this.publishState(id);
  }

  public cancelSession(id: string, requestId?: string): void {
    if (
      this.active?.session.panel.id === id &&
      (!requestId || this.active.request.requestId === requestId)
    )
      this.cancelActive("cancelled");
  }
  private cancelActive(reason: AiSuggestionReason): void {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    clearTimeout(active.timer);
    active.source.cancel();
    active.finish(reason);
  }
  private current(active: ActiveRequest): boolean {
    const { request, session } = active;
    return (
      !this.disposed &&
      this.active === active &&
      !active.source.token.isCancellationRequested &&
      this.sessions.get(session.panel.id) === session &&
      session.panel.isReady() &&
      session.panel.isActive() &&
      request.settingsGeneration === this.generation &&
      request.documentId === session.panel.documentId() &&
      request.baseVersion === session.panel.version()
    );
  }
  private snapshotCurrent(
    session: RegisteredSession,
    request: AiSuggestionRequest,
  ): boolean {
    return (
      !this.disposed &&
      this.sessions.get(session.panel.id) === session &&
      session.panel.isReady() &&
      session.panel.isActive() &&
      request.settingsGeneration === this.generation &&
      request.documentId === session.panel.documentId() &&
      request.baseVersion === session.panel.version()
    );
  }
  private reply(
    session: RegisteredSession,
    request: AiSuggestionRequest,
    reason: AiSuggestionReason,
    text = "",
    candidateId?: string,
    partialAcceptanceOffset?: number,
  ): void {
    if (this.disposed || this.sessions.get(session.panel.id) !== session)
      return;
    session.panel.post({
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
      reason,
      text,
      ...(candidateId ? { candidateId } : {}),
      ...(partialAcceptanceOffset !== undefined
        ? { partialAcceptanceOffset }
        : {}),
    });
    if (
      request.trigger === "manual" &&
      reason !== "ready" &&
      reason !== "cancelled" &&
      reason !== "stale"
    )
      this.environment.notify(reasonMessage(reason));
  }
  public async requestSuggestion(
    id: string,
    request: AiSuggestionRequest,
  ): Promise<void> {
    const session = this.sessions.get(id);
    if (
      !session ||
      !isAiWebviewMessage(request) ||
      request.type !== "ai-suggestion-request" ||
      request.sessionId !== id
    )
      return;
    if (
      !session.panel.canStartRequest() ||
      request.documentId !== session.panel.documentId() ||
      request.baseVersion !== session.panel.version() ||
      request.settingsGeneration !== this.generation
    ) {
      this.reply(session, request, "stale");
      return;
    }
    if (request.trigger === "auto" && !this.settings.autoTrigger) {
      this.reply(session, request, "disabled");
      return;
    }
    if (!this.environment.supported()) {
      this.reply(session, request, "unsupported");
      return;
    }
    if (!this.environment.trusted()) {
      this.reply(session, request, "untrusted");
      return;
    }
    const markdown = session.panel.markdown();
    if (
      markdown.length > AI_LIMITS.maxDocumentLength ||
      request.position > markdown.length ||
      isLowSurrogate(markdown.charCodeAt(request.position))
    ) {
      this.reply(session, request, "invalid-context");
      return;
    }
    if (!(await this.ensureStarted())) {
      this.reply(
        session,
        request,
        this.snapshotCurrent(session, request) ? "failed" : "stale",
      );
      return;
    }
    if (!this.snapshotCurrent(session, request)) {
      this.reply(session, request, "stale");
      return;
    }
    this.cancelActive("cancelled");
    const source = this.environment.tokenSource();
    let finish!: (reason: AiSuggestionReason, text?: string) => void;
    const interrupted = new Promise<RequestOutcome>((resolve) => {
      finish = (reason, text = "") => resolve({ reason, text });
    });
    const active = {
      session,
      request,
      source,
      finish,
      timer: setTimeout(
        () => this.cancelActive("timeout"),
        AI_LIMITS.deadlineMs,
      ),
    } satisfies ActiveRequest;
    this.active = active;
    try {
      const work = this.requestFromServer(active, markdown);
      const result = await Promise.race([work, interrupted]);
      if (result.reason === "ready") {
        if (!this.current(active)) {
          this.reply(session, request, "stale");
        } else {
          const candidateId = `c-${randomUUID()}`;
          const item = result.item;
          if (item) {
            this.candidates.set(candidateId, {
              session,
              documentId: request.documentId,
              version: request.baseVersion,
              item,
              expires: Date.now() + 120_000,
              shown: false,
              acceptedLength: 0,
            });
            this.pruneCandidates();
          }
          this.reply(
            session,
            request,
            "ready",
            result.text,
            candidateId,
            result.partialAcceptanceOffset,
          );
        }
      } else {
        this.reply(session, request, result.reason);
      }
    } finally {
      clearTimeout(active.timer);
      source.cancel();
      source.dispose();
      if (this.active === active) this.active = undefined;
    }
  }
  private async requestFromServer(
    active: ActiveRequest,
    markdown: string,
  ): Promise<RequestOutcome> {
    try {
      await this.environment.server.synchronizeDocument(
        active.session.panel.uri(),
        active.request.baseVersion,
        markdown,
      );
      await this.environment.server.focusDocument(active.session.panel.uri());
      if (!this.current(active)) return { reason: "cancelled", text: "" };
      const completions = await this.environment.server.requestInlineCompletion(
        active.session.panel.uri(),
        active.request.baseVersion,
        offsetToLspPosition(markdown, active.request.position),
        active.request.trigger,
        active.source.token,
      );
      if (!this.current(active)) return { reason: "cancelled", text: "" };
      for (const item of completions.items) {
        const normalized = normalizeCompletionDetails(
          markdown,
          active.request.position,
          item,
          lspPositionToOffset,
          offsetToLspPosition,
        );
        if (normalized)
          return {
            reason: "ready",
            text: normalized.text,
            partialAcceptanceOffset: normalized.partialAcceptanceOffset,
            item,
          };
      }
      return {
        reason: completions.items.length
          ? "unsafe-suggestion"
          : "no-suggestion",
        text: "",
      };
    } catch (error) {
      if (!this.current(active)) return { reason: "cancelled", text: "" };
      const code = errorCode(error);
      if (code.includes("blocked") || code.includes("limit"))
        return { reason: "blocked", text: "" };
      if (
        code.includes("auth") ||
        code.includes("signin") ||
        code.includes("sign-in")
      ) {
        this.serverAvailability = "needs-sign-in";
        this.serverMessage = statusText["needs-sign-in"];
        this.publishAll();
        return { reason: "needs-sign-in", text: "" };
      }
      this.serverAvailability = "unavailable";
      this.serverMessage =
        error instanceof Error
          ? error.message.slice(0, 512)
          : statusText.unavailable;
      this.publishAll();
      return { reason: "failed", text: "" };
    }
  }
  public feedback(message: AiSuggestionFeedback): void {
    const record = this.candidates.get(message.candidateId);
    if (!record || record.session.panel.id !== message.sessionId) return;
    if (message.action === "shown") {
      if (
        !record.shown &&
        record.session.panel.isReady() &&
        record.session.panel.isActive()
      ) {
        record.shown = true;
        this.environment.server.reportShown(record.item);
      }
    } else if (message.action === "partially-accepted") {
      const acceptedLength = message.acceptedLength ?? 0;
      if (
        record.shown &&
        record.session.panel.isReady() &&
        record.session.panel.isActive() &&
        acceptedLength > record.acceptedLength &&
        acceptedLength <= record.item.insertText.length
      ) {
        record.acceptedLength = acceptedLength;
        record.version = record.session.panel.version();
        this.environment.server.reportPartiallyAccepted(
          record.item,
          acceptedLength,
        );
      }
    } else if (message.action === "accepted") {
      if (
        record.shown &&
        record.session.panel.isReady() &&
        record.session.panel.isActive() &&
        record.session.panel.documentId() === record.documentId &&
        record.session.panel.version() >= record.version
      )
        void this.environment.server.reportAccepted(record.item);
      this.candidates.delete(message.candidateId);
    } else if (message.action === "rejected") {
      this.candidates.delete(message.candidateId);
    }
  }
  private pruneCandidates(): void {
    const now = Date.now();
    for (const [id, candidate] of this.candidates)
      if (
        candidate.expires < now ||
        candidate.session.panel.isActive() === false
      )
        this.candidates.delete(id);
    while (this.candidates.size > 20)
      this.candidates.delete(this.candidates.keys().next().value as string);
  }
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelActive("cancelled");
    this.candidates.clear();
    this.sessions.clear();
    for (const subscription of this.subscriptions.splice(0))
      subscription.dispose();
    this.environment.server.dispose();
  }
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
function errorCode(error: unknown): string {
  if (!(error instanceof Error)) return "";
  return `${error.name} ${error.message}`.toLowerCase();
}
function reasonMessage(reason: AiSuggestionReason): string {
  switch (reason) {
    case "disabled":
      return "Automatic suggestions are off. Manual suggestions remain available.";
    case "unsupported":
      return "The Copilot Language Server is not supported in this extension host.";
    case "needs-sign-in":
      return "Sign in to GitHub Copilot, then try again.";
    case "untrusted":
      return "Copilot suggestions require a trusted workspace.";
    case "blocked":
      return "Copilot could not serve this request because of account, policy, or service limits.";
    case "no-suggestion":
      return "Copilot did not return a suggestion at this position.";
    case "unsafe-suggestion":
      return "Copilot returned suggestions that could not be safely inserted.";
    case "invalid-context":
      return "Place the cursor in supported Markdown prose to request a suggestion.";
    case "timeout":
      return "Copilot did not respond before the request timed out.";
    case "stale":
      return "The document changed before the suggestion was ready.";
    case "cancelled":
      return "The suggestion request was cancelled.";
    case "failed":
      return "The Copilot suggestion request failed.";
    case "ready":
      return "A suggestion is ready.";
  }
}

export function createAiSuggestionsEnvironment(
  context: vscode.ExtensionContext,
): AiSuggestionsEnvironment {
  const binaryName =
    process.platform === "win32"
      ? "copilot-language-server.exe"
      : "copilot-language-server";
  const platformKey = `${process.platform}-${process.arch}`;
  const binaryPath = vscode.Uri.joinPath(
    context.extensionUri,
    "dist",
    "copilot",
    platformKey,
    binaryName,
  ).fsPath;
  let lastStatus: AiAvailability = "disabled";
  let lastText = statusText.disabled;
  const listeners = new Set<(status: AiAvailability, text: string) => void>();
  const report = (status: AiAvailability, text: string): void => {
    lastStatus = status;
    lastText = text;
    for (const listener of listeners) listener(status, text);
  };
  const server = new CopilotLanguageServer({
    binaryPath,
    extensionVersion: context.extension?.packageJSON?.version ?? "unknown",
    workspaceFolder: () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      return folder
        ? { name: folder.name, uri: folder.uri.toString() }
        : undefined;
    },
    proxy: () => {
      const config = vscode.workspace.getConfiguration("http");
      return {
        proxy:
          typeof config.get("proxy") === "string"
            ? config.get<string>("proxy", "")
            : "",
        strictSSL: config.get<boolean>("proxyStrictSSL", true),
      };
    },
    onStatus: (status) => {
      const availability: AiAvailability = status.busy
        ? "preparing"
        : status.kind === "Normal"
          ? "ready"
          : status.kind === "Inactive"
            ? "excluded"
            : status.kind === "Error"
              ? "needs-sign-in"
              : "unavailable";
      const message = status.message || statusText[availability];
      report(
        availability,
        status.actionTitle
          ? `${message} Available server action: ${status.actionTitle}.`
          : message,
      );
    },
    onMessage: (type, message, actions = []) => {
      if (type === 1)
        return vscode.window.showErrorMessage(message, ...actions);
      if (type === 2)
        return vscode.window.showWarningMessage(message, ...actions);
      if (type === 3)
        return vscode.window.showInformationMessage(message, ...actions);
      return undefined;
    },
  });
  return {
    server,
    supported: () => {
      const supported = new Set([
        "darwin-arm64",
        "darwin-x64",
        "linux-arm64",
        "linux-x64",
        "win32-arm64",
        "win32-x64",
      ]);
      return (
        supported.has(platformKey) &&
        platformKey === "darwin-arm64" &&
        vscode.workspace.isTrusted === true &&
        vscode.env.remoteName === undefined &&
        vscode.env.uiKind === vscode.UIKind.Desktop
      );
    },
    trusted: () => vscode.workspace.isTrusted === true,
    settings: () => {
      const config = vscode.workspace.getConfiguration(
        "markdownMint.aiSuggestions",
      );
      const inspected = config.inspect<boolean>("autoTrigger");
      // Only the application/user value is authoritative. Workspace values
      // cannot silently enable network access.
      return {
        autoTrigger:
          (inspected?.globalValue ?? inspected?.defaultValue) === true,
      };
    },
    notify: (message) => void vscode.window.showInformationMessage(message),
    tokenSource: () => new vscode.CancellationTokenSource(),
    statusChanged: (listener) => {
      listeners.add(listener);
      listener(lastStatus, lastText);
      return { dispose: () => listeners.delete(listener) };
    },
  };
}
