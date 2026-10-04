import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { join } from "node:path";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const vsixPath = join(
  process.cwd(),
  `${packageJson.name}-${packageJson.version}.vsix`,
);
const extensionIcon = "extension/assets/icon/icon.png";
if (packageJson.icon !== "assets/icon/icon.png")
  throw new Error(
    "package.json must register assets/icon/icon.png as its icon",
  );
const targetSpecific = (await readdir(process.cwd())).filter(
  (entry) =>
    entry.startsWith(`${packageJson.name}-${packageJson.version}-`) &&
    /-(?:darwin|linux|win32)-(?:arm64|x64)\.vsix$/.test(entry),
);
if (targetSpecific.length)
  throw new Error(
    `Target-specific VSIX artifacts remain: ${targetSpecific.join(", ")}`,
  );
if (!existsSync(vsixPath))
  throw new Error(`Missing VSIX artifact: ${vsixPath}`);

const archive = await readFile(vsixPath);
const entries = listZipEntries(archive);
const entryNames = entries.map((entry) => entry.name);
const requiredEntries = [
  "extension/package.json",
  extensionIcon,
  "extension/dist/extension.js",
  "extension/dist/webview.js",
  "extension/dist/mermaid.js",
  "extension/dist/mermaid-loader.js",
  "extension/media/document.css",
  "extension/media/export.css",
  "extension/dist/THIRD_PARTY_NOTICES.txt",
];
for (const entry of requiredEntries) {
  if (!entryNames.includes(entry))
    throw new Error(`VSIX is missing required entry: ${entry}`);
}

const forbiddenPrefixes = [
  "extension/tests/",
  "extension/scripts/",
  "extension/src/",
  "extension/docs/",
  "extension/images/",
  "extension/md/",
  "extension/github-markdown-test-suite/",
  "extension/dist/copilot/",
];
const forbiddenEntries = entryNames.filter(
  (entry) =>
    forbiddenPrefixes.some((prefix) => entry.startsWith(prefix)) ||
    entry.startsWith("extension/dist/test-") ||
    entry.endsWith(".svg") ||
    entry.endsWith("demo1.gif") ||
    /\.(?:exe|dll|dylib|so|node)$/i.test(entry) ||
    /(?:^|\/)(?:copilot-language-server(?:\.exe)?|copilot-[^/]+\.(?:node|dll|dylib|so))$/i.test(
      entry,
    ),
);
const unexpectedAssetEntries = entryNames.filter(
  (entry) =>
    entry.startsWith("extension/assets/") &&
    !entry.endsWith("/") &&
    entry !== extensionIcon,
);
forbiddenEntries.push(...unexpectedAssetEntries);
const embeddedRuntimeEntries = entryNames.filter((entry) =>
  /(?:^|\/)(?:chrome|chromium|chrome-headless-shell|headless_shell|node|nodejs)(?:\.exe)?$/i.test(
    entry,
  ),
);
const executableEntries = entries
  .filter((entry) => ((entry.externalFileAttributes >>> 16) & 0o111) !== 0)
  .map((entry) => entry.name);
forbiddenEntries.push(...embeddedRuntimeEntries, ...executableEntries);
if (forbiddenEntries.length > 0)
  throw new Error(
    `VSIX contains repository-only, SDK, or runtime assets:\n${forbiddenEntries.join("\n")}`,
  );

const embeddedPackage = JSON.parse(
  readZipEntry(archive, "extension/package.json").toString("utf8"),
);
if (
  embeddedPackage.name !== packageJson.name ||
  embeddedPackage.version !== packageJson.version
)
  throw new Error(
    `VSIX metadata does not match ${packageJson.name}@${packageJson.version}.`,
  );
if (embeddedPackage.extensionDependencies?.includes("GitHub.copilot"))
  throw new Error(
    "The VSIX must not require GitHub Copilot to use normal Markdown editing.",
  );
if (
  embeddedPackage.contributes?.commands?.some(
    (command) => command.command === "markdownMint.aiSuggestions.signIn",
  )
)
  throw new Error(
    "The VSIX still contributes the retired Copilot sign-in command.",
  );

const packageSize = (await stat(vsixPath)).size;
const sizeInMiB = (packageSize / 1024 / 1024).toFixed(2);
const unpackedSize = entries.reduce(
  (sum, entry) => sum + entry.uncompressedSize,
  0,
);
process.stdout.write(
  `VSIX verification passed: ${entries.length} files, ${packageSize} compressed bytes (${sizeInMiB} MiB), ${unpackedSize} uncompressed bytes.\n`,
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
    if (buffer.readUInt32LE(offset) !== 0x02014b50)
      throw new Error("Invalid VSIX central directory entry");
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraFieldLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    entries.push({
      name: buffer.toString("utf8", offset + 46, offset + 46 + fileNameLength),
      compressionMethod: buffer.readUInt16LE(offset + 10),
      compressedSize: buffer.readUInt32LE(offset + 20),
      uncompressedSize: buffer.readUInt32LE(offset + 24),
      localHeaderOffset: buffer.readUInt32LE(offset + 42),
      externalFileAttributes: buffer.readUInt32LE(offset + 38),
    });
    offset += 46 + fileNameLength + extraFieldLength + commentLength;
  }
  if (offset !== centralDirectoryEnd)
    throw new Error("Invalid VSIX central directory size");
  return entries;
}

function readZipEntry(buffer, name) {
  const entry = listZipEntries(buffer).find(
    (candidate) => candidate.name === name,
  );
  if (!entry) throw new Error(`VSIX is missing required entry: ${name}`);
  const local = entry.localHeaderOffset;
  const nameLength = buffer.readUInt16LE(local + 26);
  const extraLength = buffer.readUInt16LE(local + 28);
  const start = local + 30 + nameLength + extraLength;
  const payload = buffer.subarray(start, start + entry.compressedSize);
  if (entry.compressionMethod === 0) return payload;
  if (entry.compressionMethod === 8) return inflateRawSync(payload);
  throw new Error(`Unsupported VSIX compression method for ${name}.`);
}

function findEndOfCentralDirectory(buffer) {
  const minimumOffset = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1)
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  throw new Error("VSIX is missing the ZIP end-of-central-directory record");
}
