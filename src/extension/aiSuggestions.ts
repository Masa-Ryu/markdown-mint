import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import {
  AI_LIMITS,
  isAiWebviewMessage,
  type AiAvailability,
  type AiHostMessage,
  type AiSuggestionReason,
  type AiSuggestionRequest,
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
  readonly modelGeneration: number;
  readonly documentGeneration: number;
  readonly markdown: string;
  readonly finish: (reason: AiSuggestionReason) => void;
  timer: ReturnType<typeof setTimeout>;
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
  blocked:
    "The language model request is blocked by an account, policy, or service limit.",
};

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
  private modelAvailability: Exclude<AiAvailability, "disabled" | "untrusted"> =
    "needs-authorization";
  private modelMessage = statusText["needs-authorization"];

  constructor(
    private readonly environment: AiSuggestionsEnvironment,
    private readonly reportStatus?: (
      availability: AiAvailability,
      message: string,
      autoTrigger: boolean,
    ) => void,
  ) {
    this.settings = environment.settings();
    this.subscriptions.push(
      environment.languageModel.onDidChange(() => {
        this.modelGeneration += 1;
        this.cancelActive("needs-authorization");
        this.modelAvailability = "needs-authorization";
        this.modelMessage = statusText["needs-authorization"];
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
      statusText: message,
      ...(modelName ? { modelName } : {}),
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
    if (!this.settings.autoTrigger && this.modelAvailability === "ready")
      return "disabled";
    return this.modelAvailability;
  }

  private statusMessage(availability: AiAvailability): string {
    const selection = this.environment.languageModel.currentSelection;
    if (availability === "disabled") return statusText.disabled;
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

    const target = this.beginActivation(session);
    this.cancelActive("cancelled");
    this.manualInvocation = undefined;
    this.modelAvailability = "preparing";
    this.modelMessage = statusText.preparing;
    this.publishAll();
    const failure = await this.environment.languageModel.selectForUserAction();
    if (!this.activationCurrent(target)) return;
    this.modelGeneration += 1;
    if (failure) {
      this.modelAvailability = failureAvailability(failure);
      this.modelMessage = reasonMessage(failure);
      this.publishAll();
      this.environment.notify(this.modelMessage);
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
    const access = this.environment.languageModel.restoreAccess();
    if (access) {
      const reason = access === "failed" ? "unsupported" : access;
      this.reply(session, request, reason);
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
      timer: setTimeout(
        () => this.cancelActive("timeout"),
        AI_LIMITS.deadlineMs,
      ),
    };
    this.active = active;
    try {
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
      } else if (!this.current(active)) {
        this.reply(session, request, "stale");
      } else if (result.outcome.failure) {
        const reason = result.outcome.failure;
        this.reply(session, request, reason);
        if (reason === "blocked") {
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
        this.reply(session, request, "ready", result.outcome.text);
      } else {
        this.reply(session, request, "no-suggestion");
      }
    } finally {
      clearTimeout(active.timer);
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
    this.cancelActive("cancelled");
    for (const subscription of this.subscriptions.splice(0))
      subscription.dispose();
    this.sessions.clear();
    this.environment.languageModel.dispose();
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
