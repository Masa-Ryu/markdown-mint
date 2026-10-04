import { execFileSync } from "node:child_process";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";

const root = process.cwd();
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const output = join(root, `${manifest.name}-${manifest.version}.vsix`);

// A previous build may have come from the former native-SDK packaging path.
// Never allow its ignored output directory to leak into the universal VSIX.
await rm(join(root, "dist/copilot"), { recursive: true, force: true });
await rm(output, { force: true });
for (const name of await readdir(root)) {
  if (
    name.startsWith(`${manifest.name}-`) &&
    name.endsWith(".vsix") &&
    /-(?:darwin|linux|win32)-(?:arm64|x64)\.vsix$/.test(name)
  )
    await rm(join(root, name), { force: true });
}
execFileSync(
  process.execPath,
  [
    join(root, "node_modules/@vscode/vsce/vsce"),
    "package",
    "--no-dependencies",
    "--out",
    output,
  ],
  { cwd: root, stdio: "inherit" },
);
const size = (await stat(output)).size;
process.stdout.write(
  `Packaged universal VSIX: ${basename(output)} (${size} compressed bytes).\n`,
);
