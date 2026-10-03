import { describe, expect, it } from "vitest";
import { MermaidTemplateSession } from "../../src/webview/mermaidTemplateSession";

describe("Mermaid replacement sessions", () => {
  it.each([true, false])(
    "confirms protected/edited code and keeps rejected drafts (protected=%s)",
    (protectedSource) => {
      const session = new MermaidTemplateSession();
      session.start("original", protectedSource);
      if (!protectedSource) session.edit("edited");
      const source = session.source;
      expect(session.requestApply("template")).toBe("confirm");
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
    expect(session.requestApply("first")).toBe("applied");
    expect(session.isDirty).toBe(true);
    expect(session.requestApply("second")).toBe("applied");
    expect(session.source).toBe("second");
    expect(session.isDirty).toBe(true);
  });

  it("does not change the draft for an identical source", () => {
    const session = new MermaidTemplateSession();
    session.start("initial", false);
    expect(session.requestApply("template")).toBe("applied");
    expect(session.requestApply("template")).toBe("unchanged");
    expect(session.source).toBe("template");
    expect(session.isDirty).toBe(true);
  });

  it("forgets pending operations when the modal closes", () => {
    const session = new MermaidTemplateSession();
    session.start("old", true);
    expect(session.requestApply("template")).toBe("confirm");
    session.close();
    expect(session.confirm()).toBeUndefined();
    expect(session.confirmation).toBeNull();
    expect(session.isDirty).toBe(false);
    session.start("new", false);
    expect(session.source).toBe("new");
  });
});
