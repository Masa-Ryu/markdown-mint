import * as vscode from "vscode";
import type { AiTargetKind } from "../shared/aiSuggestions";
import {
  buildCompletionContext,
  fitCompletionPrompt,
  parseCompletionResponse,
} from "./aiSuggestionPrompt";

export type LanguageModelFailure =
  | "needs-authorization"
  | "no-model"
  | "blocked"
  | "failed"
  | "timeout"
  | "cancelled"
  | "no-suggestion"
  | "invalid-context"
  | "unsafe-suggestion";

export type LanguageModelChangeReason = "models" | "access";

export interface LanguageModelSelection {
  readonly model: vscode.LanguageModelChat;
  readonly identity: string;
  readonly displayName: string;
  readonly reason: string;
}

export interface SavedLanguageModelIdentity {
  readonly id: string;
  readonly version: string;
}

export type SelectionMembershipValidation =
  "available" | "missing" | "access-denied" | "stale";

export interface LanguageModelResult {
  readonly text?: string;
  readonly failure?: LanguageModelFailure;
}

export interface LanguageModelCompletionInput {
  /** Host-owned Markdown, or the bounded unsaved Mermaid dialog source. */
  readonly source: string;
  /** UTF-16 offset in source. */
  readonly position: number;
  readonly targetKind: AiTargetKind;
  /** Used only to verify a code block's Markdown info string. */
  readonly language?: string;
}

export interface LanguageModelApi {
  selectChatModels(
    selector: vscode.LanguageModelChatSelector,
  ): Promise<readonly vscode.LanguageModelChat[]>;
  onDidChangeChatModels?: vscode.Event<void>;
}

export interface LanguageModelAccess {
  canSendRequest(model: vscode.LanguageModelChat): boolean | undefined;
  readonly onDidChange?: vscode.Event<void>;
}

export interface LanguageModelSuggestionsOptions {
  readonly api?: LanguageModelApi;
  readonly access?: LanguageModelAccess;
  readonly savedModelIdentity?: () => SavedLanguageModelIdentity | undefined;
  readonly modelMessage?: (content: string) => vscode.LanguageModelChatMessage;
}

export type LanguageModelUserActionPurpose = "setup" | "suggestion";

const setupAuthorizationPrompt = "Reply with OK.";
const setupAuthorizationJustification =
  "Enable Copilot suggestions in Markdown Mint.";
const suggestionJustification =
  "Generate a short continuation from the active Markdown Mint editor surface.";

/** Public VS Code Language Model API adapter; no network or SDK fallback exists. */
export class LanguageModelSuggestions implements vscode.Disposable {
  private selection: LanguageModelSelection | undefined;
  private accessCandidate: LanguageModelSelection | undefined;
  private lastAccessAllowed: boolean | undefined;
  private selectionNeedsUserInitiatedRefresh = false;
  private modelListGeneration = 0;
  private selecting:
    | {
        readonly purpose: LanguageModelUserActionPurpose;
        readonly promise: Promise<LanguageModelFailure | undefined>;
      }
    | undefined;
  private disposed = false;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly listeners = new Set<
    (reason: LanguageModelChangeReason, accessAllowed?: boolean) => void
  >();

  constructor(private readonly options: LanguageModelSuggestionsOptions) {
    const modelChange = options.api?.onDidChangeChatModels;
    if (modelChange)
      this.subscriptions.push(
        modelChange(() => {
          // The event carries no model identity. Keep the previous selection
          // only as a reference; requests and adoption require a user-initiated
          // exact membership query after this point.
          this.modelListGeneration += 1;
          this.selectionNeedsUserInitiatedRefresh = true;
          this.emitChange("models");
        }),
      );
    const accessChange = options.access?.onDidChange;
    if (accessChange)
      this.subscriptions.push(
        accessChange(() => {
          const candidate = this.accessCandidate;
          if (!candidate) {
            this.emitChange("access");
            return;
          }
          const accessAllowed =
            options.access?.canSendRequest(candidate.model) === true;
          if (accessAllowed === this.lastAccessAllowed) return;
          this.lastAccessAllowed = accessAllowed;
          this.selection = accessAllowed ? candidate : undefined;
          this.emitChange("access", accessAllowed);
        }),
      );
  }

  public onDidChange(
    listener: (
      reason: LanguageModelChangeReason,
      accessAllowed?: boolean,
    ) => void,
  ): vscode.Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** Selects a model for an explicit toolbar setup or manual suggestion action. */
  public selectForUserAction(
    purpose: LanguageModelUserActionPurpose = "setup",
  ): Promise<LanguageModelFailure | undefined> {
    if (this.disposed) return Promise.resolve("cancelled");
    if (this.selecting) {
      return this.selecting.purpose === purpose
        ? this.selecting.promise
        : Promise.resolve("cancelled");
    }
    const selecting = this.selectModelForUserAction(purpose);
    this.selecting = { purpose, promise: selecting };
    void selecting.then(
      () => {
        if (this.selecting?.promise === selecting) this.selecting = undefined;
      },
      () => {
        if (this.selecting?.promise === selecting) this.selecting = undefined;
      },
    );
    return selecting;
  }

  private async selectModelForUserAction(
    purpose: LanguageModelUserActionPurpose,
  ): Promise<LanguageModelFailure | undefined> {
    if (this.disposed) return "cancelled";
    const { api, access } = this.options;
    if (!api || !access) return "failed";
    const priorSelection = this.selection;
    if (
      this.selectionNeedsUserInitiatedRefresh &&
      priorSelection &&
      access.canSendRequest(priorSelection.model) === true
    ) {
      const membership =
        await this.validateSelectionForAdoption(priorSelection);
      if (membership === "available") return undefined;
      if (membership === "stale") return "cancelled";
    }
    try {
      const generation = this.modelListGeneration;
      const models = await api.selectChatModels({ vendor: "copilot" });
      if (this.disposed || generation !== this.modelListGeneration)
        return "cancelled";
      const selected = chooseCompletionModel(models);
      if (!selected) {
        this.selection = undefined;
        this.accessCandidate = undefined;
        this.lastAccessAllowed = undefined;
        this.selectionNeedsUserInitiatedRefresh = false;
        return "no-model";
      }
      this.accessCandidate = selected;
      const permission = access.canSendRequest(selected.model);
      this.lastAccessAllowed = permission === true;
      this.selectionNeedsUserInitiatedRefresh = false;
      if (permission === true || purpose === "suggestion") {
        // An explicit manual suggestion may use its actual completion request
        // to start VS Code's first-use consent UI. Automatic requests still
        // require cached permission before they can reach complete().
        this.selection = selected;
        return undefined;
      }
      this.selection = undefined;
      return await this.requestSetupAuthorization(selected, generation);
    } catch (error) {
      this.selection = undefined;
      return classifyLanguageModelError(error);
    }
  }

  private async requestSetupAuthorization(
    selection: LanguageModelSelection,
    generation: number,
  ): Promise<LanguageModelFailure | undefined> {
    const access = this.options.access;
    if (!access) return "failed";
    try {
      const response = await selection.model.sendRequest(
        [
          this.options.modelMessage?.(setupAuthorizationPrompt) ??
            vscode.LanguageModelChatMessage.User(setupAuthorizationPrompt),
        ],
        { justification: setupAuthorizationJustification },
      );
      // Drain and discard the setup response. It is never a candidate and
      // contains no Markdown, path, workspace, or cursor context.
      for await (const _chunk of response.text) {
        if (this.disposed || generation !== this.modelListGeneration)
          return "cancelled";
      }
      if (
        this.disposed ||
        generation !== this.modelListGeneration ||
        this.accessCandidate !== selection
      )
        return "cancelled";
      if (access.canSendRequest(selection.model) !== true) {
        this.lastAccessAllowed = false;
        this.selection = undefined;
        return "needs-authorization";
      }
      this.lastAccessAllowed = true;
      this.selection = selection;
      return undefined;
    } catch (error) {
      this.selection = undefined;
      this.lastAccessAllowed = access.canSendRequest(selection.model) === true;
      return classifyLanguageModelError(error);
    }
  }

  /** Whether a real user input can safely check or restore a model selection. */
  public canRevalidateForUserInput(): boolean {
    if (this.disposed || !this.options.api || !this.options.access)
      return false;
    const knownSelection = this.selection ?? this.accessCandidate;
    if (knownSelection)
      return this.options.access.canSendRequest(knownSelection.model) === true;
    // A cold Extension Host has no model object to check yet. Reacquisition is
    // limited to the exact non-secret model identity saved after explicit
    // setup; auto work never enumerates a vendor's entire model list.
    return Boolean(
      this.options.savedModelIdentity?.() && this.lastAccessAllowed !== false,
    );
  }

  /** Checks cached permission or reacquires a previously authorized model. */
  public async revalidateForUserInput(): Promise<
    LanguageModelFailure | undefined
  > {
    if (this.disposed) return "cancelled";
    const access = this.options.access;
    if (!this.options.api || !access) return "failed";
    const selection = this.selection;
    if (selection && access.canSendRequest(selection.model) !== true)
      return "needs-authorization";
    if (!selection) {
      const candidate = this.accessCandidate;
      if (candidate && access.canSendRequest(candidate.model) !== true)
        return "needs-authorization";
      if (!this.canRevalidateForUserInput()) return "needs-authorization";
      const savedIdentity = this.options.savedModelIdentity?.();
      if (!savedIdentity) return "needs-authorization";
      return this.restoreSavedModel(savedIdentity);
    }
    if (!this.selectionNeedsUserInitiatedRefresh) return undefined;
    const result = await this.validateSelectionForAdoption(selection);
    return result === "available"
      ? undefined
      : result === "missing"
        ? "no-model"
        : result === "access-denied"
          ? "needs-authorization"
          : "cancelled";
  }

  private async restoreSavedModel(
    identity: SavedLanguageModelIdentity,
  ): Promise<LanguageModelFailure | undefined> {
    const { api, access } = this.options;
    if (!api || !access) return "failed";
    const generation = this.modelListGeneration;
    try {
      const models = await api.selectChatModels({
        vendor: "copilot",
        id: identity.id,
        version: identity.version,
      });
      if (this.disposed || generation !== this.modelListGeneration)
        return "cancelled";
      const model = models.find(
        (candidate) =>
          candidate.vendor === "copilot" &&
          candidate.id === identity.id &&
          candidate.version === identity.version,
      );
      if (!model) return "no-model";
      const selection = selectionForModel(
        model,
        "restored the previously selected Copilot model by exact identity",
      );
      this.accessCandidate = selection;
      const permission = access.canSendRequest(model);
      this.lastAccessAllowed = permission === true;
      this.selectionNeedsUserInitiatedRefresh = false;
      if (permission !== true) {
        this.selection = undefined;
        return "needs-authorization";
      }
      this.selection = selection;
      return undefined;
    } catch (error) {
      return classifyLanguageModelError(error);
    }
  }

  /** Rechecks an in-memory model. It never selects models or opens consent UI. */
  public restoreAccess(): LanguageModelFailure | undefined {
    if (this.disposed) return "cancelled";
    if (!this.options.api || !this.options.access) return "failed";
    if (!this.selection) return "needs-authorization";
    if (this.selectionNeedsUserInitiatedRefresh) return "needs-authorization";
    const access = this.options.access.canSendRequest(this.selection.model);
    return access === true ? undefined : "needs-authorization";
  }

  public get modelSelectionStale(): boolean {
    return this.selectionNeedsUserInitiatedRefresh;
  }

  /** Keeps a ready status visible without treating access as list membership. */
  public hasAuthorizedCachedSelection(): boolean {
    return (
      this.selection !== undefined &&
      this.options.access?.canSendRequest(this.selection.model) === true
    );
  }

  /** Called only from the user's Tab action when membership became unknown. */
  public async validateSelectionForAdoption(
    expected: LanguageModelSelection,
  ): Promise<SelectionMembershipValidation> {
    const { api, access } = this.options;
    if (this.disposed || !api || !access || this.selection !== expected)
      return "stale";
    if (access.canSendRequest(expected.model) !== true) return "access-denied";
    if (!this.selectionNeedsUserInitiatedRefresh) return "available";

    const generation = this.modelListGeneration;
    try {
      const models = await api.selectChatModels({
        vendor: "copilot",
        id: expected.model.id,
        version: expected.model.version,
      });
      if (
        this.disposed ||
        generation !== this.modelListGeneration ||
        this.selection !== expected
      )
        return "stale";
      const model = models.find(
        (candidate) =>
          candidate.vendor === "copilot" &&
          candidate.id === expected.model.id &&
          candidate.version === expected.model.version,
      );
      if (!model) {
        this.selection = undefined;
        return "missing";
      }
      if (access.canSendRequest(model) !== true) {
        this.selection = undefined;
        return "access-denied";
      }
      const refreshed: LanguageModelSelection = {
        ...expected,
        model,
      };
      this.selection = refreshed;
      this.accessCandidate = refreshed;
      this.lastAccessAllowed = true;
      this.selectionNeedsUserInitiatedRefresh = false;
      return "available";
    } catch {
      return "stale";
    }
  }

  public get currentSelection(): LanguageModelSelection | undefined {
    return this.selection;
  }

  public async complete(
    input: LanguageModelCompletionInput,
    token: vscode.CancellationToken,
    options: { readonly allowConsentPrompt?: boolean } = {},
  ): Promise<LanguageModelResult> {
    const allowConsentPrompt = options.allowConsentPrompt === true;
    const selection = this.selection;
    const model = selection?.model;
    const access = this.options.access;
    if (!model || !access) return { failure: "needs-authorization" };
    if (this.selectionNeedsUserInitiatedRefresh)
      return { failure: "needs-authorization" };
    if (!allowConsentPrompt && access.canSendRequest(model) !== true)
      return { failure: "needs-authorization" };
    const context = buildCompletionContext(
      input.source,
      input.position,
      input.targetKind,
      input.language,
    );
    if (!context) return { failure: "invalid-context" };
    try {
      const prompt = await fitCompletionPrompt(model, context, token);
      if (token.isCancellationRequested) return { failure: "cancelled" };
      if (!prompt) return { failure: "invalid-context" };
      if (
        this.selectionNeedsUserInitiatedRefresh ||
        this.selection !== selection ||
        (!allowConsentPrompt && access.canSendRequest(model) !== true)
      )
        return { failure: "needs-authorization" };
      // Only a User message is available. The prompt grants no tools or other
      // capabilities and contains only the active host-owned document snapshot.
      const message =
        this.options.modelMessage?.(prompt.content) ??
        vscode.LanguageModelChatMessage.User(prompt.content);
      const response = await model.sendRequest(
        [message],
        { justification: suggestionJustification },
        token,
      );
      let text = "";
      for await (const chunk of response.text) {
        if (token.isCancellationRequested) return { failure: "cancelled" };
        text += chunk;
        if (text.length > 32_768) return { failure: "unsafe-suggestion" };
      }
      if (
        token.isCancellationRequested ||
        this.selectionNeedsUserInitiatedRefresh ||
        this.selection !== selection
      )
        return { failure: "cancelled" };
      if (access.canSendRequest(model) !== true)
        return { failure: "needs-authorization" };
      const parsed = parseCompletionResponse(text);
      if (!parsed) return { failure: "unsafe-suggestion" };
      return parsed.insertText
        ? { text: parsed.insertText }
        : { failure: "no-suggestion" };
    } catch (error) {
      if (token.isCancellationRequested) return { failure: "cancelled" };
      return { failure: classifyLanguageModelError(error) };
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.selection = undefined;
    this.accessCandidate = undefined;
    this.lastAccessAllowed = undefined;
    this.listeners.clear();
    for (const subscription of this.subscriptions.splice(0))
      subscription.dispose();
  }

  private emitChange(
    reason: LanguageModelChangeReason,
    accessAllowed?: boolean,
  ): void {
    for (const listener of this.listeners) {
      if (accessAllowed === undefined) listener(reason);
      else listener(reason, accessAllowed);
    }
  }
}

export function chooseCompletionModel(
  models: readonly vscode.LanguageModelChat[],
): LanguageModelSelection | undefined {
  if (!models.length) return undefined;
  const copilot = models.filter((model) => model.vendor === "copilot");
  if (!copilot.length) return undefined;
  // VS Code recommends mini models for inline interactions. Verify the family
  // exists in the live model list and otherwise use a stable lexical fallback.
  const mini = copilot.filter((model) =>
    /(?:^|[-_.])mini(?:$|[-_.])/i.test(model.family),
  );
  const pool = mini.length ? mini : copilot;
  const model = [...pool].sort((left, right) =>
    left.id.localeCompare(right.id),
  )[0];
  if (!model) return undefined;
  return {
    model,
    identity: `${model.id}@${model.version}`,
    displayName: `${model.name} (${model.id}, ${model.version})`,
    reason: mini.length
      ? "selected an available Copilot mini family for inline response latency"
      : "selected the lexically stable available Copilot model because no mini family was listed",
  };
}

function selectionForModel(
  model: vscode.LanguageModelChat,
  reason: string,
): LanguageModelSelection {
  return {
    model,
    identity: `${model.id}@${model.version}`,
    displayName: `${model.name} (${model.id}, ${model.version})`,
    reason,
  };
}

export function createLanguageModelSuggestions(
  context: vscode.ExtensionContext,
): LanguageModelSuggestions {
  const apiHost = vscode as typeof vscode & { lm?: LanguageModelApi };
  const contextWithAccess = context as vscode.ExtensionContext & {
    languageModelAccessInformation?: LanguageModelAccess;
  };
  return new LanguageModelSuggestions({
    api: apiHost.lm,
    access: contextWithAccess.languageModelAccessInformation,
  });
}

export function classifyLanguageModelError(
  error: unknown,
): LanguageModelFailure {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code?: unknown }).code).toLowerCase();
    if (code.includes("blocked")) return "blocked";
    if (code.includes("nopermissions")) return "needs-authorization";
    if (code.includes("notfound")) return "no-model";
    if (code.includes("cancel")) return "cancelled";
  }
  return "failed";
}
