import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import {
  AI_LIMITS,
  isAiWebviewMessage,
  type AiAvailability,
  type AiSuggestionCandidate,
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
  type CopilotServerStatus,
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
    listener: (
      status: AiAvailability,
      text: string,
      documentUri?: string,
    ) => void,
  ): vscode.Disposable;
}
interface RegisteredSession {
  readonly panel: AiPanelSession;
}
interface ActiveRequest {
  readonly session: RegisteredSession;
  readonly request: AiSuggestionRequest;
  readonly source: vscode.CancellationTokenSource;
  readonly finish: (reason: AiSuggestionReason) => void;
  readonly documentUri: string;
  readonly connectionGeneration: number;
  readonly documentGeneration: number;
  timer: ReturnType<typeof setTimeout>;
}
interface RequestOutcome {
  readonly reason: AiSuggestionReason;
  readonly candidates?: readonly NormalizedCandidate[];
}
interface NormalizedCandidate {
  readonly item: InlineCompletionItem;
  readonly text: string;
  readonly partialAcceptanceOffset: number;
}
interface CandidateRecord {
  readonly session: RegisteredSession;
  readonly requestId: string;
  readonly documentId: string;
  readonly documentUri: string;
  readonly connectionGeneration: number;
  readonly documentGeneration: number;
  version: number;
  readonly item: InlineCompletionItem;
  readonly trigger: "auto" | "manual";
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
  private connectionAvailability: AiAvailability = "disabled";
  private serverMessage = statusText.disabled;
  private readonly excludedDocuments = new Map<string, string>();
  private readonly documentGenerations = new Map<string, number>();
  private connectionGeneration = 0;
  private focusedDocumentUri: string | undefined;
  private startPromise: Promise<boolean> | undefined;

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
        environment.statusChanged((availability, message, documentUri) => {
          this.applyServerAvailability(availability, message, documentUri);
          this.publishAll();
        }),
      );
  }

  public registerSession(panel: AiPanelSession): void {
    if (this.disposed) return;
    this.sessions.set(panel.id, { panel });
    this.publishState(panel.id);
    if (panel.isReady() && panel.isActive() && this.settings.autoTrigger)
      void this.ensureStarted(panel.uri());
  }
  public unregisterSession(id: string): void {
    this.cancelSession(id);
    for (const [candidateId, candidate] of this.candidates)
      if (candidate.session.panel.id === id)
        this.candidates.delete(candidateId);
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    if (session) {
      const uri = session.panel.uri();
      const replacement = [...this.sessions.values()].some(
        (candidate) =>
          candidate.panel.uri() === uri &&
          candidate.panel.isReady() &&
          candidate.panel.isActive(),
      );
      if (
        !replacement &&
        this.focusedDocumentUri === uri &&
        this.environment.server.isRunning
      ) {
        this.focusedDocumentUri = undefined;
        void this.environment.server.focusDocument(undefined);
      } else if (!replacement && this.environment.server.isRunning) {
        void this.environment.server.closeDocument(uri);
      }
    }
  }
  public publishState(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    const uri = session.panel.uri();
    const availability = this.availability(uri);
    const message = this.statusMessage(uri, availability);
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
  private availability(uri: string): AiAvailability {
    if (!this.environment.supported()) return "unavailable";
    if (!this.environment.trusted()) return "untrusted";
    const state = this.connectionState(uri);
    if (state === "excluded") return state;
    if (state !== "ready" && state !== "disabled") return state;
    return !this.settings.autoTrigger ? "disabled" : state;
  }
  private connectionState(uri: string): AiAvailability {
    return this.excludedDocuments.has(uri)
      ? "excluded"
      : this.connectionAvailability;
  }
  private statusMessage(uri: string, availability: AiAvailability): string {
    if (availability === "disabled") return statusText.disabled;
    if (availability === "excluded")
      return this.excludedDocuments.get(uri) ?? statusText.excluded;
    return this.serverMessage || statusText[availability];
  }
  private applyServerAvailability(
    availability: AiAvailability,
    message: string,
    documentUri?: string,
  ): void {
    if (availability === "excluded") {
      const excludedUri = documentUri ?? this.focusedDocumentUri;
      if (excludedUri) {
        this.excludedDocuments.set(excludedUri, message.slice(0, 512));
        this.documentGenerations.set(
          excludedUri,
          this.documentGeneration(excludedUri) + 1,
        );
        if (this.active?.documentUri === excludedUri)
          this.cancelActive("excluded");
        this.deleteCandidatesForDocument(excludedUri);
      }
      // Inactive is a per-document exclusion; it does not make the server
      // connection or authorization unavailable for other documents.
      return;
    }
    const invalidationReason = connectionInvalidationReason(availability);
    if (invalidationReason) {
      this.connectionGeneration += 1;
      this.cancelActive(invalidationReason);
      this.deleteCandidatesForDocument();
    }
    this.connectionAvailability = availability;
    this.serverMessage = message.slice(0, 512) || statusText[availability];
    if (availability === "ready" && documentUri)
      this.excludedDocuments.delete(documentUri);
  }
  public refreshSettings(): void {
    const next = this.environment.settings();
    if (next.autoTrigger !== this.settings.autoTrigger) {
      this.settings = next;
      if (!next.autoTrigger && this.active?.request.trigger === "auto")
        this.cancelActive("cancelled");
      if (!next.autoTrigger)
        for (const [candidateId, candidate] of this.candidates)
          if (candidate.trigger === "auto") this.candidates.delete(candidateId);
      if (next.autoTrigger) {
        const active = [...this.sessions.values()].find(
          (session) => session.panel.isReady() && session.panel.isActive(),
        );
        if (active) void this.sessionActivated(active.panel.id);
      }
      this.publishAll();
      return;
    }
    this.settings = next;
    this.publishAll();
  }
  public trustChanged(): void {
    this.generation += 1;
    this.cancelActive("cancelled");
    this.deleteCandidatesForDocument();
    for (const id of this.sessions.keys()) this.publishState(id);
  }

  private ensureStarted(documentUri?: string): Promise<boolean> {
    if (
      this.disposed ||
      !this.environment.supported() ||
      !this.environment.trusted()
    )
      return Promise.resolve(false);
    if (this.startPromise) return this.startPromise;
    const current = this.environment.server.currentStatus;
    if (
      !this.environment.server.isRunning ||
      availabilityFromServerStatus(current) === "unavailable"
    ) {
      this.connectionAvailability = "preparing";
      this.serverMessage = statusText.preparing;
      this.publishAll();
    }
    const starting = this.startAndReadStatus(documentUri);
    this.startPromise = starting;
    void starting.finally(() => {
      if (this.startPromise === starting) this.startPromise = undefined;
    });
    return starting;
  }
  private async startAndReadStatus(documentUri?: string): Promise<boolean> {
    try {
      await this.environment.server.start(documentUri);
      this.readServerStatus();
      return true;
    } catch (error) {
      this.connectionAvailability = "unavailable";
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
    this.applyServerAvailability(
      availabilityFromServerStatus(status),
      status.message || statusText[availabilityFromServerStatus(status)],
      status.documentUri ?? this.environment.server.focusedDocumentUri,
    );
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
    this.connectionAvailability = "preparing";
    this.serverMessage = "Waiting for GitHub Copilot sign-in…";
    this.publishAll();
    try {
      await this.environment.server.signInFromUserAction(async (code) => {
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
      });
    } finally {
      // didChangeStatus can precede or follow the device-flow RPC response.
      // The status event is authoritative; never replace a successful one
      // with a synthetic preparing state after the RPC resolves.
      this.readServerStatus();
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
    const uri = session.panel.uri();
    if (!(await this.ensureStarted(uri))) {
      this.environment.notify(this.statusMessage(uri, "unavailable"));
      return;
    }
    const registered = this.sessions.get(id);
    if (!registered || !(await this.synchronizeAndFocus(registered))) return;
    const state = this.connectionState(uri);
    if (state === "excluded") {
      this.environment.notify(this.statusMessage(uri, "excluded"));
      return;
    }
    if (state === "needs-sign-in") {
      this.environment.notify(
        "Run Markdown Mint: Sign in to GitHub Copilot, then request a suggestion again.",
      );
      return;
    }
    if (state !== "ready") {
      this.environment.notify(this.statusMessage(uri, state));
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
    const uri = session.panel.uri();
    if (!this.settings.autoTrigger && !this.environment.server.isRunning) {
      this.publishState(id);
      return;
    }
    if (await this.ensureStarted(uri)) await this.synchronizeAndFocus(session);
    this.publishState(id);
  }
  public async sessionDeactivated(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.cancelSession(id);
    const uri = session.panel.uri();
    this.deleteCandidatesForSession(id);
    const anotherActivePanel = [...this.sessions.values()].some(
      (candidate) =>
        candidate.panel.id !== id &&
        candidate.panel.uri() === uri &&
        candidate.panel.isReady() &&
        candidate.panel.isActive(),
    );
    if (
      anotherActivePanel ||
      this.focusedDocumentUri !== uri ||
      !this.environment.server.isRunning
    )
      return;
    this.focusedDocumentUri = undefined;
    await this.environment.server.focusDocument(undefined);
  }
  private async synchronizeAndFocus(
    session: RegisteredSession,
  ): Promise<boolean> {
    const panel = session.panel;
    const uri = panel.uri();
    try {
      await this.environment.server.synchronizeDocument(
        uri,
        panel.version(),
        panel.markdown(),
      );
      if (
        this.sessions.get(panel.id) !== session ||
        !panel.isReady() ||
        !panel.isActive()
      )
        return false;
      this.focusedDocumentUri = uri;
      await this.environment.server.focusDocument(uri);
      return (
        this.sessions.get(panel.id) === session &&
        panel.isReady() &&
        panel.isActive()
      );
    } catch {
      this.connectionAvailability = "unavailable";
      this.serverMessage = statusText.unavailable;
      this.publishAll();
      return false;
    }
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
  private documentGeneration(uri: string): number {
    return this.documentGenerations.get(uri) ?? 0;
  }
  private captureValidity(documentUri: string): {
    readonly documentUri: string;
    readonly connectionGeneration: number;
    readonly documentGeneration: number;
  } {
    return {
      documentUri,
      connectionGeneration: this.connectionGeneration,
      documentGeneration: this.documentGeneration(documentUri),
    };
  }
  private validityCurrent(validity: {
    readonly documentUri: string;
    readonly connectionGeneration: number;
    readonly documentGeneration: number;
  }): boolean {
    return (
      validity.connectionGeneration === this.connectionGeneration &&
      validity.documentGeneration ===
        this.documentGeneration(validity.documentUri)
    );
  }
  private deleteCandidatesForDocument(documentUri?: string): void {
    for (const [candidateId, candidate] of this.candidates)
      if (!documentUri || candidate.documentUri === documentUri)
        this.candidates.delete(candidateId);
  }
  private deleteCandidatesForSession(sessionId: string): void {
    for (const [candidateId, candidate] of this.candidates)
      if (candidate.session.panel.id === sessionId)
        this.candidates.delete(candidateId);
  }
  private candidateIdentityCurrent(record: CandidateRecord): boolean {
    return (
      !this.disposed &&
      this.sessions.get(record.session.panel.id) === record.session &&
      record.session.panel.isReady() &&
      record.session.panel.isActive() &&
      record.session.panel.documentId() === record.documentId &&
      this.validityCurrent(record)
    );
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
      this.validityCurrent(active) &&
      request.settingsGeneration === this.generation &&
      request.documentId === session.panel.documentId() &&
      request.baseVersion === session.panel.version()
    );
  }
  private snapshotCurrent(
    session: RegisteredSession,
    request: AiSuggestionRequest,
    validity: {
      readonly documentUri: string;
      readonly connectionGeneration: number;
      readonly documentGeneration: number;
    },
  ): boolean {
    return (
      !this.disposed &&
      this.sessions.get(session.panel.id) === session &&
      session.panel.isReady() &&
      session.panel.isActive() &&
      this.validityCurrent(validity) &&
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
    candidates?: readonly AiSuggestionCandidate[],
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
      ...(candidates ? { candidates } : {}),
    });
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
    const documentUri = session.panel.uri();
    const validity = this.captureValidity(documentUri);
    const connectionState = this.connectionState(documentUri);
    if (connectionState === "excluded") {
      this.reply(session, request, "excluded");
      return;
    }
    if (connectionState === "needs-sign-in") {
      this.reply(session, request, "needs-sign-in");
      return;
    }
    if (connectionState === "blocked") {
      this.reply(session, request, "blocked");
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
    if (!(await this.ensureStarted(session.panel.uri()))) {
      this.reply(
        session,
        request,
        this.snapshotCurrent(session, request, validity) ? "failed" : "stale",
      );
      return;
    }
    if (!this.snapshotCurrent(session, request, validity)) {
      this.reply(session, request, "stale");
      return;
    }
    if (this.excludedDocuments.has(request.documentId)) {
      this.reply(session, request, "excluded");
      return;
    }
    this.cancelActive("cancelled");
    const source = this.environment.tokenSource();
    let finish!: (reason: AiSuggestionReason) => void;
    const interrupted = new Promise<RequestOutcome>((resolve) => {
      finish = (reason) => resolve({ reason });
    });
    const active = {
      session,
      request,
      source,
      finish,
      ...validity,
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
          const candidates = (result.candidates ?? [])
            .slice(0, AI_LIMITS.maxCompletionCandidates)
            .map((candidate) => {
              const candidateId = `c-${randomUUID()}`;
              this.candidates.set(candidateId, {
                session,
                requestId: request.requestId,
                documentId: request.documentId,
                documentUri,
                connectionGeneration: active.connectionGeneration,
                documentGeneration: active.documentGeneration,
                version: request.baseVersion,
                item: candidate.item,
                trigger: request.trigger,
                expires: Date.now() + 120_000,
                shown: false,
                acceptedLength: 0,
              });
              return {
                candidateId,
                text: candidate.text,
                partialAcceptanceOffset: candidate.partialAcceptanceOffset,
              } satisfies AiSuggestionCandidate;
            });
          this.pruneCandidates();
          const first = candidates[0];
          if (first) {
            this.reply(
              session,
              request,
              "ready",
              first.text,
              first.candidateId,
              first.partialAcceptanceOffset,
              candidates,
            );
          } else this.reply(session, request, "unsafe-suggestion");
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
      if (!this.current(active)) return { reason: "cancelled" };
      const uri = active.session.panel.uri();
      this.focusedDocumentUri = uri;
      await this.environment.server.focusDocument(uri);
      if (!this.current(active)) return { reason: "cancelled" };
      if (this.excludedDocuments.has(uri)) return { reason: "excluded" };
      const completions = await this.environment.server.requestInlineCompletion(
        active.session.panel.uri(),
        active.request.baseVersion,
        offsetToLspPosition(markdown, active.request.position),
        active.request.trigger,
        active.source.token,
      );
      if (!this.current(active)) return { reason: "cancelled" };
      const candidates: NormalizedCandidate[] = [];
      for (const item of completions.items.slice(
        0,
        AI_LIMITS.maxCompletionCandidates,
      )) {
        const normalized = normalizeCompletionDetails(
          markdown,
          active.request.position,
          item,
          lspPositionToOffset,
          offsetToLspPosition,
        );
        if (normalized) {
          candidates.push({
            item,
            text: normalized.text,
            partialAcceptanceOffset: normalized.partialAcceptanceOffset,
          });
        }
      }
      if (candidates.length) return { reason: "ready", candidates };
      return {
        reason: completions.items.length
          ? "unsafe-suggestion"
          : "no-suggestion",
      };
    } catch (error) {
      if (!this.current(active)) return { reason: "cancelled" };
      const code = errorCode(error);
      if (code.includes("blocked") || code.includes("limit")) {
        this.applyServerAvailability("blocked", statusText.blocked);
        this.publishAll();
        return { reason: "blocked" };
      }
      if (
        code.includes("auth") ||
        code.includes("signin") ||
        code.includes("sign-in")
      ) {
        this.applyServerAvailability(
          "needs-sign-in",
          statusText["needs-sign-in"],
        );
        this.publishAll();
        return { reason: "needs-sign-in" };
      }
      this.applyServerAvailability("unavailable", statusText.unavailable);
      this.publishAll();
      return { reason: "failed" };
    }
  }
  public feedback(message: AiSuggestionFeedback): void {
    const record = this.candidates.get(message.candidateId);
    if (
      !record ||
      record.session.panel.id !== message.sessionId ||
      record.requestId !== message.requestId
    )
      return;
    if (!this.candidateIdentityCurrent(record)) {
      this.candidates.delete(message.candidateId);
      return;
    }
    if (message.action === "shown") {
      if (
        record.session.panel.documentId() !== record.documentId ||
        record.session.panel.version() !== record.version
      ) {
        this.candidates.delete(message.candidateId);
        return;
      }
      if (
        !record.shown &&
        record.session.panel.isReady() &&
        record.session.panel.isActive()
      ) {
        record.shown = true;
        this.environment.server.reportShown(record.item);
        for (const [candidateId, sibling] of this.candidates)
          if (
            candidateId !== message.candidateId &&
            sibling.session === record.session &&
            sibling.requestId === record.requestId
          )
            this.candidates.delete(candidateId);
        this.serverMessage = "A Copilot suggestion is available.";
        this.publishState(record.session.panel.id);
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
      if (message.rejectionReason === "unsafe-suggestion") {
        this.serverMessage = reasonMessage("unsafe-suggestion");
        this.publishState(record.session.panel.id);
      }
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
function availabilityFromServerStatus(
  status: CopilotServerStatus,
): AiAvailability {
  switch (status.kind) {
    case "Normal":
      return "ready";
    case "Inactive":
      return "excluded";
    case "Error":
      return "needs-sign-in";
    case "Warning":
      return status.busy ? "preparing" : "unavailable";
  }
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
    case "excluded":
      return "Copilot excluded this Markdown document from suggestions.";
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

function connectionInvalidationReason(
  availability: AiAvailability,
): AiSuggestionReason | undefined {
  switch (availability) {
    case "needs-sign-in":
      return "needs-sign-in";
    case "unavailable":
      return "failed";
    case "blocked":
      return "blocked";
    case "untrusted":
      return "untrusted";
    default:
      return undefined;
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
  let lastDocumentUri: string | undefined;
  const listeners = new Set<
    (status: AiAvailability, text: string, documentUri?: string) => void
  >();
  const report = (
    status: AiAvailability,
    text: string,
    documentUri?: string,
  ): void => {
    lastStatus = status;
    lastText = text;
    lastDocumentUri = documentUri;
    for (const listener of listeners) listener(status, text, documentUri);
  };
  const server = new CopilotLanguageServer({
    binaryPath,
    extensionVersion: context.extension?.packageJSON?.version ?? "unknown",
    workspaceFolder: (documentUri) => {
      if (!documentUri) return undefined;
      let folder: vscode.WorkspaceFolder | undefined;
      try {
        folder = vscode.workspace.getWorkspaceFolder(
          vscode.Uri.parse(documentUri),
        );
      } catch {
        return undefined;
      }
      return folder
        ? { name: folder.name, uri: folder.uri.toString() }
        : undefined;
    },
    workspaceFolders: () =>
      (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
        name: folder.name,
        uri: folder.uri.toString(),
      })),
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
      const availability = availabilityFromServerStatus(status);
      const message = status.message || statusText[availability];
      report(
        availability,
        status.actionTitle
          ? `${message} Available server action: ${status.actionTitle}.`
          : message,
        status.documentUri,
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
      listener(lastStatus, lastText, lastDocumentUri);
      return { dispose: () => listeners.delete(listener) };
    },
  };
}
