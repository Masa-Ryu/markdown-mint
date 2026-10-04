import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import {
  AI_LIMITS,
  isAiWebviewMessage,
  type AiAvailability,
  type AiHostMessage,
  type AiSuggestionReason,
  type AiSuggestionRequest,
  type AiSuggestionSnapshotValidation,
} from "../shared/aiSuggestions";
import {
  LanguageModelSuggestions,
  type LanguageModelAccess,
  type LanguageModelApi,
  type LanguageModelFailure,
} from "./languageModelSuggestions";

export const AI_TRIGGER_COMMAND = "markdownMint.aiSuggestions.trigger";

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
  readonly languageModel: LanguageModelSuggestions;
  setupCompleted(): boolean;
  markSetupCompleted(): Promise<void>;
  supported(): boolean;
  trusted(): boolean;
  settings(): AiSettings;
  notify(message: string): void;
  tokenSource(): vscode.CancellationTokenSource;
}
interface RegisteredSession {
  readonly panel: AiPanelSession;
}
interface ActivationTarget {
  readonly session: RegisteredSession;
  readonly uri: string;
  readonly generation: number;
}
interface ActiveRequest {
  readonly session: RegisteredSession;
  readonly target: ActivationTarget;
  readonly request: AiSuggestionRequest;
  readonly source: vscode.CancellationTokenSource;
  modelGeneration: number;
  readonly documentGeneration: number;
  readonly markdown: string;
  readonly finish: (reason: AiSuggestionReason) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  selectingModel: boolean;
  snapshotValidation: ((current: boolean) => void) | undefined;
  snapshotValidationTimer: ReturnType<typeof setTimeout> | undefined;
}
interface ManualInvocation {
  readonly session: RegisteredSession;
  readonly target: ActivationTarget;
  readonly id: string;
}

const statusText: Record<AiAvailability, string> = {
  disabled:
    "Automatic suggestions are off. Run Suggest Continuation for a manual suggestion.",
  preparing: "Preparing the VS Code Language Model API…",
  "needs-authorization":
    "Run Suggest Continuation to authorize and start a suggestion. This can use Copilot usage.",
  ready: "Copilot language model is available.",
  untrusted: "AI suggestions are disabled in an untrusted workspace.",
  "no-model": "No Copilot language model is currently available.",
  unavailable:
    "The VS Code Language Model API is unavailable in this extension host.",
  "temporarily-unavailable":
    "A temporary model error occurred. Suggestions are paused briefly.",
  blocked:
    "The language model request is blocked by an account, policy, or service limit.",
};

export interface AiStatusSnapshot {
  readonly sessionId: string;
  readonly availability: AiAvailability;
  readonly message: string;
  readonly autoTrigger: boolean;
}

const transientBackoffBaseMs = 1_000;
const transientBackoffMaxMs = 30_000;
const transientBackoffMaxAttempts = 6;

export function transientFailureBackoffMs(attempt: number): number {
  const boundedAttempt = Math.max(
    1,
    Math.min(Math.floor(attempt), transientBackoffMaxAttempts),
  );
  return Math.min(
    transientBackoffBaseMs * 2 ** (boundedAttempt - 1),
    transientBackoffMaxMs,
  );
}

/** Keeps editor-session ownership and LM requests separate from the edit queue. */
export class AiSuggestionsHost implements vscode.Disposable {
  private settings: AiSettings;
  private settingsGeneration = 0;
  private modelGeneration = 0;
  private disposed = false;
  private readonly sessions = new Map<string, RegisteredSession>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private active: ActiveRequest | undefined;
  private activeTarget: ActivationTarget | undefined;
  private activationGeneration = 0;
  private readonly documentGenerations = new Map<string, number>();
  private manualInvocation: ManualInvocation | undefined;
  private transientFailureCount = 0;
  private transientRetryAt: number | undefined;
  private transientRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private selectionGeneration = 0;
  private autoRestoreBlocked = false;
  private manualSelectionCount = 0;
  private modelAvailability: Exclude<AiAvailability, "disabled" | "untrusted"> =
    "needs-authorization";
  private modelMessage = statusText["needs-authorization"];

  constructor(
    private readonly environment: AiSuggestionsEnvironment,
    private readonly reportStatus?: (
      status: AiStatusSnapshot | undefined,
    ) => void,
  ) {
    this.settings = environment.settings();
    this.subscriptions.push(
      environment.languageModel.onDidChange((reason, accessAllowed) => {
        if (this.active?.selectingModel || this.manualSelectionCount > 0)
          return;
        if (
          reason === "models" &&
          this.autoRestoreBlocked &&
          this.modelAvailability === "no-model"
        )
          this.autoRestoreBlocked = false;
        this.modelGeneration += 1;
        this.cancelActive("needs-authorization");
        this.clearTransientBackoff(true);
        const access = environment.languageModel.restoreAccess();
        if (reason === "access" && accessAllowed !== undefined)
          this.autoRestoreBlocked = !accessAllowed;
        this.modelAvailability = access ? failureAvailability(access) : "ready";
        this.modelMessage = access ? reasonMessage(access) : statusText.ready;
        this.publishAll();
      }),
    );
  }

  public registerSession(panel: AiPanelSession): void {
    if (this.disposed) return;
    const session = { panel } satisfies RegisteredSession;
    this.sessions.set(panel.id, session);
    this.publishState(panel.id);
    if (panel.isReady() && panel.isActive())
      void this.sessionActivated(panel.id);
  }

  public unregisterSession(id: string): void {
    const session = this.sessions.get(id);
    this.cancelSession(id);
    if (this.manualInvocation?.session === session)
      this.manualInvocation = undefined;
    this.sessions.delete(id);
    if (session) void this.releaseActivation(session);
  }

  private beginActivation(session: RegisteredSession): ActivationTarget {
    const uri = session.panel.uri();
    const previous = this.activeTarget;
    if (previous?.session === session && previous.uri === uri) return previous;
    if (previous && (previous.session !== session || previous.uri !== uri)) {
      this.cancelSession(previous.session.panel.id);
      if (this.manualInvocation?.session === previous.session)
        this.manualInvocation = undefined;
    }
    const target = { session, uri, generation: ++this.activationGeneration };
    this.activeTarget = target;
    return target;
  }

  private activationCurrent(target: ActivationTarget): boolean {
    return (
      !this.disposed &&
      this.activeTarget === target &&
      target.generation === this.activationGeneration &&
      this.sessions.get(target.session.panel.id) === target.session &&
      target.session.panel.isReady() &&
      target.session.panel.isActive() &&
      target.session.panel.uri() === target.uri
    );
  }

  private activeSession(exceptId?: string): RegisteredSession | undefined {
    return [...this.sessions.entries()].find(
      ([id, session]) =>
        id !== exceptId && session.panel.isReady() && session.panel.isActive(),
    )?.[1];
  }

  public publishState(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    const availability = this.availability();
    const message = this.statusMessage(availability);
    const selected = this.environment.languageModel.currentSelection;
    const modelName = selected?.displayName;
    session.panel.post({
      protocolVersion: 1,
      type: "ai-suggestion-state",
      sessionId: id,
      settingsGeneration: this.settingsGeneration,
      autoTrigger: this.settings.autoTrigger,
      availability,
      autoRestoreOnInput:
        this.environment.setupCompleted() && !this.autoRestoreBlocked,
      statusText: message,
      ...(modelName ? { modelName } : {}),
      active: session.panel.isReady() && session.panel.isActive(),
    });
    const activeTarget = this.activeTarget;
    if (activeTarget?.session !== session) return;
    if (this.activationCurrent(activeTarget)) {
      this.reportStatus?.({
        sessionId: id,
        availability,
        message,
        autoTrigger: this.settings.autoTrigger,
      });
    } else {
      this.reportStatus?.(undefined);
    }
  }

  private publishAll(): void {
    for (const id of this.sessions.keys()) this.publishState(id);
  }

  private availability(): AiAvailability {
    if (!this.environment.supported()) return "unavailable";
    if (!this.environment.trusted()) return "untrusted";
    if (!this.settings.autoTrigger && this.modelAvailability === "ready")
      return "disabled";
    return this.modelAvailability;
  }

  private statusMessage(availability: AiAvailability): string {
    const selection = this.environment.languageModel.currentSelection;
    if (availability === "disabled") return statusText.disabled;
    if (
      availability === "needs-authorization" &&
      this.settings.autoTrigger &&
      this.environment.setupCompleted() &&
      !this.autoRestoreBlocked
    )
      return "Type in the active Mint editor to re-check Copilot access after restart. This can use Copilot usage.";
    if (availability === "ready" && selection)
      return `Copilot model: ${selection.displayName}. ${selection.reason}. Requests may use Copilot usage.`;
    return this.modelMessage || statusText[availability];
  }

  public refreshSettings(): void {
    const next = this.environment.settings();
    if (next.autoTrigger === this.settings.autoTrigger) return;
    const wasEnabled = this.settings.autoTrigger;
    this.settings = next;
    if (wasEnabled && !next.autoTrigger) {
      if (this.active?.request.trigger === "auto")
        this.cancelActive("cancelled");
      // Manual requests remain usable while automatic suggestions are off.
    }
    this.publishAll();
  }

  public trustChanged(): void {
    this.settingsGeneration += 1;
    this.cancelActive("untrusted");
    this.publishAll();
  }

  public documentChanged(documentUri: string): void {
    this.documentGenerations.set(
      documentUri,
      (this.documentGenerations.get(documentUri) ?? 0) + 1,
    );
    if (this.active?.target.uri === documentUri) this.cancelActive("stale");
  }

  /** Model selection and any consent UI are reachable only from this command. */
  public async triggerFromUserAction(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || !session.panel.canStartRequest()) {
      this.environment.notify(
        "Open and focus a ready Markdown Mint editor before requesting a suggestion.",
      );
      return;
    }
    if (!this.environment.supported()) {
      this.environment.notify(statusText.unavailable);
      return;
    }
    if (!this.environment.trusted()) {
      this.environment.notify(statusText.untrusted);
      return;
    }
    if (this.modelAvailability === "blocked") {
      this.environment.notify(statusText.blocked);
      return;
    }
    if (this.transientRetryAt && Date.now() < this.transientRetryAt) {
      this.environment.notify(statusText["temporarily-unavailable"]);
      return;
    }

    const target = this.beginActivation(session);
    this.cancelActive("cancelled");
    this.manualInvocation = undefined;
    this.modelAvailability = "preparing";
    this.modelMessage = statusText.preparing;
    this.autoRestoreBlocked = false;
    const selectionGeneration = ++this.selectionGeneration;
    this.publishAll();
    this.manualSelectionCount += 1;
    let failure: LanguageModelFailure | undefined;
    try {
      failure = await this.environment.languageModel.selectForUserAction();
    } finally {
      this.manualSelectionCount -= 1;
    }
    if (
      !this.activationCurrent(target) ||
      selectionGeneration !== this.selectionGeneration
    ) {
      if (selectionGeneration === this.selectionGeneration) {
        if (!failure) await this.persistSetupCompletion();
        this.reconcileSelectionAfterTargetChange(failure);
      }
      return;
    }
    this.clearTransientBackoff(true);
    this.modelGeneration += 1;
    if (failure) {
      this.autoRestoreBlocked = true;
      this.modelAvailability = failureAvailability(failure);
      this.modelMessage = reasonMessage(failure);
      this.publishAll();
      this.environment.notify(this.modelMessage);
      return;
    }
    await this.persistSetupCompletion();
    if (
      !this.activationCurrent(target) ||
      selectionGeneration !== this.selectionGeneration
    ) {
      if (selectionGeneration === this.selectionGeneration)
        this.reconcileSelectionAfterTargetChange(undefined);
      return;
    }
    this.modelAvailability = "ready";
    this.modelMessage = statusText.ready;
    this.cancelActive("cancelled");
    const invocationId = `manual-${randomUUID()}`;
    this.manualInvocation = { session, target, id: invocationId };
    session.panel.focus();
    session.panel.post({
      protocolVersion: 1,
      type: "ai-suggestion-trigger",
      sessionId: id,
      settingsGeneration: this.settingsGeneration,
      invocationId,
    });
    this.publishAll();
  }

  public async sessionActivated(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || !session.panel.isReady() || !session.panel.isActive())
      return;
    const target = this.beginActivation(session);
    if (this.activationCurrent(target)) this.publishState(id);
  }

  public async sessionDeactivated(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.cancelSession(id);
    if (this.manualInvocation?.session === session)
      this.manualInvocation = undefined;
    await this.releaseActivation(session);
  }

  private async releaseActivation(session: RegisteredSession): Promise<void> {
    if (this.activeTarget?.session !== session) return;
    this.cancelSession(session.panel.id);
    this.activeTarget = undefined;
    this.activationGeneration += 1;
    const replacement = this.activeSession(session.panel.id);
    if (replacement) {
      this.activeTarget = {
        session: replacement,
        uri: replacement.panel.uri(),
        generation: ++this.activationGeneration,
      };
      this.publishState(replacement.panel.id);
    } else this.reportStatus?.(undefined);
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
    active.snapshotValidation?.(false);
  }

  public confirmSnapshotValidation(
    id: string,
    validation: AiSuggestionSnapshotValidation,
  ): void {
    const active = this.active;
    if (
      !active ||
      active.session.panel.id !== id ||
      validation.sessionId !== id ||
      active.request.requestId !== validation.requestId
    )
      return;
    active.snapshotValidation?.(validation.current);
  }

  private validateWebviewSnapshot(active: ActiveRequest): Promise<boolean> {
    return new Promise((resolve) => {
      const finish = (current: boolean): void => {
        if (active.snapshotValidation !== finish) return;
        active.snapshotValidation = undefined;
        if (active.snapshotValidationTimer !== undefined)
          clearTimeout(active.snapshotValidationTimer);
        active.snapshotValidationTimer = undefined;
        resolve(current);
      };
      active.snapshotValidation = finish;
      active.snapshotValidationTimer = setTimeout(
        () => finish(false),
        AI_LIMITS.snapshotCheckDeadlineMs,
      );
      try {
        active.session.panel.post({
          protocolVersion: 1,
          type: "ai-suggestion-snapshot-check",
          requestId: active.request.requestId,
          sessionId: active.session.panel.id,
        });
      } catch {
        finish(false);
      }
    });
  }

  private current(active: ActiveRequest): boolean {
    const { request, session } = active;
    return (
      !this.disposed &&
      this.active === active &&
      !active.source.token.isCancellationRequested &&
      this.sessions.get(session.panel.id) === session &&
      this.activationCurrent(active.target) &&
      active.modelGeneration === this.modelGeneration &&
      active.documentGeneration ===
        (this.documentGenerations.get(active.target.uri) ?? 0) &&
      request.settingsGeneration === this.settingsGeneration &&
      request.documentId === session.panel.documentId() &&
      request.baseVersion === session.panel.version()
    );
  }

  private reply(
    session: RegisteredSession,
    request: AiSuggestionRequest,
    reason: AiSuggestionReason,
    text = "",
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
    const invocation =
      request.trigger === "manual" ? this.manualInvocation : undefined;
    const validManual =
      request.trigger !== "manual" ||
      Boolean(
        invocation &&
        invocation.id === request.invocationId &&
        invocation.session === session,
      );
    if (
      !session.panel.canStartRequest() ||
      !validManual ||
      request.documentId !== session.panel.documentId() ||
      request.baseVersion !== session.panel.version() ||
      request.settingsGeneration !== this.settingsGeneration
    ) {
      this.reply(session, request, "stale");
      return;
    }
    if (request.trigger === "manual") this.manualInvocation = undefined;
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
    if (this.modelAvailability === "blocked") {
      this.reply(session, request, "blocked");
      return;
    }
    if (this.transientRetryAt && Date.now() < this.transientRetryAt) {
      this.reply(session, request, "backoff");
      return;
    }
    const target = this.beginActivation(session);
    if (!this.activationCurrent(target)) {
      this.reply(session, request, "stale");
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
    this.cancelActive("cancelled");
    const source = this.environment.tokenSource();
    let finish!: (reason: AiSuggestionReason) => void;
    const interrupted = new Promise<AiSuggestionReason>((resolve) => {
      finish = resolve;
    });
    const active: ActiveRequest = {
      session,
      target,
      request,
      source,
      modelGeneration: this.modelGeneration,
      documentGeneration: this.documentGenerations.get(target.uri) ?? 0,
      markdown,
      finish,
      timer: undefined,
      selectingModel: false,
      snapshotValidation: undefined,
      snapshotValidationTimer: undefined,
    };
    this.active = active;
    try {
      let access = this.environment.languageModel.restoreAccess();
      const canRestoreFromInput =
        request.trigger === "auto" &&
        request.afterUserInput === true &&
        this.environment.setupCompleted() &&
        !this.autoRestoreBlocked;
      if (access === "needs-authorization" && canRestoreFromInput) {
        const selectionGeneration = ++this.selectionGeneration;
        active.selectingModel = true;
        this.modelAvailability = "preparing";
        this.modelMessage = statusText.preparing;
        this.publishAll();
        const selection = this.environment.languageModel.selectForUserAction();
        const result = await Promise.race([
          selection.then((failure) => ({ failure })),
          interrupted.then((reason) => ({ reason })),
        ]);
        active.selectingModel = false;
        if ("reason" in result) {
          this.reply(session, request, result.reason);
          void selection.then((failure) => {
            if (selectionGeneration === this.selectionGeneration)
              this.reconcileSelectionAfterTargetChange(failure);
          });
          return;
        }
        if (!this.current(active)) {
          this.reply(session, request, "stale");
          if (selectionGeneration === this.selectionGeneration) {
            if (!result.failure) void this.persistSetupCompletion();
            this.reconcileSelectionAfterTargetChange(result.failure);
          }
          return;
        }
        this.modelGeneration += 1;
        active.modelGeneration = this.modelGeneration;
        if (result.failure) {
          this.autoRestoreBlocked = true;
          this.modelAvailability = failureAvailability(result.failure);
          this.modelMessage = reasonMessage(result.failure);
          this.reply(session, request, result.failure);
          this.publishAll();
          return;
        }
        this.modelAvailability = "ready";
        this.modelMessage = statusText.ready;
        this.publishAll();
        session.panel.focus();
        if (!this.current(active)) {
          this.reply(session, request, "stale");
          return;
        }
        const snapshotCurrent = await Promise.race([
          this.validateWebviewSnapshot(active).then((current) => ({ current })),
          interrupted.then((reason) => ({ reason })),
        ]);
        if (
          "reason" in snapshotCurrent ||
          !snapshotCurrent.current ||
          !this.current(active)
        ) {
          this.reply(
            session,
            request,
            "reason" in snapshotCurrent ? snapshotCurrent.reason : "stale",
          );
          return;
        }
        access = this.environment.languageModel.restoreAccess();
      }
      if (access) {
        const reason = access === "failed" ? "unsupported" : access;
        if (canRestoreFromInput) this.autoRestoreBlocked = true;
        this.modelAvailability = failureAvailability(access);
        this.modelMessage = reasonMessage(access);
        this.publishAll();
        this.reply(session, request, reason);
        return;
      }
      if (!this.current(active)) {
        this.reply(session, request, "stale");
        return;
      }
      active.timer = setTimeout(
        () => this.cancelActive("timeout"),
        AI_LIMITS.deadlineMs,
      );
      const work = this.environment.languageModel.complete(
        markdown,
        request.position,
        request.targetKind,
        source.token,
      );
      const result = await Promise.race([
        work.then((outcome) => ({ outcome })),
        interrupted.then((reason) => ({ reason })),
      ]);
      if ("reason" in result) {
        this.reply(session, request, result.reason);
        if (result.reason === "timeout") this.recordTransientFailure();
      } else if (!this.current(active)) {
        this.reply(session, request, "stale");
      } else if (result.outcome.failure) {
        const reason = result.outcome.failure;
        this.reply(session, request, reason);
        if (reason === "failed" || reason === "timeout") {
          this.recordTransientFailure();
        } else if (reason === "blocked") {
          this.modelAvailability = "blocked";
          this.modelMessage = reasonMessage(reason);
          this.publishAll();
        } else if (reason === "needs-authorization" || reason === "no-model") {
          this.modelGeneration += 1;
          this.modelAvailability = reason;
          this.modelMessage = reasonMessage(reason);
          this.publishAll();
        }
      } else if (result.outcome.text) {
        this.clearTransientBackoff(true);
        if (this.modelAvailability === "temporarily-unavailable") {
          this.modelAvailability = "ready";
          this.modelMessage = statusText.ready;
          this.publishAll();
        }
        this.reply(session, request, "ready", result.outcome.text);
      } else {
        this.clearTransientBackoff(true);
        this.reply(session, request, "no-suggestion");
      }
    } finally {
      if (active.timer !== undefined) clearTimeout(active.timer);
      source.cancel();
      source.dispose();
      if (this.active === active) this.active = undefined;
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.activeTarget = undefined;
    this.activationGeneration += 1;
    this.manualInvocation = undefined;
    this.clearTransientBackoff(true);
    this.cancelActive("cancelled");
    for (const subscription of this.subscriptions.splice(0))
      subscription.dispose();
    this.sessions.clear();
    this.reportStatus?.(undefined);
    this.environment.languageModel.dispose();
  }

  private reconcileSelectionAfterTargetChange(
    failure: LanguageModelFailure | undefined,
  ): void {
    this.modelGeneration += 1;
    if (failure) {
      this.autoRestoreBlocked = true;
      this.modelAvailability = failureAvailability(failure);
      this.modelMessage = reasonMessage(failure);
    } else if (this.environment.languageModel.restoreAccess()) {
      this.autoRestoreBlocked = true;
      this.modelAvailability = "needs-authorization";
      this.modelMessage = statusText["needs-authorization"];
    } else {
      this.autoRestoreBlocked = false;
      this.modelAvailability = "ready";
      this.modelMessage = statusText.ready;
    }
    this.publishAll();
  }

  private async persistSetupCompletion(): Promise<void> {
    try {
      await this.environment.markSetupCompleted();
    } catch {
      // Manual use remains available if this non-secret convenience marker
      // cannot be persisted; automatic restoration then stays disabled.
    }
  }

  private recordTransientFailure(): void {
    this.transientFailureCount = Math.min(
      this.transientFailureCount + 1,
      transientBackoffMaxAttempts,
    );
    const retryAt =
      Date.now() + transientFailureBackoffMs(this.transientFailureCount);
    this.transientRetryAt = retryAt;
    if (this.transientRetryTimer !== undefined)
      clearTimeout(this.transientRetryTimer);
    this.modelAvailability = "temporarily-unavailable";
    this.modelMessage = statusText["temporarily-unavailable"];
    this.transientRetryTimer = setTimeout(() => {
      if (this.disposed || this.transientRetryAt !== retryAt) return;
      this.transientRetryAt = undefined;
      this.transientRetryTimer = undefined;
      const access = this.environment.languageModel.restoreAccess();
      if (access) {
        this.modelAvailability = failureAvailability(access);
        this.modelMessage = reasonMessage(access);
      } else {
        this.modelAvailability = "ready";
        this.modelMessage = statusText.ready;
      }
      this.publishAll();
    }, retryAt - Date.now());
    this.publishAll();
  }

  private clearTransientBackoff(resetAttempts: boolean): void {
    if (this.transientRetryTimer !== undefined)
      clearTimeout(this.transientRetryTimer);
    this.transientRetryTimer = undefined;
    this.transientRetryAt = undefined;
    if (resetAttempts) this.transientFailureCount = 0;
  }
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function failureAvailability(
  failure: LanguageModelFailure,
): Exclude<AiAvailability, "disabled" | "untrusted"> {
  switch (failure) {
    case "blocked":
      return "blocked";
    case "no-model":
      return "no-model";
    case "needs-authorization":
      return "needs-authorization";
    case "failed":
    case "timeout":
    case "cancelled":
    case "no-suggestion":
    case "invalid-context":
    case "unsafe-suggestion":
      return "unavailable";
  }
}

function reasonMessage(reason: LanguageModelFailure): string {
  switch (reason) {
    case "needs-authorization":
      return statusText["needs-authorization"];
    case "no-model":
      return statusText["no-model"];
    case "blocked":
      return statusText.blocked;
    case "timeout":
      return "The language model did not finish before the request timed out.";
    case "cancelled":
      return "The language model request was cancelled.";
    case "invalid-context":
      return "Place the cursor in supported Markdown prose to request a suggestion.";
    case "unsafe-suggestion":
      return "The model response could not be safely inserted.";
    case "no-suggestion":
      return "The language model did not return a suggestion at this position.";
    case "failed":
      return "The language model request failed.";
  }
}

export function createAiSuggestionsEnvironment(
  context: vscode.ExtensionContext,
): AiSuggestionsEnvironment {
  const api = getLanguageModelApi();
  const access = getLanguageModelAccess(context);
  const languageModel = new LanguageModelSuggestions({
    ...(api ? { api } : {}),
    ...(access ? { access } : {}),
  });
  return {
    languageModel,
    supported: () =>
      Boolean(getLanguageModelApi() && getLanguageModelAccess(context)) &&
      vscode.env.remoteName === undefined &&
      vscode.env.uiKind === vscode.UIKind.Desktop,
    trusted: () => vscode.workspace.isTrusted === true,
    settings: () => {
      const config = vscode.workspace.getConfiguration(
        "markdownMint.aiSuggestions",
      );
      const inspected = config.inspect<boolean>("autoTrigger");
      return {
        autoTrigger:
          (inspected?.globalValue ?? inspected?.defaultValue) === true,
      };
    },
    setupCompleted: () =>
      context.globalState.get<boolean>(
        "markdownMint.aiSuggestions.setupCompleted",
      ) === true,
    markSetupCompleted: async () => {
      await context.globalState.update(
        "markdownMint.aiSuggestions.setupCompleted",
        true,
      );
    },
    notify: (message) => void vscode.window.showInformationMessage(message),
    tokenSource: () => new vscode.CancellationTokenSource(),
  };
}

function getLanguageModelApi(): LanguageModelApi | undefined {
  const value = (vscode as typeof vscode & { lm?: LanguageModelApi }).lm;
  return value && typeof value.selectChatModels === "function"
    ? value
    : undefined;
}

function getLanguageModelAccess(
  context: vscode.ExtensionContext,
): LanguageModelAccess | undefined {
  const value = (
    context as vscode.ExtensionContext & {
      languageModelAccessInformation?: LanguageModelAccess;
    }
  ).languageModelAccessInformation;
  return value && typeof value.canSendRequest === "function"
    ? value
    : undefined;
}
