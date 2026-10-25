import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { jobCommands, readWorkflow } from "./workflow-helpers";

const { source, workflow } = readWorkflow("release.yml");
const preflight = workflow.jobs.preflight!;
const validate = workflow.jobs.validate!;
const publish = workflow.jobs.publish_github_release!;
const validateCommands = jobCommands(validate);
const publishCommands = jobCommands(publish);

describe("GitHub Release workflow", () => {
  it("starts only through workflow_dispatch", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  });

  it("runs all release jobs on standard GitHub-hosted Ubuntu in order", () => {
    expect(Object.keys(workflow.jobs)).toEqual([
      "preflight",
      "validate",
      "publish_github_release",
    ]);
    for (const job of Object.values(workflow.jobs))
      expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(source).not.toMatch(/self-hosted|n100|apt-get|brew install/i);
    expect(validate.needs).toBe("preflight");
    expect(publish.needs).toBe("validate");
    expect(
      preflight.steps.some((step) => step.uses?.includes("checkout")),
    ).toBe(false);
  });

  it.each([
    ["refs/heads/main", 0],
    ["refs/heads/feature", 1],
    ["refs/tags/v0.9.6", 1],
    ["refs/pull/1/merge", 1],
  ])("guards the selected ref %s before validation", (ref, status) => {
    const result = spawnSync("bash", ["-e", "-c", jobCommands(preflight)], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_REF: ref },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(status);
    if (status !== 0)
      expect(result.stdout).toContain("Releases can only be started from main");
    expect(validateCommands).toContain(
      'if [[ "$GITHUB_REF" != "refs/heads/main" ]]',
    );
    expect(validateCommands).toContain(
      '"$(git rev-parse HEAD)" != "$GITHUB_SHA"',
    );
  });

  it("grants write access only to the publication job", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(preflight.permissions).toEqual({});
    expect(validate.permissions).toEqual({ contents: "read" });
    expect(publish.permissions).toEqual({ contents: "write" });
    for (const job of [validate, publish]) {
      expect(
        job.steps.find((step) => step.uses === "actions/checkout@v4")?.with,
      ).toMatchObject({
        ref: "${{ github.sha }}",
        "persist-credentials": false,
      });
      expect(
        job.steps.find((step) => step.uses === "actions/setup-node@v4")?.with,
      ).toMatchObject({ "node-version": 22 });
    }
  });

  it("checks preinstalled release tools before using them in either job", () => {
    for (const job of [validate, publish]) {
      const check = job.steps[0]!;
      expect(check.shell).toBe("bash");
      expect(check.run).toContain("for tool in gh jq curl sha256sum; do");
      expect(check.run).toContain('if ! command -v "$tool"; then');
      expect(check.run).toContain("::error::Required command");
      expect(check.run).toContain("exit 1");
    }
  });

  it("validates and retains one VSIX for publication without rebuilding", () => {
    for (const command of [
      "npm ci",
      "npm run compile",
      "npm test",
      "npm run lint",
      "npm run format:check",
      "npm run package",
    ])
      expect(validate.steps.some((step) => step.run === command)).toBe(true);
    expect(validateCommands).toContain("packages=(markdown-mint-*.vsix)");
    expect(validateCommands).toContain("${#packages[@]} -ne 1");
    expect(validateCommands).toContain('sha256sum "$expected"');
    expect(validate.outputs?.sha256).toBe(
      "${{ steps.artifact.outputs.sha256 }}",
    );
    const upload = validate.steps.find(
      (step) => step.uses === "actions/upload-artifact@v4",
    );
    expect(upload?.with).toMatchObject({
      name: "${{ steps.metadata.outputs.artifact_name }}",
      "if-no-files-found": "error",
      "retention-days": 90,
    });
    expect(upload?.with?.path).toBe(
      "markdown-mint-${{ steps.metadata.outputs.version }}.vsix\nrelease-notes.md\n",
    );
    expect(
      publish.steps.find((step) => step.uses === "actions/download-artifact@v4")
        ?.with,
    ).toEqual({
      name: "${{ needs.validate.outputs.artifact_name }}",
      path: "release-payload",
    });
    expect(publishCommands).not.toMatch(/npm (?:ci|run)|vsce package/);
    expect(publishCommands).toContain('sha256sum "$vsix"');
    expect(publishCommands).toContain('"$actual_sha256" != "$EXPECTED_SHA256"');
    expect(publishCommands).toMatch(
      /create_args=\([^\n]*"\$VSIX_PATH" --draft/,
    );
    expect(publishCommands).toContain('gh release upload "$tag" "$VSIX_PATH"');
    expect(publishCommands).toContain('sha256sum "$asset_dir/$asset_name"');
  });

  it("preserves draft recovery and contains no Marketplace publishing setup", () => {
    expect(publishCommands).toContain(
      "node scripts/release-recovery.mjs plan-current",
    );
    for (const action of [
      "create_release",
      "upload_asset",
      "delete_starter_asset",
      "verify_asset",
      "publish_release",
      "already_published",
    ])
      expect(publishCommands).toContain(`${action})`);
    expect(publishCommands).toContain("--field draft=false");
    expect(publishCommands).toContain("Rerun failed jobs");
    expect(source).not.toMatch(
      /marketplace|oidc|VSCE_PAT|id-token|production environment|vsce publish/i,
    );
  });

  it("preserves release-note bytes and propagates recovery-planner failures", () => {
    expect(publishCommands).toContain("releaseNotes: $releaseNotes");
    expect(publishCommands).not.toMatch(
      /releaseNotes: \(\$releaseNotes \| sub\(/,
    );
    expect(publishCommands).toContain(
      'if ! node scripts/release-recovery.mjs plan-current < "$state_json" > "$plan_json"; then',
    );
    expect(publishCommands).toContain(
      'if ! action="$(make_recovery_plan)"; then',
    );
    expect(publishCommands).toContain(
      "jq -er '.plan.action // empty' \"$plan_json\"",
    );
  });
});
