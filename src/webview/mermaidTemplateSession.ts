import type { MermaidTemplateDirection } from "./mermaidTemplates";

export interface MermaidTemplateApplication {
  readonly id: string;
  readonly direction?: MermaidTemplateDirection;
  readonly source: string;
}

type PendingReplacement = MermaidTemplateApplication;

/** One modal session. Candidate browsing never writes to this draft. */
export class MermaidTemplateSession {
  private initialSource: string | null = null;
  private pristineSource: string | null = null;
  private pending: PendingReplacement | null = null;
  private appliedTemplate: MermaidTemplateApplication | null = null;
  private userEdited = false;
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

  syncDraft(source: string): void {
    this.source = source;
  }

  noteUserInput(source: string): void {
    this.source = source;
    this.userEdited = true;
    this.appliedTemplate = null;
  }

  appliedTemplateFor(source: string): MermaidTemplateApplication | null {
    return this.userEdited ||
      this.appliedTemplate?.source !== source ||
      this.source !== source
      ? null
      : this.appliedTemplate;
  }

  requestApply(
    template: MermaidTemplateApplication,
  ): "unchanged" | "confirm" | "applied" {
    if (this.initialSource === null) return "unchanged";
    if (template.source === this.source) {
      if (!this.userEdited && this.pristineSource !== null)
        this.appliedTemplate = template;
      return "unchanged";
    }
    this.pending = template;
    if (this.source !== this.pristineSource) return "confirm";
    this.confirm();
    return "applied";
  }

  confirm(): void {
    const pending = this.pending;
    this.pending = null;
    if (!pending || this.initialSource === null) return;
    this.source = this.pristineSource = pending.source;
    this.appliedTemplate = pending;
    this.userEdited = false;
  }

  reject(): void {
    this.pending = null;
  }

  close(): void {
    this.initialSource = this.pristineSource = null;
    this.source = "";
    this.pending = null;
    this.appliedTemplate = null;
    this.userEdited = false;
  }
}
