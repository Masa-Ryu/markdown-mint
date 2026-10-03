import { Plugin, PluginKey, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import {
  AI_LIMITS,
  isAiHostMessage,
  type AiHostMessage,
  type AiSuggestionRequest,
  type AiSuggestionResult,
  type AiSuggestionState,
  type AiTrigger,
  type AiWebviewMessage,
} from "../shared/aiSuggestions";
import {
  buildSuggestionContext,
  getSuggestionTarget,
  isSuggestionSnapshotCurrent,
  type AiSuggestionTarget,
} from "./aiSuggestionContext";

export const AI_ACCEPT_META = "markdown-mint-ai-accept";
interface Candidate {
  readonly target: AiSuggestionTarget;
  readonly text: string;
}
export const aiSuggestionsPluginKey = new PluginKey<Candidate | null>(
  "markdown-mint-ai-suggestions",
);
export function createAiSuggestionsPlugin(): Plugin<Candidate | null> {
  return new Plugin<Candidate | null>({
    key: aiSuggestionsPluginKey,
    state: {
      init: () => null,
      apply: (tr, previous, oldState, newState) => {
        const meta = tr.getMeta(aiSuggestionsPluginKey) as
          Candidate | null | undefined;
        if (meta !== undefined) return meta;
        if (
          tr.docChanged ||
          tr.storedMarksSet ||
          !oldState.selection.eq(newState.selection)
        )
          return null;
        return previous;
      },
    },
    props: {
      decorations: (state) => {
        const candidate = aiSuggestionsPluginKey.getState(state);
        if (!candidate || !isSuggestionSnapshotCurrent(state, candidate.target))
          return null;
        return DecorationSet.create(state.doc, [
          Decoration.widget(
            candidate.target.position,
            () => {
              const span = document.createElement("span");
              span.className = "mm-ai-suggestion";
              span.setAttribute("contenteditable", "false");
              span.setAttribute("aria-hidden", "true");
              span.textContent = candidate.text;
              return span;
            },
            { side: 1, ignoreSelection: true, stopEvent: () => true },
          ),
        ]);
      },
    },
  });
}

export interface AiSuggestionsControllerOptions {
  view(): EditorView;
  canSuggest(): boolean;
  synced(): boolean;
  version(): number;
  documentId(): string | undefined;
  post(message: AiWebviewMessage): void;
  dispatch(transaction: Transaction): boolean;
}
interface Snapshot {
  readonly request: AiSuggestionRequest;
  readonly target: AiSuggestionTarget;
}
interface Waiting {
  readonly revision: number;
  readonly trigger: AiTrigger;
  readonly invocationId?: string;
}

/** Owns only transient UI state. Ordinary accepted edits use the app's sync path. */
export class AiSuggestionsController {
  public readonly plugin = createAiSuggestionsPlugin();
  private state: AiSuggestionState | undefined;
  private revision = 0;
  private sequence = 0;
  private pending: Snapshot | undefined;
  private candidate: Snapshot | undefined;
  private waiting: Waiting | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inputTimer: ReturnType<typeof setTimeout> | undefined;
  private manualTimer: ReturnType<typeof setTimeout> | undefined;
  private inputIntent = false;
  private composing = false;
  private compositionDirty = false;
  private compositionEndedAt = -Infinity;
  private disposed = false;
  private live: HTMLElement | undefined;
  private readonly cleanup: Array<() => void> = [];
  constructor(private readonly options: AiSuggestionsControllerOptions) {}

  public attach(root: HTMLElement): void {
    const view = this.options.view();
    const live = root.ownerDocument.createElement("span");
    live.className = "mm-ai-announcement";
    live.setAttribute("role", "status");
    live.setAttribute("aria-live", "polite");
    live.setAttribute("aria-atomic", "true");
    root.append(live);
    this.live = live;
    const listen = (
      target: EventTarget,
      type: string,
      listener: EventListener,
      capture = false,
    ): void => {
      target.addEventListener(type, listener, capture);
      this.cleanup.push(() =>
        target.removeEventListener(type, listener, capture),
      );
    };
    listen(
      view.dom,
      "keydown",
      (event) => this.keyDown(event as KeyboardEvent),
      true,
    );
    listen(
      view.dom,
      "beforeinput",
      (event) => {
        const input = event as InputEvent;
        this.invalidate();
        this.inputIntent =
          input.inputType === "insertText" ||
          input.inputType === "insertCompositionText";
        if (this.inputTimer !== undefined) clearTimeout(this.inputTimer);
        this.inputTimer = setTimeout(() => {
          this.inputIntent = false;
          this.inputTimer = undefined;
        }, 0);
      },
      true,
    );
    listen(
      view.dom,
      "compositionstart",
      () => {
        this.invalidate();
        this.composing = true;
        this.compositionDirty = false;
      },
      true,
    );
    listen(view.dom, "compositionend", () => {
      this.composing = false;
      this.compositionEndedAt = Date.now();
      this.invalidate();
      if (this.compositionDirty) this.scheduleAuto();
      this.compositionDirty = false;
    });
    listen(
      view.dom,
      "paste",
      () => {
        this.inputIntent = false;
        this.invalidate();
      },
      true,
    );
    listen(
      view.dom,
      "drop",
      () => {
        this.inputIntent = false;
        this.invalidate();
      },
      true,
    );
    listen(view.dom, "blur", () => this.invalidate(), true);
    listen(root.ownerDocument, "pointerdown", () => this.invalidate(), true);
    listen(root.ownerDocument, "focusin", () => {
      if (!this.options.canSuggest()) this.invalidate();
    });
    listen(root.ownerDocument, "visibilitychange", () => {
      if (root.ownerDocument.hidden) this.invalidate();
    });
    if (root.ownerDocument.defaultView)
      listen(root.ownerDocument.defaultView, "blur", () => this.invalidate());
  }
  public transactionApplied(
    docChanged: boolean,
    selectionChanged: boolean,
    marksChanged: boolean,
  ): void {
    if (this.disposed || (!docChanged && !selectionChanged && !marksChanged))
      return;
    const ordinaryInput = docChanged && this.inputIntent;
    this.inputIntent = false;
    if (docChanged && this.composing) this.compositionDirty = true;
    this.invalidate();
    if (ordinaryInput && !this.composing) this.scheduleAuto();
  }
  private scheduleAuto(): void {
    if (
      !this.state?.autoTrigger ||
      (this.state.availability !== "ready" &&
        this.state.availability !== "blocked") ||
      this.disposed
    )
      return;
    const revision = this.revision;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (revision === this.revision)
        this.request({ revision, trigger: "auto" });
    }, AI_LIMITS.debounceMs);
  }
  private clearDecoration(): void {
    if (
      this.options.view() &&
      aiSuggestionsPluginKey.getState(this.options.view().state)
    ) {
      this.options.dispatch(
        this.options.view().state.tr.setMeta(aiSuggestionsPluginKey, null),
      );
    }
    if (this.live) this.live.textContent = "";
  }
  public invalidate(): void {
    if (this.disposed) return;
    this.revision += 1;
    if (this.timer !== undefined) clearTimeout(this.timer);
    if (this.manualTimer !== undefined) clearTimeout(this.manualTimer);
    this.timer = undefined;
    this.manualTimer = undefined;
    this.waiting = undefined;
    const snapshot = this.pending ?? this.candidate;
    this.pending = undefined;
    this.candidate = undefined;
    if (snapshot)
      this.options.post({
        protocolVersion: 1,
        type: "ai-suggestion-cancel",
        requestId: snapshot.request.requestId,
        sessionId: snapshot.request.sessionId,
      });
    this.clearDecoration();
  }
  public syncChanged(): void {
    const waiting = this.waiting;
    if (waiting && waiting.revision === this.revision && this.options.synced())
      this.request(waiting);
  }
  public handleMessage(message: AiHostMessage): void {
    if (this.disposed || !isAiHostMessage(message)) return;
    if (message.type === "ai-suggestion-state") {
      if (
        this.state &&
        message.sessionId === this.state.sessionId &&
        message.settingsGeneration < this.state.settingsGeneration
      )
        return;
      const changed =
        this.state?.sessionId !== message.sessionId ||
        this.state?.settingsGeneration !== message.settingsGeneration;
      if (
        changed ||
        message.active === false ||
        (!message.autoTrigger &&
          (this.pending?.request.trigger === "auto" ||
            this.candidate?.request.trigger === "auto" ||
            this.waiting?.trigger === "auto" ||
            this.timer !== undefined)) ||
        (message.availability !== "ready" &&
          this.state?.availability !== message.availability &&
          this.candidate)
      )
        this.invalidate();
      this.state = message;
    } else if (message.type === "ai-suggestion-trigger") {
      if (
        !this.state ||
        message.sessionId !== this.state.sessionId ||
        message.settingsGeneration !== this.state.settingsGeneration
      )
        return;
      this.invalidate();
      this.options.view().focus();
      // Focus can update the DOM/PM selection after the palette or Quick Pick closes.
      this.manualTimer = setTimeout(() => {
        this.manualTimer = undefined;
        this.request({
          revision: this.revision,
          trigger: "manual",
          invocationId: message.invocationId,
        });
      }, 0);
    } else this.result(message);
  }
  private request(waiting: Waiting): void {
    const state = this.state;
    if (
      !state ||
      state.active === false ||
      this.disposed ||
      waiting.revision !== this.revision ||
      !this.options.canSuggest() ||
      this.composing ||
      (waiting.trigger === "auto" &&
        (!state.autoTrigger ||
          (state.availability !== "ready" && state.availability !== "blocked")))
    )
      return;
    if (!this.options.synced()) {
      this.waiting = waiting;
      return;
    }
    this.waiting = undefined;
    const view = this.options.view();
    const target = getSuggestionTarget(view.state);
    const documentId = this.options.documentId();
    const context = target && buildSuggestionContext(view.state, target);
    if (!target || !context || !documentId) return;
    const request: AiSuggestionRequest = {
      protocolVersion: 1,
      type: "ai-suggestion-request",
      requestId: `ai-${Date.now()}-${++this.sequence}`,
      sessionId: state.sessionId,
      documentId,
      baseVersion: this.options.version(),
      editorRevision: this.revision,
      settingsGeneration: state.settingsGeneration,
      position: target.position,
      targetKind: target.kind,
      context,
      trigger: waiting.trigger,
      ...(waiting.invocationId ? { invocationId: waiting.invocationId } : {}),
    };
    this.pending = { request, target };
    this.options.post(request);
  }
  private current(snapshot: Snapshot): boolean {
    const { request, target } = snapshot;
    return (
      !this.disposed &&
      this.options.canSuggest() &&
      !this.composing &&
      this.options.synced() &&
      request.sessionId === this.state?.sessionId &&
      this.state.active !== false &&
      request.settingsGeneration === this.state.settingsGeneration &&
      request.documentId === this.options.documentId() &&
      request.baseVersion === this.options.version() &&
      request.editorRevision === this.revision &&
      isSuggestionSnapshotCurrent(this.options.view().state, target)
    );
  }
  private result(message: AiSuggestionResult): void {
    const snapshot = this.pending;
    if (!snapshot || !this.current(snapshot)) return;
    const request = snapshot.request;
    for (const key of [
      "requestId",
      "sessionId",
      "documentId",
      "baseVersion",
      "editorRevision",
      "settingsGeneration",
      "position",
      "targetKind",
    ] as const) {
      if (message[key] !== request[key]) return;
    }
    this.pending = undefined;
    if (message.reason !== "ready") return;
    this.candidate = snapshot;
    this.options.dispatch(
      this.options.view().state.tr.setMeta(aiSuggestionsPluginKey, {
        target: snapshot.target,
        text: message.text,
      } satisfies Candidate),
    );
    if (this.live)
      this.live.textContent =
        "Suggestion available. Press Tab to accept or Escape to dismiss.";
  }
  private keyDown(event: KeyboardEvent): void {
    const view = this.options.view();
    if (
      event.isComposing ||
      event.keyCode === 229 ||
      this.composing ||
      view.composing ||
      Date.now() - this.compositionEndedAt < 50
    )
      return;
    if (
      !this.options.canSuggest() ||
      event.shiftKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    )
      return;
    let handled = false;
    if (event.key === "Tab" && this.candidate)
      handled = this.acceptSuggestion();
    else if (
      event.key === "Escape" &&
      (this.pending ||
        this.candidate ||
        this.waiting ||
        this.timer !== undefined)
    ) {
      this.invalidate();
      handled = true;
    } else if (
      !["Shift", "Control", "Meta", "Alt", "CapsLock"].includes(event.key)
    )
      this.invalidate();
    if (handled) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }
  public acceptSuggestion(): boolean {
    const snapshot = this.candidate;
    const view = this.options.view();
    const candidate = aiSuggestionsPluginKey.getState(view.state);
    if (!snapshot || !candidate || !this.current(snapshot)) {
      this.invalidate();
      return false;
    }
    const marks = (
      view.state.storedMarks ?? view.state.selection.$from.marks()
    ).filter((mark) => mark.type.name !== "link" && mark.type.name !== "code");
    const transaction = view.state.tr
      .replaceWith(
        snapshot.target.position,
        snapshot.target.position,
        view.state.schema.text(candidate.text, marks),
      )
      .setMeta(aiSuggestionsPluginKey, null)
      .setMeta(AI_ACCEPT_META, true)
      .scrollIntoView();
    this.invalidate();
    return this.options.dispatch(transaction);
  }
  public dispose(): void {
    if (this.disposed) return;
    this.invalidate();
    this.disposed = true;
    if (this.inputTimer !== undefined) clearTimeout(this.inputTimer);
    for (const cleanup of this.cleanup.splice(0)) cleanup();
    this.live?.remove();
    this.live = undefined;
    this.state = undefined;
  }
}
