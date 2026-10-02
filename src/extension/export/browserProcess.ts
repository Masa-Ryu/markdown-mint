import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";

export function launchBrowser(
  executablePath: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  return spawn(executablePath, args, options);
}
