import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const versionLikeHeading =
  /(?:^|[^A-Za-z0-9])v?[ \t]*\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?(?=$|[^A-Za-z0-9])/i;

export function isValidSemVer(version) {
  return typeof version === "string" && semverPattern.test(version);
}

export function extractReleaseNotes(packageVersion, changelog) {
  if (!isValidSemVer(packageVersion)) {
    throw new Error(
      `package.json version is not valid SemVer: ${String(packageVersion)}`,
    );
  }
  if (typeof changelog !== "string") {
    throw new Error("CHANGELOG.md content must be a string");
  }

  const lines = changelog.split(/\r?\n/);
  const sectionHeadings = [];
  const versionHeadings = [];

  for (const [lineIndex, line] of lines.entries()) {
    if (!/^##(?:[ \t]|$)/.test(line)) continue;
    sectionHeadings.push(lineIndex);

    const headingMatch = line.match(/^##[ \t]+(.*?)[ \t]*$/);
    if (!headingMatch) continue;

    const headingVersion = headingMatch[1];
    if (!versionLikeHeading.test(headingVersion)) continue;
    if (!isValidSemVer(headingVersion) || line !== `## ${headingVersion}`) {
      throw new Error(
        `Malformed version heading on line ${lineIndex + 1}: ${line}`,
      );
    }

    versionHeadings.push({ lineIndex, version: headingVersion });
  }

  const matches = versionHeadings.filter(
    (heading) => heading.version === packageVersion,
  );
  if (matches.length === 0) {
    throw new Error(
      `CHANGELOG.md is missing a section for version ${packageVersion}`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `CHANGELOG.md has duplicate sections for version ${packageVersion}`,
    );
  }

  const start = matches[0].lineIndex + 1;
  const end =
    sectionHeadings.find((lineIndex) => lineIndex > matches[0].lineIndex) ??
    lines.length;
  return lines.slice(start, end).join("\n").trim();
}

export async function readCurrentReleaseNotes(root = process.cwd()) {
  const [packageContent, changelog] = await Promise.all([
    readFile(resolve(root, "package.json"), "utf8"),
    readFile(resolve(root, "CHANGELOG.md"), "utf8"),
  ]);
  const packageJson = JSON.parse(packageContent);
  return {
    version: packageJson.version,
    releaseNotes: extractReleaseNotes(packageJson.version, changelog),
  };
}

async function main() {
  const { releaseNotes } = await readCurrentReleaseNotes();
  process.stdout.write(`${releaseNotes}\n`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
