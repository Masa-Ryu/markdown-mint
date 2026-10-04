import * as vscode from "vscode";
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

export interface LanguageModelSelection {
  readonly model: vscode.LanguageModelChat;
  readonly identity: string;
  readonly displayName: string;
  readonly reason: string;
}

export interface LanguageModelResult {
  readonly text?: string;
  readonly failure?: LanguageModelFailure;
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
  readonly modelMessage?: (content: string) => vscode.LanguageModelChatMessage;
}

/** Public VS Code Language Model API adapter; no network or SDK fallback exists. */
export class LanguageModelSuggestions implements vscode.Disposable {
  private selection: LanguageModelSelection | undefined;
  private disposed = false;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: LanguageModelSuggestionsOptions) {
    const modelChange = options.api?.onDidChangeChatModels;
    if (modelChange)
      this.subscriptions.push(
        modelChange(() => {
          if (
            this.selection &&
            options.access?.canSendRequest(this.selection.model) === true
          )
            return;
          this.selection = undefined;
          this.emitChange();
        }),
      );
    const accessChange = options.access?.onDidChange;
    if (accessChange)
      this.subscriptions.push(
        accessChange(() => {
          if (
            this.selection &&
            options.access?.canSendRequest(this.selection.model) === true
          )
            return;
          this.selection = undefined;
          this.emitChange();
        }),
      );
  }

  public onDidChange(listener: () => void): vscode.Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** Called only from the explicit Suggest Continuation user command. */
  public async selectForUserAction(): Promise<
    LanguageModelFailure | undefined
  > {
    if (this.disposed) return "cancelled";
    const { api, access } = this.options;
    if (!api || !access) return "failed";
    try {
      const models = await api.selectChatModels({ vendor: "copilot" });
      if (this.disposed) return "cancelled";
      const selected = chooseCompletionModel(models);
      if (!selected) {
        this.selection = undefined;
        return "no-model";
      }
      const permission = access.canSendRequest(selected.model);
      if (permission !== true) {
        this.selection = undefined;
        return "needs-authorization";
      }
      this.selection = selected;
      return undefined;
    } catch (error) {
      this.selection = undefined;
      return classifyLanguageModelError(error);
    }
  }

  /** Rechecks an in-memory model. It never selects models or opens consent UI. */
  public restoreAccess(): LanguageModelFailure | undefined {
    if (this.disposed) return "cancelled";
    if (!this.options.api || !this.options.access) return "failed";
    if (!this.selection) return "needs-authorization";
    const access = this.options.access.canSendRequest(this.selection.model);
    return access === true ? undefined : "needs-authorization";
  }

  public get currentSelection(): LanguageModelSelection | undefined {
    return this.selection;
  }

  public async complete(
    markdown: string,
    position: number,
    targetKind: "paragraph" | "heading",
    token: vscode.CancellationToken,
  ): Promise<LanguageModelResult> {
    const selection = this.selection;
    const model = selection?.model;
    const access = this.options.access;
    if (!model || !access) return { failure: "needs-authorization" };
    if (access.canSendRequest(model) !== true)
      return { failure: "needs-authorization" };
    const context = buildCompletionContext(markdown, position, targetKind);
    if (!context) return { failure: "invalid-context" };
    try {
      const prompt = await fitCompletionPrompt(model, context, token);
      if (token.isCancellationRequested) return { failure: "cancelled" };
      if (!prompt) return { failure: "invalid-context" };
      if (this.selection !== selection || access.canSendRequest(model) !== true)
        return { failure: "needs-authorization" };
      // Only a User message is available. The prompt grants no tools or other
      // capabilities and contains only the active host-owned document snapshot.
      const message =
        this.options.modelMessage?.(prompt.content) ??
        vscode.LanguageModelChatMessage.User(prompt.content);
      const response = await model.sendRequest([message], {}, token);
      let text = "";
      for await (const chunk of response.text) {
        if (token.isCancellationRequested) return { failure: "cancelled" };
        text += chunk;
        if (text.length > 32_768) return { failure: "unsafe-suggestion" };
      }
      if (token.isCancellationRequested || this.selection !== selection)
        return { failure: "cancelled" };
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
    this.listeners.clear();
    for (const subscription of this.subscriptions.splice(0))
      subscription.dispose();
  }

  private emitChange(): void {
    for (const listener of this.listeners) listener();
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
  }
  return "failed";
}
