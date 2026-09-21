import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const extensionIcon = "extension/assets/icon/icon.png";
if (packageJson.icon !== "assets/icon/icon.png") {
  throw new Error(
    "package.json must register assets/icon/icon.png as its icon",
  );
}
const vsixPath = join(
  process.cwd(),
  `${packageJson.name}-${packageJson.version}.vsix`,
);

if (!existsSync(vsixPath)) {
  throw new Error(`Missing VSIX artifact: ${vsixPath}`);
}

const archive = await readFile(vsixPath);
const entries = listZipEntries(archive);
const requiredEntries = [
  "extension/package.json",
  extensionIcon,
  "extension/dist/extension.js",
  "extension/dist/webview.js",
  "extension/dist/mermaid.js",
  "extension/dist/mermaid-loader.js",
  "extension/media/document.css",
];
for (const entry of requiredEntries) {
  if (!entries.includes(entry)) {
    throw new Error(`VSIX is missing required entry: ${entry}`);
  }
}

const forbiddenPrefixes = [
  "extension/tests/",
  "extension/scripts/",
  "extension/src/",
  "extension/docs/",
  "extension/images/",
  "extension/md/",
  "extension/github-markdown-test-suite/",
];
const forbiddenEntries = entries.filter(
  (entry) =>
    forbiddenPrefixes.some((prefix) => entry.startsWith(prefix)) ||
    entry.endsWith(".svg") ||
    entry.endsWith("demo1.gif"),
);
const unexpectedAssetEntries = entries.filter(
  (entry) =>
    entry.startsWith("extension/assets/") &&
    !entry.endsWith("/") &&
    entry !== extensionIcon,
);
forbiddenEntries.push(...unexpectedAssetEntries);
if (forbiddenEntries.length > 0) {
  throw new Error(
    `VSIX contains repository-only or build-embedded assets:\n${forbiddenEntries.join("\n")}`,
  );
}

const packageSize = (await stat(vsixPath)).size;
const sizeInMiB = (packageSize / 1024 / 1024).toFixed(2);
process.stdout.write(
  `VSIX verification passed: ${entries.length} files, ${packageSize} bytes (${sizeInMiB} MiB).\n`,
);

function listZipEntries(buffer) {
  const endOfCentralDirectory = findEndOfCentralDirectory(buffer);
  const centralDirectorySize = buffer.readUInt32LE(endOfCentralDirectory + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(
    endOfCentralDirectory + 16,
  );
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  const entries = [];
  let offset = centralDirectoryOffset;

  while (offset < centralDirectoryEnd) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("Invalid VSIX central directory entry");
    }
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraFieldLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    entries.push(
      buffer.toString("utf8", offset + 46, offset + 46 + fileNameLength),
    );
    offset += 46 + fileNameLength + extraFieldLength + commentLength;
  }

  if (offset !== centralDirectoryEnd) {
    throw new Error("Invalid VSIX central directory size");
  }
  return entries;
}

function findEndOfCentralDirectory(buffer) {
  const signature = 0x06054b50;
  const minimumOffset = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) return offset;
  }
  throw new Error("VSIX is missing the ZIP end-of-central-directory record");
}
