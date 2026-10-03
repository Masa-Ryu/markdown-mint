import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import {
  AI_LIMITS,
  isAiWebviewMessage,
  type AiAvailability,
  type AiHostMessage,
  type AiSuggestionRequest,
  type AiSuggestionReason,
} from "../shared/aiSuggestions";
import {
  fitSuggestionContextToModel,
  normalizeSuggestion,
} from "./aiSuggestionPrompt";

export const AI_TRIGGER_COMMAND = "markdownMint.aiSuggestions.trigger";
export const AI_MODEL_COMMAND = "markdownMint.aiSuggestions.selectModel";
export interface AiSettings {
  readonly autoTrigger: boolean;
  readonly model: string;
}
export interface AiModel extends Pick<
  vscode.LanguageModelChat,
  "id" | "name" | "vendor" | "maxInputTokens" | "countTokens" | "sendRequest"
> {}
export interface AiSuggestionsEnvironment {
  supported(): boolean;
  trusted(): boolean;
  settings(): AiSettings;
  saveModel(id: string): PromiseLike<void>;
  models(): PromiseLike<readonly AiModel[]>;
  access(model: AiModel): boolean | undefined;
  choose(models: readonly AiModel[]): PromiseLike<AiModel | undefined>;
  explain(): PromiseLike<boolean>;
  notify(reason: AiSuggestionReason): void;
  user(text: string): vscode.LanguageModelChatMessage;
  tokenSource(): vscode.CancellationTokenSource;
  onAccessChanged?(listener: () => void): vscode.Disposable;
  onModelsChanged?(listener: () => void): vscode.Disposable;
  now?(): number;
}
export interface AiPanelSession {
  readonly id: string;
  documentId(): string;
  version(): number;
  eligible(): boolean;
  isActive?(): boolean;
  focus(): void;
  post(message: AiHostMessage): void;
}
interface RegisteredSession {
  readonly panel: AiPanelSession;
  invocation: { id: string; expires: number } | undefined;
}
interface ActiveRequest {
  readonly session: RegisteredSession;
  readonly request: AiSuggestionRequest;
  readonly source: vscode.CancellationTokenSource;
  readonly stop: (reason: AiSuggestionReason) => void;
  timer?: ReturnType<typeof setTimeout>;
  iterator?: AsyncIterator<string>;
}

const reasonText: Partial<Record<AiSuggestionReason, string>> = {
  unsupported:
    "This VS Code environment does not provide the Language Model API. Regular Markdown Mint editing is still available.",
  "no-model":
    "The selected Copilot model is unavailable. Use Markdown Mint: Select Suggestion Model to choose an available model.",
  "needs-authorization":
    "Copilot access needs authorization. Run Markdown Mint: Suggest Continuation to resume.",
  untrusted: "AI suggestions require a trusted workspace.",
  blocked:
    "Copilot blocked this request or its usage limit was reached. Try again later.",
  "rate-limited":
    "Suggestions are being requested too frequently. Try again later.",
  failed: "The suggestion request failed. Try again later.",
  timeout: "The suggestion request timed out.",
  "invalid-context":
    "There is no supported prose context for a suggestion at this cursor.",
};

/** No document queue, content logging, provider HTTP, or persistent candidate cache. */
export class AiSuggestionsHost implements vscode.Disposable {
  private settings: AiSettings;
  private model: AiModel | undefined;
  private generation = 0;
  private discoveryGeneration = 0;
  private explained = false;
  private disposed = false;
  private initializing = false;
  private readonly sessions = new Map<string, RegisteredSession>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private active: ActiveRequest | undefined;
  private starts: number[] = [];
  private lastStart = -Infinity;
  private autoCooldownUntil = 0;
  private blockedUntil = 0;

  constructor(private readonly environment: AiSuggestionsEnvironment) {
    this.settings = environment.settings();
    if (environment.onAccessChanged)
      this.subscriptions.push(
        environment.onAccessChanged(() => this.accessChanged()),
      );
    if (environment.onModelsChanged)
      this.subscriptions.push(
        environment.onModelsChanged(() => this.modelsChanged()),
      );
    // Model discovery can prompt. A saved ID is deliberately restored only by a command.
  }
  private now(): number {
    return this.environment.now?.() ?? Date.now();
  }
  public registerSession(panel: AiPanelSession): void {
    if (this.disposed) return;
    this.sessions.set(panel.id, { panel, invocation: undefined });
  }
  public unregisterSession(id: string): void {
    this.cancelSession(id);
    this.sessions.delete(id);
  }
  public publishState(id: string): void {
    const session = this.sessions.get(id);
    session?.panel.post({
      protocolVersion: 1,
      type: "ai-suggestion-state",
      sessionId: id,
      settingsGeneration: this.generation,
      autoTrigger: this.settings.autoTrigger,
      modelName: this.model?.name.slice(0, 512) ?? "",
      availability: this.availability(),
      active: session.panel.isActive?.() ?? session.panel.eligible(),
    });
  }
  private publishAll(): void {
    for (const id of this.sessions.keys()) this.publishState(id);
  }
  private availability(): AiAvailability {
    if (!this.environment.supported()) return "unsupported";
    if (!this.environment.trusted()) return "untrusted";
    if (!this.model)
      return this.settings.model ? "needs-authorization" : "no-model";
    if (this.now() < this.blockedUntil) return "blocked";
    return this.environment.access(this.model) === true
      ? "ready"
      : "needs-authorization";
  }
  public refreshSettings(): void {
    const next = this.environment.settings();
    if (next.model !== this.settings.model) {
      this.model = undefined;
      this.invalidateAll();
    } else if (!next.autoTrigger && this.active?.request.trigger === "auto") {
      this.cancelActive("cancelled");
    }
    this.settings = next;
    this.publishAll();
  }
  private invalidateAll(): void {
    this.generation += 1;
    this.cancelActive("cancelled");
    for (const session of this.sessions.values())
      session.invocation = undefined;
  }
  private accessChanged(): void {
    // Granting consent during a manual send must not cancel that same request.
    if (!this.model || this.environment.access(this.model) !== true) {
      this.discoveryGeneration += 1;
      this.invalidateAll();
    }
    this.publishAll();
  }
  private modelsChanged(): void {
    // Never enumerate from a background event or silently pick another model.
    this.discoveryGeneration += 1;
    this.model = undefined;
    this.invalidateAll();
    this.publishAll();
  }
  public trustChanged(): void {
    this.discoveryGeneration += 1;
    this.invalidateAll();
    this.publishAll();
  }

  private async initializeFromUserAction(select: boolean): Promise<boolean> {
    if (this.disposed || this.initializing) return false;
    if (!this.environment.supported() || !this.environment.trusted()) {
      this.environment.notify(this.availability());
      return false;
    }
    this.initializing = true;
    const generation = this.generation;
    const discoveryGeneration = this.discoveryGeneration;
    try {
      if (!this.explained) {
        if (!(await this.environment.explain()) || this.disposed) return false;
        this.explained = true;
      }
      if (!select && this.model) return true;
      const models = (await this.environment.models()).filter(
        (model) =>
          model.vendor === "copilot" &&
          typeof model.id === "string" &&
          model.id.length > 0 &&
          model.id.length <= 512 &&
          typeof model.name === "string" &&
          typeof model.sendRequest === "function" &&
          typeof model.countTokens === "function",
      );
      if (this.disposed || generation !== this.generation) return false;
      let model =
        !select && this.settings.model
          ? models.find((candidate) => candidate.id === this.settings.model)
          : undefined;
      if (!select && this.settings.model && !model) {
        this.environment.notify("no-model");
        return false;
      }
      if (select || !this.settings.model)
        model = await this.environment.choose(
          [...models].sort(
            (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
          ),
        );
      if (
        this.disposed ||
        generation !== this.generation ||
        !model ||
        !models.includes(model)
      ) {
        if (models.length === 0) this.environment.notify("no-model");
        return false;
      }
      if (this.settings.model !== model.id)
        await this.environment.saveModel(model.id);
      // Saving the chosen ID can legitimately change the settings generation.
      // Provider/access/trust changes must still reject the cached selection.
      if (
        this.disposed ||
        discoveryGeneration !== this.discoveryGeneration ||
        !this.environment.supported() ||
        !this.environment.trusted()
      )
        return false;
      this.settings = this.environment.settings();
      if (this.settings.model !== model.id) return false;
      this.model = model;
      this.invalidateAll();
      this.publishAll();
      return true;
    } catch (error) {
      this.environment.notify(classifyAiError(error));
      return false;
    } finally {
      this.initializing = false;
    }
  }
  public async triggerFromUserAction(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (
      !session?.panel.eligible() ||
      !(await this.initializeFromUserAction(false)) ||
      this.sessions.get(id) !== session ||
      !session.panel.eligible()
    )
      return;
    this.cancelSession(id);
    session.panel.focus();
    const invocationId = `ai-${randomUUID()}`;
    session.invocation = {
      id: invocationId,
      expires: this.now() + AI_LIMITS.deadlineMs,
    };
    this.publishState(id);
    session.panel.post({
      protocolVersion: 1,
      type: "ai-suggestion-trigger",
      sessionId: id,
      settingsGeneration: this.generation,
      invocationId,
    });
  }
  public async selectModelFromUserAction(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session?.panel.eligible()) return;
    if (
      (await this.initializeFromUserAction(true)) &&
      this.sessions.get(id) === session &&
      session.panel.eligible()
    )
      session.panel.focus();
  }

  public cancelSession(id: string, requestId?: string): void {
    if (
      this.active?.session.panel.id === id &&
      (!requestId || this.active.request.requestId === requestId)
    )
      this.cancelActive("cancelled");
    if (!requestId) {
      const session = this.sessions.get(id);
      if (session) session.invocation = undefined;
    }
  }
  private cancelActive(reason: AiSuggestionReason): void {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    active.source.cancel();
    active.stop(reason);
    if (active.timer !== undefined) clearTimeout(active.timer);
  }
  private current(active: ActiveRequest): boolean {
    const { request, session } = active;
    return (
      !this.disposed &&
      this.active === active &&
      !active.source.token.isCancellationRequested &&
      this.sessions.get(session.panel.id) === session &&
      session.panel.eligible() &&
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
  ): void {
    if (this.disposed || this.sessions.get(session.panel.id) !== session)
      return;
    const {
      requestId,
      sessionId,
      documentId,
      baseVersion,
      editorRevision,
      settingsGeneration,
      position,
      targetKind,
    } = request;
    session.panel.post({
      protocolVersion: 1,
      type: "ai-suggestion-result",
      requestId,
      sessionId,
      documentId,
      baseVersion,
      editorRevision,
      settingsGeneration,
      position,
      targetKind,
      reason,
      text,
    });
    if (request.trigger === "manual" && reasonText[reason])
      this.environment.notify(reason);
  }
  public async requestSuggestion(
    id: string,
    request: AiSuggestionRequest,
  ): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || !isAiWebviewMessage(request) || request.sessionId !== id)
      return;
    const manual = request.trigger === "manual";
    if (manual) {
      const invocation = session.invocation;
      session.invocation = undefined;
      if (
        !invocation ||
        invocation.id !== request.invocationId ||
        invocation.expires < this.now()
      )
        return;
    }
    if (
      !session.panel.eligible() ||
      request.documentId !== session.panel.documentId() ||
      request.baseVersion !== session.panel.version() ||
      request.settingsGeneration !== this.generation
    ) {
      this.reply(session, request, "stale");
      return;
    }
    const availability = this.availability();
    if (
      !this.model ||
      availability === "unsupported" ||
      availability === "untrusted" ||
      availability === "blocked" ||
      (!manual && (!this.settings.autoTrigger || availability !== "ready"))
    ) {
      this.reply(
        session,
        request,
        availability === "ready" ? "cancelled" : availability,
      );
      return;
    }
    const now = this.now();
    this.starts = this.starts.filter(
      (start) => now - start < AI_LIMITS.windowMs,
    );
    if (
      now - this.lastStart <
        (manual ? AI_LIMITS.manualIntervalMs : AI_LIMITS.autoIntervalMs) ||
      this.starts.length >= AI_LIMITS.requestsPerWindow ||
      (!manual && now < this.autoCooldownUntil)
    ) {
      this.reply(session, request, "rate-limited");
      return;
    }
    this.cancelActive("cancelled");
    let stop!: (reason: AiSuggestionReason) => void;
    const interrupted = new Promise<{
      reason: AiSuggestionReason;
      text: string;
    }>((resolve) => {
      stop = (reason) => resolve({ reason, text: "" });
    });
    const active: ActiveRequest = {
      session,
      request,
      source: this.environment.tokenSource(),
      stop,
    };
    this.active = active;
    active.timer = setTimeout(() => {
      if (this.active === active) this.cancelActive("timeout");
    }, AI_LIMITS.deadlineMs);
    try {
      const result = await Promise.race([
        this.generate(active, this.model),
        interrupted,
      ]);
      // Cancellation and deadline settle even if a provider ignores its token.
      if (result.reason === "timeout") {
        this.autoCooldownUntil = this.now() + AI_LIMITS.cooldownMs;
        this.reply(session, request, "timeout");
      } else if (this.current(active))
        this.reply(session, request, result.reason, result.text);
    } finally {
      if (active.timer !== undefined) clearTimeout(active.timer);
      active.source.cancel();
      active.source.dispose();
      if (active.iterator?.return)
        void Promise.resolve()
          .then(() => active.iterator?.return?.())
          .catch(() => undefined);
      if (this.active === active) this.active = undefined;
      this.publishAll();
    }
  }
  private async generate(
    active: ActiveRequest,
    model: AiModel,
  ): Promise<{ reason: AiSuggestionReason; text: string }> {
    try {
      const messages = await fitSuggestionContextToModel(
        active.request.context,
        active.request.targetKind,
        model,
        (text) => this.environment.user(text),
        active.source.token,
      );
      if (!this.current(active)) return { reason: "cancelled", text: "" };
      if (!messages) return { reason: "invalid-context", text: "" };
      // Recheck real access immediately before an automatic send.
      if (
        active.request.trigger === "auto" &&
        this.environment.access(model) !== true
      )
        return { reason: "needs-authorization", text: "" };
      const now = this.now();
      this.lastStart = now;
      this.starts.push(now);
      const response = await model.sendRequest(
        messages,
        {},
        active.source.token,
      );
      if (!this.current(active)) return { reason: "cancelled", text: "" };
      const iterator = response.text[Symbol.asyncIterator]();
      active.iterator = iterator;
      let text = "";
      const limit =
        active.request.targetKind === "heading"
          ? AI_LIMITS.headingOutput
          : AI_LIMITS.paragraphOutput;
      while (this.current(active)) {
        const fragment = await iterator.next();
        if (!this.current(active)) return { reason: "cancelled", text: "" };
        if (fragment.done) break;
        if (
          typeof fragment.value !== "string" ||
          text.length + fragment.value.length > limit * 2
        )
          return { reason: "no-suggestion", text: "" };
        text += fragment.value;
      }
      const normalized = normalizeSuggestion(text, active.request.targetKind);
      return normalized
        ? { reason: "ready", text: normalized }
        : { reason: "no-suggestion", text: "" };
    } catch (error) {
      if (!this.current(active)) return { reason: "cancelled", text: "" };
      const reason = classifyAiError(error);
      if (reason === "failed")
        this.autoCooldownUntil = this.now() + AI_LIMITS.cooldownMs;
      if (reason === "blocked")
        this.blockedUntil = this.now() + AI_LIMITS.windowMs;
      if (reason === "no-model" || reason === "needs-authorization")
        this.model = undefined;
      return { reason, text: "" };
    }
  }
  public dispose(): void {
    this.disposed = true;
    this.cancelActive("cancelled");
    this.model = undefined;
    this.sessions.clear();
    this.starts = [];
    for (const subscription of this.subscriptions.splice(0))
      subscription.dispose();
  }
}

export function classifyAiError(error: unknown): AiSuggestionReason {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code.toLowerCase().replace(/[^a-z]/g, "")
      : "";
  if (code === "nopermissions") return "needs-authorization";
  if (code === "notfound") return "no-model";
  if (code === "blocked") return "blocked";
  return "failed";
}

/** Runtime probes keep the existing ^1.90 engine compatible. */
export function createAiSuggestionsEnvironment(
  context: vscode.ExtensionContext,
): AiSuggestionsEnvironment {
  const access = context.languageModelAccessInformation;
  return {
    supported: () =>
      typeof vscode.lm?.selectChatModels === "function" &&
      typeof vscode.LanguageModelChatMessage?.User === "function" &&
      typeof vscode.CancellationTokenSource === "function",
    trusted: () => vscode.workspace.isTrusted === true,
    settings: () => {
      const config = vscode.workspace.getConfiguration(
        "markdownMint.aiSuggestions",
      );
      const auto =
        typeof config.inspect === "function"
          ? config.inspect<boolean>("autoTrigger")
          : undefined;
      const model =
        typeof config.inspect === "function"
          ? config.inspect<string>("model")
          : undefined;
      // Only the user's application configuration is a sending preference.
      const value = model?.globalValue ?? model?.defaultValue ?? "";
      return {
        autoTrigger: (auto?.globalValue ?? auto?.defaultValue) === true,
        model: typeof value === "string" && value.length <= 512 ? value : "",
      };
    },
    saveModel: (id) =>
      vscode.workspace
        .getConfiguration("markdownMint.aiSuggestions")
        .update("model", id, vscode.ConfigurationTarget.Global),
    models: () => vscode.lm.selectChatModels({ vendor: "copilot" }),
    access: (model) =>
      typeof access?.canSendRequest === "function"
        ? access.canSendRequest(model as vscode.LanguageModelChat)
        : undefined,
    choose: async (models) => {
      if (models.length === 0) return undefined;
      const selected = await vscode.window.showQuickPick(
        models.map((model) => ({
          label: model.name,
          description: model.id,
          model,
        })),
        {
          title: "Markdown Mint: Select Suggestion Model",
          placeHolder: "Choose a Copilot model for prose continuations",
        },
      );
      return selected?.model;
    },
    explain: async () =>
      (await vscode.window.showInformationMessage(
        "Markdown Mint sends bounded text around the current document's cursor to your selected Copilot chat model. Requests may consume Copilot usage. No Mint API key or server is required.",
        { modal: true },
        "Continue",
      )) === "Continue",
    notify: (reason) => {
      const message = reasonText[reason];
      if (message) void vscode.window.showInformationMessage(message);
    },
    user: (text) => vscode.LanguageModelChatMessage.User(text),
    tokenSource: () => new vscode.CancellationTokenSource(),
    ...(typeof access?.onDidChange === "function"
      ? {
          onAccessChanged: (listener: () => void) =>
            access.onDidChange(listener),
        }
      : {}),
    ...(typeof vscode.lm?.onDidChangeChatModels === "function"
      ? {
          onModelsChanged: (listener: () => void) =>
            vscode.lm.onDidChangeChatModels(listener),
        }
      : {}),
  };
}
