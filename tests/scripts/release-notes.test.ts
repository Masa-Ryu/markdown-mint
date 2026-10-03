import { describe, expect, it } from "vitest";
import {
  extractReleaseNotes,
  isValidSemVer,
} from "../../scripts/release-notes.mjs";

describe("release note extraction", () => {
  it("extracts the package version section", () => {
    const changelog = [
      "# Changelog",
      "",
      "## 1.2.3",
      "",
      "- Current release note.",
      "",
      "## 1.2.2",
      "- Previous release note.",
    ].join("\n");

    expect(extractReleaseNotes("1.2.3", changelog)).toBe(
      "- Current release note.",
    );
  });

  it("fails when the package version is missing", () => {
    expect(() =>
      extractReleaseNotes("1.2.3", "# Changelog\n\n## 1.2.2\n- Older"),
    ).toThrow("missing a section for version 1.2.3");
  });

  it("fails when the package version section is duplicated", () => {
    const changelog = [
      "## 1.2.3",
      "- First section.",
      "## 1.2.2",
      "- Older section.",
      "## 1.2.3",
      "- Duplicate section.",
    ].join("\n");

    expect(() => extractReleaseNotes("1.2.3", changelog)).toThrow(
      "duplicate sections for version 1.2.3",
    );
  });

  it("stops at the next adjacent version section", () => {
    const changelog = [
      "## 1.2.3",
      "- Current release note.",
      "## 1.2.2",
      "- Previous release note.",
    ].join("\n");

    expect(extractReleaseNotes("1.2.3", changelog)).toBe(
      "- Current release note.",
    );
  });

  it("extracts the final section through end of file", () => {
    const changelog = "# Changelog\n\n## 1.2.3\n\n- Final release note.";

    expect(extractReleaseNotes("1.2.3", changelog)).toBe(
      "- Final release note.",
    );
  });

  it.each([
    "## 1.2",
    "## v1.2.3",
    "## 1.2.3 notes",
    "## 01.2.3",
    "## Release 1.2.3",
  ])("rejects malformed version heading %s", (heading) => {
    expect(() =>
      extractReleaseNotes("1.2.3", `${heading}\n- Release note.`),
    ).toThrow("Malformed version heading");
  });

  it("allows non-version section headings", () => {
    const changelog = [
      "## Earlier unreleased changes",
      "- Unreleased note.",
      "## 1.2.3",
      "- Current release note.",
      "## 1.2.2",
      "- Previous release note.",
    ].join("\n");

    expect(extractReleaseNotes("1.2.3", changelog)).toBe(
      "- Current release note.",
    );
  });

  it("rejects malformed SemVer package versions", () => {
    expect(() => extractReleaseNotes("01.2.3", "## 1.2.3\n- Note")).toThrow(
      "not valid SemVer",
    );
  });

  it.each(["0.7.1", "1.0.0", "12.34.56"])(
    "accepts numeric X.Y.Z version %s",
    (version) => {
      expect(isValidSemVer(version)).toBe(true);
    },
  );

  it.each([
    "1.2",
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2.3-beta.1",
    "1.2.3+build",
    "v1.2.3",
  ])("rejects non-numeric-X.Y.Z version %s", (version) => {
    expect(isValidSemVer(version)).toBe(false);
    expect(() => extractReleaseNotes(version, "## 1.2.3\n- Note")).toThrow(
      "not valid SemVer",
    );
  });
});
