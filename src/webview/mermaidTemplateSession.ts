export interface MermaidDraftSnapshot {
  readonly source: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly selectionDirection: "forward" | "backward" | "none";
  readonly scrollTop: number;
  readonly scrollLeft: number;
}

interface ReplacementSnapshot {
  readonly input: MermaidDraftSnapshot;
  readonly pristineSource: string | null;
}

type PendingReplacement =
  | {
      readonly kind: "apply";
      readonly source: string;
      readonly before: ReplacementSnapshot;
    }
  | { readonly kind: "restore" };

/** One modal session. Candidate browsing never writes to this draft. */
export class MermaidTemplateSession {
  private initialSource: string | null = null;
  private pristineSource: string | null = null;
  private replacement: ReplacementSnapshot | null = null;
  private replacementSource: string | null = null;
  private pending: PendingReplacement | null = null;
  source = "";

  get isDirty(): boolean {
    return this.initialSource !== null && this.source !== this.initialSource;
  }
  get canRestore(): boolean {
    return this.replacement !== null;
  }
  get confirmation(): "apply" | "restore" | null {
    return this.pending?.kind ?? null;
  }

  start(source: string, protectedSource: boolean): void {
    this.close();
    this.initialSource = this.source = source;
    this.pristineSource = protectedSource ? null : source;
  }

  edit(source: string): void {
    this.source = source;
  }

  requestApply(
    source: string,
    input: MermaidDraftSnapshot,
  ): "unchanged" | "confirm" | "applied" {
    if (this.initialSource === null || source === this.source)
      return "unchanged";
    this.pending = {
      kind: "apply",
      source,
      before: { input, pristineSource: this.pristineSource },
    };
    if (this.source !== this.pristineSource) return "confirm";
    this.confirm();
    return "applied";
  }

  requestRestore(): "unchanged" | "confirm" | "ready" {
    if (!this.replacement) return "unchanged";
    this.pending = { kind: "restore" };
    if (this.source !== this.replacementSource) return "confirm";
    return "ready";
  }

  confirm(): MermaidDraftSnapshot | undefined {
    const pending = this.pending;
    this.pending = null;
    if (!pending || this.initialSource === null) return;
    if (pending.kind === "apply") {
      this.replacement = pending.before;
      this.source =
        this.pristineSource =
        this.replacementSource =
          pending.source;
      return;
    }
    const previous = this.replacement;
    if (!previous) return;
    this.source = previous.input.source;
    this.pristineSource = previous.pristineSource;
    this.replacement = null;
    this.replacementSource = null;
    return previous.input;
  }

  reject(): void {
    this.pending = null;
  }

  close(): void {
    this.initialSource = this.pristineSource = this.replacementSource = null;
    this.source = "";
    this.replacement = this.pending = null;
  }
}
