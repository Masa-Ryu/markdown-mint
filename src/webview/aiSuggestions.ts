import { Fragment, Slice, type Node as PMNode } from "prosemirror-model";
import {
  Plugin,
  PluginKey,
  type EditorState,
  type Transaction,
} from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import {
  matchCompletionInput,
  planCompletionInsertion,
  type CompletionInsertionPlan,
} from "../core/inlineCompletion";
import {
  AI_LIMITS,
  isAiHostMessage,
  type AiHostMessage,
  type AiSuggestionAdoptionCheck,
  type AiSuggestionAdoptionValidation,
  type AiSuggestionRequest,
  type AiSuggestionResult,
  type AiSuggestionState,
  type AiTrigger,
  type AiWebviewMessage,
} from "../shared/aiSuggestions";
import {
  getSuggestionTarget,
  isSuggestionSnapshotCurrent,
  type AiSuggestionTarget,
} from "./aiSuggestionContext";

export const AI_ACCEPT_META = "markdown-mint-ai-accept";
interface CandidateDecoration {
  readonly target: AiSuggestionTarget;
  readonly text: string;
}
interface Snapshot {
  readonly request: AiSuggestionRequest;
  readonly target: AiSuggestionTarget;
  readonly markdown: string;
  readonly profile: "commonmark" | "github" | "gitlab";
}
interface LiveCandidate {
  readonly snapshot: Snapshot;
  readonly remaining: string;
  readonly plan: CompletionInsertionPlan;
}
interface Waiting {
  readonly revision: number;
  readonly trigger: AiTrigger;
  readonly afterUserInput?: boolean;
  readonly invocationId?: string;
}
interface PendingAdoption {
  readonly check: AiSuggestionAdoptionCheck;
  readonly candidate: LiveCandidate;
  readonly timer: ReturnType<typeof setTimeout>;
}

export const aiSuggestionsPluginKey = new PluginKey<CandidateDecoration | null>(
  "markdown-mint-ai-suggestions",
);
export function createAiSuggestionsPlugin(): Plugin<CandidateDecoration | null> {
  return new Plugin<CandidateDecoration | null>({
    key: aiSuggestionsPluginKey,
    state: {
      init: () => null,
      apply: (transaction, previous, oldState, newState) => {
        const meta = transaction.getMeta(aiSuggestionsPluginKey) as
          CandidateDecoration | null | undefined;
        if (meta !== undefined) return meta;
        if (
          transaction.docChanged ||
          transaction.storedMarksSet ||
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
  markdown(): string;
  profile(): "commonmark" | "github" | "gitlab";
  sourceOffset(state: EditorState, position: number): number | undefined;
  post(message: AiWebviewMessage): void;
  dispatch(transaction: Transaction): boolean;
  parseMarkdown(
    source: string,
    profile: "commonmark" | "github" | "gitlab",
  ): { doc: PMNode };
}

/** Transient candidates never enter the document until a normal PM transaction accepts them. */
export class AiSuggestionsController {
  public readonly plugin = createAiSuggestionsPlugin();
  private state: AiSuggestionState | undefined;
  private revision = 0;
  private sequence = 0;
  private adoptionSequence = 0;
  private pending: Snapshot | undefined;
  private pendingSelectionWait = false;
  private candidate: LiveCandidate | undefined;
  private adoptionValidation: PendingAdoption | undefined;
  private waiting: Waiting | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pendingTimer: ReturnType<typeof setTimeout> | undefined;
  private inputTimer: ReturnType<typeof setTimeout> | undefined;
  private manualTimer: ReturnType<typeof setTimeout> | undefined;
  private waitTimer: ReturnType<typeof setTimeout> | undefined;
  private inputData: string | undefined;
  private inputIntent = false;
  private inputCanKeepCandidate = false;
  private composing = false;
  private compositionDoc: PMNode | undefined;
  private compositionPosition: number | undefined;
  private compositionDirty = false;
  private compositionEndedAt = -Infinity;
  private autoWaitingRevision: number | undefined;
  private suppressedKey: string | undefined;
  private disposed = false;
  private live: HTMLElement | undefined;
  private visibleStatus: HTMLElement | undefined;
  private readonly cleanup: Array<() => void> = [];

  constructor(private readonly options: AiSuggestionsControllerOptions) {}

  public attach(root: HTMLElement): void {
    const view = this.options.view();
    const live = root.ownerDocument.createElement("span");
    live.className = "mm-ai-announcement";
    live.setAttribute("role", "status");
    live.setAttribute("aria-live", "polite");
    live.setAttribute("aria-atomic", "true");
    const visibleStatus = root.ownerDocument.createElement("div");
    visibleStatus.className = "mm-ai-status";
    visibleStatus.hidden = true;
    root.append(live, visibleStatus);
    this.live = live;
    this.visibleStatus = visibleStatus;
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
        this.inputIntent = isSuggestionInputType(input.inputType);
        this.inputCanKeepCandidate = isTextInsertionInputType(input.inputType);
        this.inputData =
          this.inputCanKeepCandidate && typeof input.data === "string"
            ? input.data
            : undefined;
        this.cancelPending();
        if (this.inputTimer !== undefined) clearTimeout(this.inputTimer);
        this.inputTimer = setTimeout(() => {
          this.inputIntent = false;
          this.inputCanKeepCandidate = false;
          this.inputData = undefined;
          this.inputTimer = undefined;
        }, 0);
      },
      true,
    );
    listen(
      view.dom,
      "compositionstart",
      () => {
        this.cancelPending();
        this.composing = true;
        this.compositionDirty = false;
        this.compositionDoc = view.state.doc;
        this.compositionPosition = view.state.selection.from;
      },
      true,
    );
    listen(view.dom, "compositionend", () => {
      this.composing = false;
      this.compositionEndedAt = Date.now();
      const afterUserInput = this.compositionDirty;
      const candidatePreserved = this.compositionDirty
        ? this.finishCompositionInput()
        : false;
      if (!candidatePreserved) this.scheduleAuto(afterUserInput);
      this.compositionDirty = false;
      this.compositionDoc = undefined;
      this.compositionPosition = undefined;
    });
    for (const type of ["paste", "drop"])
      listen(
        view.dom,
        type,
        () => {
          this.inputIntent = false;
          this.inputCanKeepCandidate = false;
          this.inputData = undefined;
          this.invalidate();
        },
        true,
      );
    listen(view.dom, "blur", () => this.invalidateUnlessSelectingModel(), true);
    listen(root.ownerDocument, "pointerdown", () => this.invalidate(), true);
    listen(root.ownerDocument, "focusin", () => {
      if (!this.options.canSuggest()) this.invalidateUnlessSelectingModel();
    });
    listen(root.ownerDocument, "visibilitychange", () => {
      if (root.ownerDocument.hidden) this.invalidate();
    });
    if (root.ownerDocument.defaultView)
      listen(root.ownerDocument.defaultView, "blur", () =>
        this.invalidateUnlessSelectingModel(),
      );
  }

  public transactionApplied(
    docChanged: boolean,
    selectionChanged: boolean,
    marksChanged: boolean,
  ): void {
    if (this.disposed || (!docChanged && !selectionChanged && !marksChanged))
      return;
    this.cancelAdoptionValidation();
    if (docChanged && this.composing) {
      this.compositionDirty = true;
      this.inputIntent = false;
      this.inputCanKeepCandidate = false;
      this.inputData = undefined;
      return;
    }
    if (
      docChanged &&
      this.candidate &&
      this.inputIntent &&
      this.inputCanKeepCandidate &&
      this.keepMatchingInput(this.inputData)
    ) {
      this.inputIntent = false;
      this.inputCanKeepCandidate = false;
      this.inputData = undefined;
      return;
    }
    const ordinaryInput = docChanged && this.inputIntent;
    this.inputIntent = false;
    this.inputCanKeepCandidate = false;
    this.inputData = undefined;
    this.invalidate();
    if ((ordinaryInput || selectionChanged) && !this.composing)
      this.scheduleAuto(ordinaryInput);
  }

  private keepMatchingInput(input: string | undefined): boolean {
    const candidate = this.candidate;
    if (!candidate) return false;
    const view = this.options.view();
    const oldDoc = candidate.snapshot.target.doc;
    const oldPosition = candidate.snapshot.target.position;
    const selection = view.state.selection;
    if (!selection.empty || selection.from < oldPosition) return false;
    const typed = view.state.doc.textBetween(
      oldPosition,
      selection.from,
      "",
      "\n",
    );
    const match = matchCompletionInput(candidate.remaining, typed);
    if (!match || (input && input !== typed)) return false;
    try {
      const marks = oldDoc.resolve(oldPosition).marks();
      const expected = oldDoc.replace(
        oldPosition,
        oldPosition,
        new Slice(Fragment.from(oldDoc.type.schema.text(typed, marks)), 0, 0),
      );
      if (!expected.eq(view.state.doc)) return false;
    } catch {
      return false;
    }
    const target = getSuggestionTarget(view.state);
    if (
      !target ||
      candidate.plan.slice.content.size !== candidate.remaining.length
    )
      return false;
    const remaining = match.remaining;
    if (!remaining) {
      this.clearCandidate(false);
      this.setLive("");
      return true;
    }
    const matchedSlice = new Slice(
      candidate.plan.slice.content.cut(0, typed.length),
      candidate.plan.slice.openStart,
      candidate.plan.slice.openEnd,
    );
    if (
      matchedSlice.content.textBetween(
        0,
        matchedSlice.content.size,
        "",
        "\n",
      ) !== typed
    )
      return false;
    const plan: CompletionInsertionPlan = {
      ...candidate.plan,
      insertion: remaining,
      slice: new Slice(
        candidate.plan.slice.content.cut(typed.length),
        candidate.plan.slice.openStart,
        candidate.plan.slice.openEnd,
      ),
    };
    const updated: LiveCandidate = {
      snapshot: {
        ...candidate.snapshot,
        target,
        markdown: this.options.markdown(),
        profile: this.options.profile(),
      },
      remaining,
      plan,
    };
    this.candidate = updated;
    this.updateDecoration(updated);
    return true;
  }

  private finishCompositionInput(): boolean {
    const candidate = this.candidate;
    const before = this.compositionDoc;
    const start = this.compositionPosition;
    const view = this.options.view();
    if (!before || start === undefined || view.state.selection.from < start) {
      if (candidate) this.invalidate();
      return false;
    }
    const typed = view.state.doc.textBetween(
      start,
      view.state.selection.from,
      "",
      "\n",
    );
    if (candidate && typed && this.keepMatchingInput(typed)) return true;
    if (candidate) this.invalidate();
    return false;
  }

  private scheduleAuto(afterUserInput = false): void {
    const state = this.state;
    if (!state?.autoTrigger || this.disposed || this.composing) return;
    const canRestoreAfterInput =
      state.availability === "needs-authorization" &&
      state.autoRestoreOnInput === true &&
      afterUserInput;
    if (state.availability !== "ready" && !canRestoreAfterInput) {
      this.autoWaitingRevision =
        state.availability === "needs-authorization"
          ? undefined
          : this.revision;
      return;
    }
    this.autoWaitingRevision = undefined;
    const target = getSuggestionTarget(this.options.view().state);
    const key = `${this.options.documentId() ?? ""}:${this.options.version()}:${target?.position ?? -1}`;
    if (this.suppressedKey === key) return;
    const revision = this.revision;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (revision === this.revision)
        this.request({
          revision,
          trigger: "auto",
          ...(afterUserInput ? { afterUserInput: true } : {}),
        });
    }, AI_LIMITS.debounceMs);
  }

  private clearDecoration(): void {
    const view = this.options.view();
    if (view && aiSuggestionsPluginKey.getState(view.state))
      this.options.dispatch(
        view.state.tr.setMeta(aiSuggestionsPluginKey, null),
      );
    this.setLive("");
  }
  private sendCancel(snapshot: Snapshot | undefined): void {
    if (snapshot)
      this.options.post({
        protocolVersion: 1,
        type: "ai-suggestion-cancel",
        requestId: snapshot.request.requestId,
        sessionId: snapshot.request.sessionId,
      });
  }
  private cancelPending(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    if (this.waitTimer !== undefined) clearTimeout(this.waitTimer);
    this.timer = undefined;
    this.waitTimer = undefined;
    this.waiting = undefined;
    const pending = this.pending;
    this.pending = undefined;
    if (this.pendingTimer !== undefined) clearTimeout(this.pendingTimer);
    this.pendingTimer = undefined;
    this.pendingSelectionWait = false;
    this.sendCancel(pending);
  }
  private clearCandidate(sendRejection: boolean): void {
    const candidate = this.candidate;
    this.candidate = undefined;
    void sendRejection;
    this.sendCancel(candidate?.snapshot);
    this.clearDecoration();
  }
  public invalidate(): void {
    if (this.disposed) return;
    this.revision += 1;
    this.autoWaitingRevision = undefined;
    this.cancelAdoptionValidation();
    this.cancelPending();
    this.clearCandidate(true);
  }
  public syncChanged(): void {
    const waiting = this.waiting;
    if (
      waiting &&
      waiting.revision === this.revision &&
      this.options.synced()
    ) {
      if (this.waitTimer !== undefined) clearTimeout(this.waitTimer);
      this.waitTimer = undefined;
      this.request(waiting);
    }
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
      const previousState = this.state;
      const changed =
        this.state?.sessionId !== message.sessionId ||
        this.state?.settingsGeneration !== message.settingsGeneration ||
        this.state?.autoRestoreOnInput !== message.autoRestoreOnInput;
      const manualWork =
        this.waiting?.trigger === "manual" ||
        this.pending?.request.trigger === "manual" ||
        this.candidate?.snapshot.request.trigger === "manual";
      const automaticWork =
        this.timer !== undefined ||
        this.waiting?.trigger === "auto" ||
        this.pending?.request.trigger === "auto" ||
        this.candidate?.snapshot.request.trigger === "auto";
      const restoringAfterInput =
        this.pending?.request.trigger === "auto" &&
        this.pending.request.afterUserInput === true &&
        message.autoRestoreOnInput === true &&
        (message.availability === "needs-authorization" ||
          message.availability === "preparing" ||
          message.availability === "ready");
      if (
        changed ||
        message.active === false ||
        (!message.autoTrigger && automaticWork) ||
        (message.availability !== "ready" &&
          this.state?.availability !== message.availability &&
          (this.waiting || this.pending || this.candidate) &&
          !(
            message.availability === "disabled" &&
            !message.autoTrigger &&
            manualWork
          ) &&
          !restoringAfterInput)
      )
        this.invalidate();
      if (!message.autoTrigger) this.autoWaitingRevision = undefined;
      this.state = message;
      if (
        previousState?.availability !== "ready" &&
        message.availability === "ready" &&
        message.autoTrigger &&
        this.autoWaitingRevision === this.revision
      ) {
        this.autoWaitingRevision = undefined;
        this.scheduleAuto();
      }
      if (restoringAfterInput && message.availability === "preparing") {
        this.suspendPendingDeadline();
      } else if (
        restoringAfterInput &&
        message.availability === "ready" &&
        this.pendingSelectionWait &&
        this.pending
      ) {
        this.pendingSelectionWait = false;
        this.startPendingDeadline(this.pending);
      } else if (!restoringAfterInput) {
        this.pendingSelectionWait = false;
      }
      return;
    }
    if (message.type === "ai-suggestion-adoption-validation") {
      this.finishAdoptionValidation(message);
      return;
    }
    if (message.type === "ai-suggestion-snapshot-check") {
      const snapshot = this.pending;
      const current = Boolean(
        snapshot &&
        snapshot.request.requestId === message.requestId &&
        snapshot.request.sessionId === message.sessionId &&
        this.current(snapshot),
      );
      this.options.post({
        protocolVersion: 1,
        type: "ai-suggestion-snapshot-validation",
        requestId: message.requestId,
        sessionId: message.sessionId,
        current,
      });
      return;
    }
    if (message.type === "ai-suggestion-trigger") {
      if (
        !this.state ||
        message.sessionId !== this.state.sessionId ||
        message.settingsGeneration !== this.state.settingsGeneration
      )
        return;
      this.invalidate();
      this.options.view().focus();
      this.manualTimer = setTimeout(() => {
        this.manualTimer = undefined;
        this.request({
          revision: this.revision,
          trigger: "manual",
          invocationId: message.invocationId,
        });
      }, 0);
      return;
    }
    this.result(message);
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
          (state.availability !== "ready" &&
            !(
              waiting.afterUserInput === true &&
              state.autoRestoreOnInput === true &&
              state.availability === "needs-authorization"
            ))))
    )
      return;
    if (!this.options.synced()) {
      this.waiting = waiting;
      if (this.waitTimer !== undefined) clearTimeout(this.waitTimer);
      this.waitTimer = setTimeout(() => {
        this.waitTimer = undefined;
        if (this.waiting === waiting) {
          this.waiting = undefined;
          if (waiting.trigger === "manual")
            this.setLive(
              "Suggestion was not sent because document synchronization is still pending.",
            );
        }
      }, 4_000);
      return;
    }
    this.waiting = undefined;
    const view = this.options.view();
    const target = getSuggestionTarget(view.state);
    const documentId = this.options.documentId();
    const markdown = this.options.markdown();
    const position =
      target && this.options.sourceOffset(view.state, target.position);
    if (!target || position === undefined || !documentId) {
      if (waiting.trigger === "manual")
        this.setLive(
          "Place the cursor in supported Markdown prose, a heading, or a list item to request a suggestion.",
        );
      return;
    }
    const request: AiSuggestionRequest = {
      protocolVersion: 1,
      type: "ai-suggestion-request",
      requestId: `ai-${Date.now()}-${++this.sequence}`,
      sessionId: state.sessionId,
      documentId,
      baseVersion: this.options.version(),
      editorRevision: this.revision,
      settingsGeneration: state.settingsGeneration,
      position,
      targetKind: target.kind,
      trigger: waiting.trigger,
      ...(waiting.afterUserInput ? { afterUserInput: true } : {}),
      ...(waiting.invocationId ? { invocationId: waiting.invocationId } : {}),
    };
    const snapshot: Snapshot = {
      request,
      target,
      markdown,
      profile: this.options.profile(),
    };
    this.pending = snapshot;
    this.pendingSelectionWait = false;
    this.startPendingDeadline(snapshot);
    this.options.post(request);
  }

  private startPendingDeadline(snapshot: Snapshot): void {
    if (this.pendingTimer !== undefined) clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => {
      if (this.pending === snapshot) {
        this.pending = undefined;
        this.pendingSelectionWait = false;
        this.sendCancel(snapshot);
        if (snapshot.request.trigger === "manual")
          this.setLive("The Copilot suggestion request timed out.");
      }
      this.pendingTimer = undefined;
    }, AI_LIMITS.deadlineMs);
  }

  private suspendPendingDeadline(): void {
    if (this.pendingTimer !== undefined) clearTimeout(this.pendingTimer);
    this.pendingTimer = undefined;
    this.pendingSelectionWait = true;
  }

  private isSelectingModelForRestoration(): boolean {
    const request = this.pending?.request;
    return (
      request?.trigger === "auto" &&
      request.afterUserInput === true &&
      this.state?.autoRestoreOnInput === true &&
      (this.state.availability === "needs-authorization" ||
        this.state.availability === "preparing")
    );
  }

  private invalidateUnlessSelectingModel(): void {
    if (!this.isSelectingModelForRestoration()) this.invalidate();
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
      availabilityAllowsPendingWork(this.state, request) &&
      request.settingsGeneration === this.state.settingsGeneration &&
      request.documentId === this.options.documentId() &&
      request.baseVersion === this.options.version() &&
      request.editorRevision === this.revision &&
      isSuggestionSnapshotCurrent(this.options.view().state, target)
    );
  }

  private result(message: AiSuggestionResult): void {
    const snapshot = this.pending;
    if (!snapshot || message.requestId !== snapshot.request.requestId) return;
    this.pending = undefined;
    if (this.pendingTimer !== undefined) clearTimeout(this.pendingTimer);
    this.pendingTimer = undefined;
    this.pendingSelectionWait = false;
    for (const key of [
      "sessionId",
      "documentId",
      "baseVersion",
      "editorRevision",
      "settingsGeneration",
      "position",
      "targetKind",
    ] as const)
      if (message[key] !== snapshot.request[key]) return;
    if (!this.current(snapshot)) return;
    if (message.reason !== "ready") {
      if (snapshot.request.trigger === "manual")
        this.setLive(reasonText(message.reason));
      return;
    }
    const plan = planCompletionInsertion(
      snapshot.markdown,
      snapshot.target.doc,
      snapshot.request.position,
      snapshot.target.position,
      message.text,
      snapshot.profile,
      this.options,
    );
    if (!plan) {
      if (snapshot.request.trigger === "manual")
        this.setLive(reasonText("unsafe-suggestion"));
      return;
    }
    const candidate: LiveCandidate = {
      snapshot,
      remaining: message.text,
      plan,
    };
    this.candidate = candidate;
    this.updateDecoration(candidate);
    this.setLive(
      "Suggestion available. Press Tab to accept or Escape to dismiss.",
    );
  }

  private updateDecoration(candidate: LiveCandidate): void {
    this.options.dispatch(
      this.options.view().state.tr.setMeta(aiSuggestionsPluginKey, {
        target: candidate.snapshot.target,
        text: candidate.remaining,
      } satisfies CandidateDecoration),
    );
  }
  private setLive(text: string): void {
    if (this.live) this.live.textContent = text;
    if (this.visibleStatus) {
      this.visibleStatus.textContent = text;
      this.visibleStatus.title = text;
      this.visibleStatus.hidden = text.length === 0;
    }
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
      const target = getSuggestionTarget(view.state);
      this.suppressedKey = `${this.options.documentId() ?? ""}:${this.options.version()}:${target?.position ?? -1}`;
      this.invalidate();
      handled = true;
    } else if (
      !["Shift", "Control", "Meta", "Alt", "CapsLock"].includes(event.key)
    ) {
      this.suppressedKey = undefined;
    }
    if (handled) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }
  public acceptSuggestion(): boolean {
    const candidate = this.candidate;
    if (!candidate || !this.canAcceptCandidate(candidate)) {
      this.invalidate();
      return false;
    }
    if (this.state?.modelSelectionStale)
      return this.beginAdoptionValidation(candidate);
    return this.commitCandidate(candidate);
  }

  private canAcceptCandidate(candidate: LiveCandidate): boolean {
    const view = this.options.view();
    const target = candidate.snapshot.target;
    return Boolean(
      target &&
      this.options.canSuggest() &&
      this.state &&
      availabilityAllowsPendingWork(this.state, candidate.snapshot.request) &&
      view.state.selection.from === target.position &&
      view.state.selection.empty &&
      candidate.snapshot.request.documentId === this.options.documentId(),
    );
  }

  private beginAdoptionValidation(candidate: LiveCandidate): boolean {
    if (this.adoptionValidation) return true;
    const request = candidate.snapshot.request;
    const check: AiSuggestionAdoptionCheck = {
      protocolVersion: 1,
      type: "ai-suggestion-adoption-check",
      attemptId: `adopt-${Date.now()}-${++this.adoptionSequence}`,
      requestId: request.requestId,
      sessionId: request.sessionId,
      documentId: this.options.documentId() ?? request.documentId,
      baseVersion: this.options.version(),
      editorRevision: this.revision,
      settingsGeneration: request.settingsGeneration,
      position: request.position,
      targetKind: request.targetKind,
    };
    const pending: PendingAdoption = {
      check,
      candidate,
      timer: setTimeout(() => {
        if (this.adoptionValidation !== pending) return;
        this.adoptionValidation = undefined;
        this.clearCandidate(true);
        this.setLive(
          "The changed Copilot model could not be verified. Type again to request a new suggestion.",
        );
      }, AI_LIMITS.modelValidationDeadlineMs),
    };
    this.adoptionValidation = pending;
    this.setLive("Checking the selected Copilot model before accepting.");
    try {
      this.options.post(check);
    } catch {
      clearTimeout(pending.timer);
      this.adoptionValidation = undefined;
      this.clearCandidate(true);
      this.setLive("The selected Copilot model could not be verified.");
    }
    return true;
  }

  private finishAdoptionValidation(
    validation: AiSuggestionAdoptionValidation,
  ): void {
    const pending = this.adoptionValidation;
    if (
      !pending ||
      validation.attemptId !== pending.check.attemptId ||
      validation.requestId !== pending.check.requestId ||
      validation.sessionId !== pending.check.sessionId
    )
      return;
    clearTimeout(pending.timer);
    this.adoptionValidation = undefined;
    if (
      this.candidate !== pending.candidate ||
      !validation.available ||
      !this.canAcceptCandidate(pending.candidate)
    ) {
      if (this.candidate === pending.candidate) this.clearCandidate(true);
      this.setLive(
        "The model or suggestion changed. Type again to request a new suggestion.",
      );
      return;
    }
    if (this.state) this.state = { ...this.state, modelSelectionStale: false };
    this.commitCandidate(pending.candidate);
  }

  private cancelAdoptionValidation(): void {
    const pending = this.adoptionValidation;
    this.adoptionValidation = undefined;
    if (pending) clearTimeout(pending.timer);
  }

  private commitCandidate(candidate: LiveCandidate): boolean {
    const view = this.options.view();
    const target = candidate.snapshot.target;
    if (!this.canAcceptCandidate(candidate)) {
      this.invalidate();
      return false;
    }
    let transaction: Transaction;
    try {
      transaction = view.state.tr
        .replace(target.position, target.position, candidate.plan.slice)
        .setMeta(aiSuggestionsPluginKey, null)
        .setMeta(AI_ACCEPT_META, true)
        .scrollIntoView();
    } catch {
      this.invalidate();
      this.setLive("The suggestion no longer fits this Markdown position.");
      return false;
    }
    this.candidate = undefined;
    this.sendCancel(candidate.snapshot);
    this.revision += 1;
    const accepted = this.options.dispatch(transaction);
    if (accepted) {
      this.setLive("");
      return true;
    }
    return false;
  }
  public dispose(): void {
    if (this.disposed) return;
    this.invalidate();
    this.disposed = true;
    for (const timer of [
      this.inputTimer,
      this.manualTimer,
      this.waitTimer,
      this.pendingTimer,
    ])
      if (timer !== undefined) clearTimeout(timer);
    for (const cleanup of this.cleanup.splice(0)) cleanup();
    this.live?.remove();
    this.visibleStatus?.remove();
    this.live = undefined;
    this.visibleStatus = undefined;
    this.state = undefined;
  }
}

function availabilityAllowsPendingWork(
  state: AiSuggestionState,
  request: AiSuggestionRequest,
): boolean {
  return (
    state.availability === "ready" ||
    (state.availability === "disabled" && request.trigger === "manual") ||
    (request.trigger === "auto" &&
      request.afterUserInput === true &&
      state.autoRestoreOnInput === true &&
      (state.availability === "needs-authorization" ||
        state.availability === "preparing"))
  );
}

function reasonText(reason: string): string {
  switch (reason) {
    case "needs-authorization":
      return "Use Suggest Continuation to authorize Markdown Mint with the available language model.";
    case "unsupported":
      return "The VS Code Language Model API is not available in this extension host.";
    case "untrusted":
      return "Copilot suggestions require a trusted workspace.";
    case "no-model":
      return "No Copilot language model is currently available.";
    case "disabled":
      return "Automatic suggestions are off. Manual suggestions remain available.";
    case "unsafe-suggestion":
      return "The language model returned text that could not be safely inserted without changing existing Markdown.";
    case "no-suggestion":
      return "The language model did not return a suggestion at this position.";
    case "invalid-context":
      return "Place the cursor in supported Markdown prose, a heading, or a list item.";
    case "timeout":
      return "The Copilot suggestion request timed out.";
    case "backoff":
      return "A temporary model error occurred. Suggestions are paused briefly.";
    case "failed":
      return "The language model request failed. Try again later.";
    case "cancelled":
      return "The Copilot suggestion request was cancelled.";
    case "stale":
      return "The document changed before the suggestion was ready.";
    case "blocked":
      return "The language model request is blocked by an account, policy, or service limit.";
    default:
      return "The Copilot suggestion request could not be completed.";
  }
}

const SUGGESTION_INPUT_TYPES = new Set([
  "insertText",
  "insertCompositionText",
  "insertFromComposition",
  "insertReplacementText",
  "insertParagraph",
  "insertLineBreak",
  "deleteContentBackward",
  "deleteContentForward",
  "deleteWordBackward",
  "deleteWordForward",
  "deleteSoftLineBackward",
  "deleteSoftLineForward",
  "deleteHardLineBackward",
  "deleteHardLineForward",
  "deleteEntireSoftLine",
  "deleteByCut",
]);

function isSuggestionInputType(inputType: string): boolean {
  return SUGGESTION_INPUT_TYPES.has(inputType);
}

function isTextInsertionInputType(inputType: string): boolean {
  return (
    inputType === "insertText" ||
    inputType === "insertCompositionText" ||
    inputType === "insertFromComposition"
  );
}
