import { describe, expect, it } from "vitest";
import {
  MermaidTemplateSession,
  type MermaidDraftSnapshot,
} from "../../src/webview/mermaidTemplateSession";

const input = (source: string): MermaidDraftSnapshot => ({
  source,
  selectionStart: 2,
  selectionEnd: 7,
  selectionDirection: "backward",
  scrollTop: 40,
  scrollLeft: 10,
});

describe("Mermaid replacement sessions", () => {
  it.each([true, false])(
    "confirms protected/edited code and keeps rejected drafts (protected=%s)",
    (protectedSource) => {
      const session = new MermaidTemplateSession();
      session.start("original", protectedSource);
      if (!protectedSource) session.edit("edited");
      const source = session.source;
      expect(session.requestApply("template", input(source))).toBe("confirm");
      expect(session.source).toBe(source);
      session.reject();
      expect(session.source).toBe(source);
      expect(session.canRestore).toBe(false);
      expect(session.confirmation).toBeNull();
    },
  );

  it("keeps the initial dirty baseline across pristine template switches and restores caret/scroll", () => {
    const session = new MermaidTemplateSession();
    session.start("initial", false);
    expect(session.requestApply("first", input("initial"))).toBe("applied");
    expect(session.isDirty).toBe(true);
    expect(session.requestApply("second", input("first"))).toBe("applied");
    expect(session.isDirty).toBe(true);
    expect(session.requestRestore()).toBe("ready");
    expect(session.confirm()).toEqual(input("first"));
    expect(session.source).toBe("first");
    expect(session.isDirty).toBe(true);
    expect(session.canRestore).toBe(false);
  });

  it("does not overwrite the last snapshot or dirty state for identical source", () => {
    const session = new MermaidTemplateSession();
    session.start("initial", false);
    session.requestApply("template", input("initial"));
    expect(session.requestApply("template", input("template"))).toBe(
      "unchanged",
    );
    session.requestRestore();
    expect(session.confirm()).toEqual(input("initial"));
    expect(session.isDirty).toBe(false);
  });

  it("confirms restoration over typing and restores the protected origin", () => {
    const session = new MermaidTemplateSession();
    session.start("existing", true);
    session.requestApply("template", input("existing"));
    session.confirm();
    session.edit("手入力 🐈");
    expect(session.requestRestore()).toBe("confirm");
    session.reject();
    expect(session.source).toBe("手入力 🐈");
    session.requestRestore();
    expect(session.confirm()).toEqual(input("existing"));
    expect(session.source).toBe("existing");
    expect(session.isDirty).toBe(false);
    expect(session.requestApply("next", input("existing"))).toBe("confirm");
  });

  it("forgets pending operations and snapshots at close/reopen", () => {
    const session = new MermaidTemplateSession();
    session.start("old", true);
    session.requestApply("template", input("old"));
    session.close();
    expect(session.confirm()).toBeUndefined();
    expect(session.requestRestore()).toBe("unchanged");
    expect(session.isDirty).toBe(false);
    session.start("new", false);
    expect(session.source).toBe("new");
    expect(session.canRestore).toBe(false);
  });
});
