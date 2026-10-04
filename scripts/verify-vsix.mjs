import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { join } from "node:path";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const copilotManifest = JSON.parse(
  await readFile("scripts/copilot-language-server-packages.json", "utf8"),
);
const serverVersion = copilotManifest.version;
const extensionIcon = "extension/assets/icon/icon.png";
if (packageJson.icon !== "assets/icon/icon.png") {
  throw new Error(
    "package.json must register assets/icon/icon.png as its icon",
  );
}
const supportedTargets = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
];
const targetArgument =
  process.argv
    .find((argument) => argument.startsWith("--target="))
    ?.slice("--target=".length) ??
  process.argv[process.argv.indexOf("--target") + 1];
const targets =
  targetArgument === "all"
    ? supportedTargets
    : targetArgument === "local"
      ? [`${process.platform}-${process.arch}`]
      : [targetArgument];
if (targets.some((target) => !supportedTargets.includes(target)))
  throw new Error(`Unsupported VSIX target: ${String(targetArgument)}`);

for (const target of targets) await verifyTarget(target);

async function verifyTarget(target) {
  const vsixPath = join(
    process.cwd(),
    `${packageJson.name}-${packageJson.version}-${target}.vsix`,
  );

  if (!existsSync(vsixPath)) {
    throw new Error(`Missing VSIX artifact: ${vsixPath}`);
  }

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
    `extension/dist/copilot/${target}/${target.startsWith("win32-") ? "copilot-language-server.exe" : "copilot-language-server"}`,
    `extension/dist/copilot/${target}/LICENSE`,
    "extension/dist/THIRD_PARTY_NOTICES.txt",
  ];
  for (const entry of requiredEntries) {
    if (!entryNames.includes(entry)) {
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
  const forbiddenEntries = entryNames.filter(
    (entry) =>
      forbiddenPrefixes.some((prefix) => entry.startsWith(prefix)) ||
      entry.startsWith("extension/dist/test-") ||
      (entry.startsWith("extension/dist/copilot/") &&
        !entry.startsWith(`extension/dist/copilot/${target}/`)) ||
      entry.endsWith(".svg") ||
      entry.endsWith("demo1.gif"),
  );
  const unexpectedAssetEntries = entryNames.filter(
    (entry) =>
      entry.startsWith("extension/assets/") &&
      !entry.endsWith("/") &&
      entry !== extensionIcon,
  );
  forbiddenEntries.push(...unexpectedAssetEntries);
  const embeddedChromiumEntries = entryNames.filter((entry) =>
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

  const packageSize = (await stat(vsixPath)).size;
  const sizeInMiB = (packageSize / 1024 / 1024).toFixed(2);
  const unpackedSize = entries.reduce(
    (sum, entry) => sum + entry.uncompressedSize,
    0,
  );
  const manifest = readZipEntry(archive, "extension.vsixmanifest").toString(
    "utf8",
  );
  if (!manifest.includes(`TargetPlatform="${target}"`))
    throw new Error(
      `VSIX metadata does not declare target platform ${target}.`,
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
  const binaryName = `extension/dist/copilot/${target}/${target.startsWith("win32-") ? "copilot-language-server.exe" : "copilot-language-server"}`;
  const binary = entries.find((entry) => entry.name === binaryName);
  if (!binary) throw new Error(`VSIX is missing native binary ${binaryName}.`);
  if (
    !target.startsWith("win32-") &&
    ((binary.externalFileAttributes >>> 16) & 0o111) === 0
  )
    throw new Error(
      `VSIX native binary ${binaryName} is missing executable mode bits.`,
    );
  const license = readZipEntry(
    archive,
    `extension/dist/copilot/${target}/LICENSE`,
  ).toString("utf8");
  const notices = readZipEntry(
    archive,
    "extension/dist/THIRD_PARTY_NOTICES.txt",
  ).toString("utf8");
  const licenseSha256 = createHash("sha256").update(license).digest("hex");
  if (
    licenseSha256 !== copilotManifest.license.sha256 ||
    !license.includes("MIT License") ||
    !notices.includes(`GitHub Copilot Language Server ${serverVersion}`) ||
    !notices.includes(copilotManifest.license.source)
  )
    throw new Error(
      `VSIX is missing verified Copilot Language Server license notices for ${target}.`,
    );
  process.stdout.write(
    `VSIX verification passed (${target}): ${entries.length} files, ${packageSize} compressed bytes (${sizeInMiB} MiB), ${unpackedSize} uncompressed bytes.\n`,
  );
}

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

  if (offset !== centralDirectoryEnd) {
    throw new Error("Invalid VSIX central directory size");
  }
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
  const signature = 0x06054b50;
  const minimumOffset = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) return offset;
  }
  throw new Error("VSIX is missing the ZIP end-of-central-directory record");
}
