import { describe, expect, it } from "vitest";
import {
  DEFAULT_DIFF_BUDGET_LIMITS,
  mergeMarkdownSnapshots,
  mergeMarkdownSnapshotsWithBudget,
} from "../../src/shared/threeWayMerge";

function numberedLines(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index}\n`);
}

describe("three-way Markdown merge budgets", () => {
  it("keeps repeated-line insertions at one base position in conflict", () => {
    expect(
      mergeMarkdownSnapshots("A\n", "A\nB\n", "B\nA\nA\n"),
    ).toBeUndefined();
  });

  it("reports deterministic work-budget exhaustion", () => {
    const count = 80;
    const base = numberedLines("base", count).join("");
    const local = numberedLines("local", count).join("");
    const external = numberedLines("external", count).join("");
    const maxWorkUnits = 100;

    const attempt = mergeMarkdownSnapshotsWithBudget(base, local, external, {
      maxWorkUnits,
      maxTraceCells: 1_000_000,
    });

    expect(attempt.result).toBeUndefined();
    expect(attempt.diagnostics.reason).toBe("work-budget");
    expect(attempt.diagnostics.workUnits).toBe(maxWorkUnits + 1);
    expect(attempt.diagnostics.traceCells).toBeLessThan(
      attempt.diagnostics.limits.maxTraceCells,
    );
  });

  it("reports deterministic trace-budget exhaustion", () => {
    const count = 80;
    const base = numberedLines("base", count).join("");
    const local = numberedLines("local", count).join("");
    const external = numberedLines("external", count).join("");
    const maxTraceCells = 50;

    const attempt = mergeMarkdownSnapshotsWithBudget(base, local, external, {
      maxWorkUnits: 1_000_000,
      maxTraceCells,
    });

    expect(attempt.result).toBeUndefined();
    expect(attempt.diagnostics.reason).toBe("trace-budget");
    expect(attempt.diagnostics.traceCells).toBeGreaterThan(maxTraceCells);
    expect(attempt.diagnostics.workUnits).toBeLessThan(
      attempt.diagnostics.limits.maxWorkUnits,
    );
  });

  it("keeps the production default budget limits", () => {
    const attempt = mergeMarkdownSnapshotsWithBudget(
      "base\n",
      "local\n",
      "external\n",
    );

    expect(DEFAULT_DIFF_BUDGET_LIMITS).toEqual({
      maxWorkUnits: 4_000_000,
      maxTraceCells: 250_000,
    });
    expect(attempt.diagnostics.limits).toEqual(DEFAULT_DIFF_BUDGET_LIMITS);
    expect(
      mergeMarkdownSnapshots("base\n", "local\n", "external\n"),
    ).toBeUndefined();
  });

  it("integration: keeps broad 250, 500 and 1000 line edits on the safe conflict path", () => {
    for (const count of [250, 500, 1_000]) {
      const baseLines = numberedLines("line", count);
      const base = baseLines.join("");
      const local = ["LOCAL\n", ...baseLines.slice(1)].join("");
      const external = numberedLines("external", count).join("");

      // This is an integration regression for production-sized broad diffs.
      // Deterministic budget-unit exhaustion is asserted separately above.
      expect(mergeMarkdownSnapshots(base, local, external)).toBeUndefined();
    }
  });
});
