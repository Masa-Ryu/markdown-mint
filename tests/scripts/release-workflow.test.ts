import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = resolve(process.cwd(), ".github/workflows/release.yml");

describe("GitHub Release workflow", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const eventBlock = workflow.match(/^on:\n([\s\S]*?)(?=^permissions:)/m)?.[1];
  const jobsBlock = workflow.match(/^jobs:\n([\s\S]*)$/m)?.[1] ?? "";
  const releaseJobOffset = jobsBlock.indexOf("  publish_github_release:");
  const validateJob = jobsBlock.slice(0, releaseJobOffset);
  const releaseJob = jobsBlock.slice(releaseJobOffset);

  it("starts only through workflow_dispatch", () => {
    const events = Array.from(
      (eventBlock ?? "").matchAll(/^ {2}([a-z0-9_-]+):$/gm),
      (match) => match[1],
    );
    expect(events).toEqual(["workflow_dispatch"]);
  });

  it("contains only validation and GitHub Release jobs with least permissions", () => {
    const jobNames = Array.from(
      jobsBlock.matchAll(/^ {2}([a-z0-9_-]+):$/gm),
      (match) => match[1],
    );
    expect(jobNames).toEqual(["validate", "publish_github_release"]);
    expect(releaseJob).toMatch(/^ {4}needs: validate$/m);
    expect(validateJob).toMatch(/^ {4}permissions:\n {6}contents: read$/m);
    expect(releaseJob).toMatch(/^ {4}permissions:\n {6}contents: write$/m);
  });

  it("validates and retains one universal VSIX with its checksum", () => {
    expect(validateJob).toContain("npm run package");
    expect(validateJob).toContain("sha256sum");
    expect(validateJob).toContain("actions/upload-artifact@v4");
    expect(validateJob).toContain(
      "markdown-mint-${{ steps.metadata.outputs.version }}.vsix",
    );
    expect(validateJob).toContain("printf 'artifacts=%s\\n'");
    expect(validateJob).toContain("retention-days: 90");

    expect(releaseJob).toContain("actions/download-artifact@v4");
    expect(releaseJob).toContain(
      "EXPECTED_ARTIFACTS: ${{ needs.validate.outputs.artifacts }}",
    );
    expect(releaseJob).toContain('name="markdown-mint-${VERSION}.vsix"');
    expect(releaseJob).toContain(
      'gh release upload "$tag" "release-payload/$asset_name"',
    );
    expect(releaseJob).toContain(
      'gh release download "$tag" --repo "$GITHUB_REPOSITORY" --pattern "$asset_name"',
    );
    expect(releaseJob).toContain(
      'actual_sha256="$(sha256sum "$asset_dir/$asset_name"',
    );
    expect(releaseJob).toContain("release_asset_hashes=");
  });

  it("recovers the release asset and publishes only after its checksum matches", () => {
    expect(releaseJob).toContain(
      "node scripts/release-recovery.mjs plan-current",
    );
    expect(releaseJob).toContain("delete_starter_asset");
    expect(releaseJob).toContain("verify_asset");
    expect(releaseJob).toContain("publish_release");
    expect(releaseJob).toContain("expected universal VSIX is verified");
    expect(releaseJob).toContain('if ! action="$(make_recovery_plan)"; then');
    expect(releaseJob).toContain("jq -er '.plan.action // empty'");
    expect(workflow).not.toMatch(
      /marketplace|oidc|VSCE_PAT|id-token|production environment|vsce publish/i,
    );
  });

  it("preserves release-note bytes and propagates recovery-planner failures", () => {
    expect(releaseJob).toContain("releaseNotes: $releaseNotes");
    expect(releaseJob).not.toMatch(/releaseNotes: \(\$releaseNotes \| sub\(/);
    expect(releaseJob).toContain(
      'if ! node scripts/release-recovery.mjs plan-current < "$state_json" > "$plan_json"; then',
    );
  });
});
