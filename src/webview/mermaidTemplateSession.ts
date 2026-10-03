type PendingReplacement = {
  readonly source: string;
};

/** One modal session. Candidate browsing never writes to this draft. */
export class MermaidTemplateSession {
  private initialSource: string | null = null;
  private pristineSource: string | null = null;
  private pending: PendingReplacement | null = null;
  source = "";

  get isDirty(): boolean {
    return this.initialSource !== null && this.source !== this.initialSource;
  }
  get confirmation(): "apply" | null {
    return this.pending ? "apply" : null;
  }

  start(source: string, protectedSource: boolean): void {
    this.close();
    this.initialSource = this.source = source;
    this.pristineSource = protectedSource ? null : source;
  }

  edit(source: string): void {
    this.source = source;
  }

  requestApply(source: string): "unchanged" | "confirm" | "applied" {
    if (this.initialSource === null || source === this.source)
      return "unchanged";
    this.pending = { source };
    if (this.source !== this.pristineSource) return "confirm";
    this.confirm();
    return "applied";
  }

  confirm(): void {
    const pending = this.pending;
    this.pending = null;
    if (!pending || this.initialSource === null) return;
    this.source = this.pristineSource = pending.source;
  }

  reject(): void {
    this.pending = null;
  }

  close(): void {
    this.initialSource = this.pristineSource = null;
    this.source = "";
    this.pending = null;
  }
}
