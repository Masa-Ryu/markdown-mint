import { spawnSync } from "node:child_process";
import { devNull } from "node:os";
import { describe, expect, it } from "vitest";
import { jobCommands, readWorkflow } from "./workflow-helpers";

const { source, workflow } = readWorkflow("ci.yml");
const matrix = workflow.jobs["extension-host-matrix"]!;
const aggregate = workflow.jobs["extension-smoke"]!;
const runners = ["ubuntu-24.04", "windows-2025", "macos-15"];

describe("Pull request CI workflow", () => {
  it("keeps the four required check names and Linux validation suites", () => {
    for (const name of [
      "quality",
      "browser-smoke",
      "extension-smoke",
      "package-check",
    ]) {
      expect(workflow.jobs[name]?.name).toBe(name);
      expect(workflow.jobs[name]?.["runs-on"]).toBe("ubuntu-24.04");
    }
    const quality = jobCommands(workflow.jobs.quality!);
    for (const command of [
      "npm ci",
      "npm run compile",
      "npm test",
      "npm run lint",
      "npm run format:check",
    ])
      expect(quality).toContain(command);
    const browser = jobCommands(workflow.jobs["browser-smoke"]!);
    expect(browser).toContain("npx playwright install --with-deps chromium");
    for (const suite of ["blocks", "tables", "html-export", "pdf-export"])
      expect(browser).toContain(`npm run test:browser:${suite}`);
    expect(jobCommands(workflow.jobs["package-check"]!)).toContain(
      "npm run package",
    );
  });

  it("runs stable Extension Host tests on all three standard hosted OSes", () => {
    expect(matrix["runs-on"]).toBe("${{ matrix.os }}");
    expect(matrix.strategy).toEqual({
      "fail-fast": false,
      matrix: { os: runners },
    });
    expect(matrix.if).toBeUndefined();
    expect(matrix["timeout-minutes"]).toBeGreaterThanOrEqual(30);
    expect(matrix.defaults?.run.shell).toBe("bash");
    expect(matrix.env).toMatchObject({
      MARKDOWN_MINT_VSCODE_VERSION: "stable",
    });
    expect(
      matrix.steps.find((step) => step.uses === "actions/setup-node@v4")?.with,
    ).toMatchObject({ "node-version": 22 });
    expect(
      matrix.steps.find((step) => step.run?.includes("npm ci"))?.if,
    ).toBeUndefined();
    const testSteps = matrix.steps.filter((step) =>
      step.run?.includes("npm run test:extension"),
    );
    expect(testSteps).toHaveLength(2);
    expect(
      testSteps.find((step) => step.if === "runner.os == 'Linux'")?.run,
    ).toContain("xvfb-run -a npm run test:extension");
    const native = testSteps.find((step) => step.if === "runner.os != 'Linux'");
    expect(native?.run).toContain("npm run test:extension");
    expect(native?.run).not.toContain("xvfb-run");
    for (const step of testSteps) {
      expect(step.run).toContain("set -o pipefail");
      expect(step.env?.MARKDOWN_MINT_TEST_TMP).toBe(
        "${{ runner.temp }}/markdown-mint-extension",
      );
    }
  });

  it("checks preinstalled Xvfb only on Linux without reinstalling it", () => {
    const check = matrix.steps.find((step) =>
      step.run?.includes("command -v xvfb-run"),
    );
    expect(check?.if).toBe("runner.os == 'Linux'");
    expect(check?.run).toContain("::error::xvfb-run is missing");
    expect(source).not.toContain("apt-get");
  });

  it("waits for the complete matrix and reports failures even after a failed dependency", () => {
    expect(aggregate.needs).toBe("extension-host-matrix");
    expect(aggregate.if).toBe("${{ always() }}");
    expect(aggregate.steps).toHaveLength(1);
    expect(aggregate.steps[0]?.env?.MATRIX_RESULT).toBe(
      "${{ needs.extension-host-matrix.result }}",
    );
    for (const job of Object.values(workflow.jobs)) {
      expect(job["continue-on-error"]).toBeUndefined();
      for (const step of job.steps)
        expect(step["continue-on-error"]).toBeUndefined();
    }
  });

  it.each(["success", "failure", "cancelled", "skipped", "", "unknown"])(
    "accepts only a fully successful matrix (result: %s)",
    (result) => {
      const execution = spawnSync(
        "bash",
        ["-e", "-c", jobCommands(aggregate)],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            MATRIX_RESULT: result,
            GITHUB_STEP_SUMMARY: devNull,
          },
        },
      );
      expect(execution.error).toBeUndefined();
      expect(execution.status).toBe(result === "success" ? 0 : 1);
      if (result !== "success")
        expect(execution.stdout).toContain(
          "::error::Extension Host matrix did not succeed",
        );
    },
  );

  it("prints OS diagnostics and timings in job logs without storage uploads", () => {
    expect(matrix.name).toContain("${{ matrix.os }}");
    const diagnostics = matrix.steps.find(
      (step) => step.name === "Print native diagnostics",
    );
    expect(diagnostics?.if).toBe("always()");
    expect(diagnostics?.run).toContain("output/extension-host");
    expect(diagnostics?.run).toContain('tail -n 100 "$log"');
    const duration = matrix.steps.find(
      (step) => step.name === "Record job duration",
    );
    expect(duration?.if).toBe("always()");
    expect(duration?.env?.JOB_NAME).toContain("${{ matrix.os }}");
    expect(source).not.toMatch(
      /actions\/(?:upload-artifact|download-artifact|cache)@/,
    );
    for (const job of Object.values(workflow.jobs))
      for (const step of job.steps) expect(step.with?.cache).toBeUndefined();
  });

  it("uses read-only PR tokens with no secrets or release publication", () => {
    expect(Object.keys(workflow.on)).toEqual([
      "pull_request",
      "push",
      "workflow_dispatch",
    ]);
    expect(workflow.on.pull_request).toEqual({ branches: ["main"] });
    expect(workflow.permissions).toEqual({ contents: "read" });
    for (const job of Object.values(workflow.jobs)) {
      expect(job.permissions).toEqual({ contents: "read" });
      for (const step of job.steps.filter((step) =>
        step.uses?.startsWith("actions/checkout@"),
      ))
        expect(step.with?.["persist-credentials"]).toBe(false);
    }
    expect(source).not.toMatch(
      /self-hosted|n100|secrets\.|pull_request_target|contents: write|gh release|vsce publish/,
    );
  });

  it.each(["ci.yml", "release.yml"])(
    "contains valid YAML and Bash scripts in %s",
    (filename) => {
      const parsed = readWorkflow(filename);
      for (const [name, job] of Object.entries(parsed.workflow.jobs)) {
        for (const step of job.steps.filter((step) => step.run)) {
          const syntax = spawnSync("bash", ["-n"], {
            input: step.run,
            encoding: "utf8",
          });
          expect(syntax.error).toBeUndefined();
          expect(syntax.status, `${name}: ${step.name}: ${syntax.stderr}`).toBe(
            0,
          );
        }
      }
    },
  );
});
