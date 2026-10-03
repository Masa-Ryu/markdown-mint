import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("release workflow target handling", () => {
  it("passes the target commit for both existing-tag and new-tag creation", () => {
    const workflow = readFileSync(
      resolve(process.cwd(), ".github/workflows/release.yml"),
      "utf8",
    );
    const createArgs = workflow.match(/create_args=\(([^)\n]+)\)/)?.[1];

    expect(createArgs).toContain('--target "$GITHUB_SHA"');
    expect(workflow).toMatch(/create_args\+=\(--verify-tag\)/);
    expect(workflow).not.toMatch(/else\s+create_args\+=\(--target/);
  });
});
