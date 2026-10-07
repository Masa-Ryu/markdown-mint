import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

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
  "extension/media/export.css",
];
for (const entry of requiredEntries) {
  if (!entries.includes(entry)) {
    throw new Error(`VSIX is missing required entry: ${entry}`);
  }
}
const packagedReadmePath = entries.find(
  (entry) => entry.toLowerCase() === "extension/readme.md",
);
if (!packagedReadmePath)
  throw new Error("VSIX is missing its packaged README.");

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
    entry.startsWith("extension/dist/test-") ||
    entry.endsWith(".svg") ||
    entry.endsWith("demo1.gif") ||
    /\.(?:gif|webm|mp4)$/i.test(entry),
);
const unexpectedAssetEntries = entries.filter(
  (entry) =>
    entry.startsWith("extension/assets/") &&
    !entry.endsWith("/") &&
    entry !== extensionIcon,
);
forbiddenEntries.push(...unexpectedAssetEntries);
const embeddedChromiumEntries = entries.filter((entry) =>
  /(?:^|\/)(?:chrome|chromium|chrome-headless-shell|headless_shell)(?:\.exe)?$/i.test(
    entry,
  ),
);
forbiddenEntries.push(...embeddedChromiumEntries);
if (forbiddenEntries.length > 0) {
  throw new Error(
    `VSIX contains repository-only or build-embedded assets:\n${forbiddenEntries.join("\n")}`,
  );
}

const packagedReadme = readZipEntry(archive, packagedReadmePath).toString(
  "utf8",
);
verifyPackagedReadmeMedia(packagedReadme);

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

function readZipEntry(buffer, targetName) {
  const endOfCentralDirectory = findEndOfCentralDirectory(buffer);
  const centralDirectorySize = buffer.readUInt32LE(endOfCentralDirectory + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(
    endOfCentralDirectory + 16,
  );
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  let offset = centralDirectoryOffset;

  while (offset < centralDirectoryEnd) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50)
      throw new Error("Invalid VSIX central directory entry");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraFieldLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileName = buffer.toString(
      "utf8",
      offset + 46,
      offset + 46 + fileNameLength,
    );
    if (fileName === targetName) {
      if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50)
        throw new Error(`Invalid VSIX local entry for ${targetName}`);
      const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
      const contentOffset =
        localHeaderOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.subarray(
        contentOffset,
        contentOffset + compressedSize,
      );
      const content =
        method === 0
          ? compressed
          : method === 8
            ? inflateRawSync(compressed)
            : null;
      if (!content)
        throw new Error(`Unsupported VSIX compression method: ${method}`);
      if (content.length !== uncompressedSize)
        throw new Error(`Invalid VSIX content size for ${targetName}`);
      return content;
    }
    offset += 46 + fileNameLength + extraFieldLength + commentLength;
  }
  throw new Error(`VSIX is missing required entry: ${targetName}`);
}

function verifyPackagedReadmeMedia(readme) {
  const images = Array.from(
    readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g),
    (match) => match[1],
  );
  const mediaImages = images.filter((image) => image.includes("docs/media/"));
  if (mediaImages.length === 0)
    throw new Error(
      "Packaged README has no public docs/media image references.",
    );
  const publicPrefix =
    "https://raw.githubusercontent.com/Masa-Ryu/markdown-mint/main/docs/media/";
  for (const image of mediaImages) {
    if (!image.startsWith(publicPrefix))
      throw new Error(
        `Packaged README image must use the repository's public media URL: ${image}`,
      );
    const relativePath = decodeURIComponent(image.slice(publicPrefix.length));
    if (
      relativePath.length === 0 ||
      relativePath.includes("/") ||
      !existsSync(join(process.cwd(), "docs", "media", relativePath))
    )
      throw new Error(`Packaged README media target is missing: ${image}`);
  }
}

function findEndOfCentralDirectory(buffer) {
  const signature = 0x06054b50;
  const minimumOffset = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) return offset;
  }
  throw new Error("VSIX is missing the ZIP end-of-central-directory record");
}
