import { describe, expect, it } from "vitest";
import { mergeMarkdownSnapshots } from "../../src/shared/threeWayMerge";

function numberedLines(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index}\n`);
}

describe("three-way Markdown merge budgets", () => {
  it("finishes broad 250, 500 and 1000 line edits on the safe conflict path", () => {
    for (const count of [250, 500, 1_000]) {
      const baseLines = numberedLines("line", count);
      const base = baseLines.join("");
      const local = ["LOCAL\n", ...baseLines.slice(1)].join("");
      const external = numberedLines("external", count).join("");

      // A budget exhaustion and an overlapping edit both have to remain an
      // explicit conflict. In particular, neither may become an empty diff,
      // a success, or an implicit full-document replacement.
      expect(mergeMarkdownSnapshots(base, local, external)).toBeUndefined();
    }
  });
});
