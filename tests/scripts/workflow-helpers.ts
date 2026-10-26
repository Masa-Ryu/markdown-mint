import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDocument } from "yaml";

export interface WorkflowStep {
  name: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  shell?: string;
  env?: Record<string, string>;
  with?: Record<string, string | number | boolean>;
  "continue-on-error"?: boolean;
}

export interface WorkflowJob {
  name: string;
  "runs-on": string;
  "timeout-minutes"?: number;
  needs?: string | string[];
  if?: string;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  defaults?: { run: { shell: string } };
  strategy?: { "fail-fast": boolean; matrix: { os: string[] } };
  steps: WorkflowStep[];
  "continue-on-error"?: boolean;
}

export function readWorkflow(filename: string): {
  source: string;
  workflow: {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    jobs: Record<string, WorkflowJob>;
  };
} {
  const source = readFileSync(
    resolve(process.cwd(), ".github/workflows", filename),
    "utf8",
  );
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) throw document.errors[0];
  return { source, workflow: document.toJS() };
}

export function jobCommands(job: WorkflowJob): string {
  return job.steps.map((step) => step.run ?? "").join("\n");
}
