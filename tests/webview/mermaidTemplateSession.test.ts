import { describe, expect, it } from "vitest";
import { MermaidTemplateSession } from "../../src/webview/mermaidTemplateSession";

const application = (id: string, source: string) => ({
  id,
  direction: "LR" as const,
  source,
});

describe("Mermaid replacement sessions", () => {
  it.each([true, false])(
    "confirms protected/edited code and keeps rejected drafts (protected=%s)",
    (protectedSource) => {
      const session = new MermaidTemplateSession();
      session.start("original", protectedSource);
      if (!protectedSource) session.noteUserInput("edited");
      const source = session.source;
      expect(
        session.requestApply(application("flowchart-basic", "template")),
      ).toBe("confirm");
      expect(session.source).toBe(source);
      expect(session.confirmation).toBe("apply");
      session.reject();
      expect(session.source).toBe(source);
      expect(session.confirmation).toBeNull();
    },
  );

  it("keeps the initial dirty baseline across pristine template switches", () => {
    const session = new MermaidTemplateSession();
    session.start("initial", false);
    expect(session.requestApply(application("first", "first"))).toBe("applied");
    expect(session.isDirty).toBe(true);
    expect(session.requestApply(application("second", "second"))).toBe(
      "applied",
    );
    expect(session.source).toBe("second");
    expect(session.isDirty).toBe(true);
  });

  it("does not change the draft for an identical source", () => {
    const session = new MermaidTemplateSession();
    session.start("initial", false);
    expect(
      session.requestApply(application("flowchart-basic", "template")),
    ).toBe("applied");
    expect(
      session.requestApply(application("flowchart-basic", "template")),
    ).toBe("unchanged");
    expect(session.source).toBe("template");
    expect(session.isDirty).toBe(true);
  });

  it("forgets pending operations when the modal closes", () => {
    const session = new MermaidTemplateSession();
    session.start("old", true);
    expect(
      session.requestApply(application("flowchart-basic", "template")),
    ).toBe("confirm");
    session.close();
    expect(session.confirm()).toBeUndefined();
    expect(session.confirmation).toBeNull();
    expect(session.isDirty).toBe(false);
    session.start("new", false);
    expect(session.source).toBe("new");
  });

  it("retains explicit template metadata across screen synchronization only", () => {
    const session = new MermaidTemplateSession();
    const applied = application("flowchart-basic", "flowchart LR\nA-->B");
    session.start("starter", false);
    expect(session.requestApply(applied)).toBe("applied");
    expect(session.appliedTemplateFor(applied.source)).toEqual(applied);
    session.syncDraft(applied.source);
    expect(session.appliedTemplateFor(applied.source)).toEqual(applied);
    session.syncDraft("changed without an input event");
    expect(session.appliedTemplateFor(applied.source)).toBeNull();
    session.syncDraft(applied.source);
    expect(session.appliedTemplateFor(applied.source)).toEqual(applied);
    session.noteUserInput(applied.source);
    expect(session.appliedTemplateFor(applied.source)).toBeNull();
  });

  it("does not infer built-in provenance from protected text that matches a template", () => {
    const session = new MermaidTemplateSession();
    session.start("flowchart LR\nA-->B", true);
    expect(
      session.requestApply(
        application("flowchart-basic", "flowchart LR\nA-->B"),
      ),
    ).toBe("unchanged");
    expect(session.appliedTemplateFor("flowchart LR\nA-->B")).toBeNull();
  });

  it("discards applied-template provenance when the session closes", () => {
    const session = new MermaidTemplateSession();
    session.start("starter", false);
    expect(
      session.requestApply(application("flowchart-basic", "template")),
    ).toBe("applied");
    session.close();
    expect(session.appliedTemplateFor("template")).toBeNull();
  });
});
