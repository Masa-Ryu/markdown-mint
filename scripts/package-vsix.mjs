import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const root = process.cwd();
const packageMetadata = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);
const serverMetadata = JSON.parse(
  await readFile(
    join(root, "scripts/copilot-language-server-packages.json"),
    "utf8",
  ),
);
const sdkLicense = await readFile(
  join(root, serverMetadata.license.file),
  "utf8",
);
const sdkLicenseSha256 = createHash("sha256").update(sdkLicense).digest("hex");
if (
  sdkLicenseSha256 !== serverMetadata.license.sha256 ||
  !sdkLicense.includes("MIT License")
)
  throw new Error(
    "The vendored Copilot Language Server license does not match its pinned SHA-256 or MIT identifier.",
  );
const targetNames = Object.keys(serverMetadata.packages);
const requested =
  process.argv
    .find((argument) => argument.startsWith("--target="))
    ?.slice("--target=".length) ??
  process.argv[process.argv.indexOf("--target") + 1];
const targets =
  requested === "local"
    ? [`${process.platform}-${process.arch}`]
    : requested === "all"
      ? targetNames
      : [requested];
if (!targets.length || targets.some((target) => !targetNames.includes(target)))
  throw new Error(
    `Unsupported Copilot Language Server target: ${String(requested)}`,
  );

const baseNotices = await readFile(
  join(root, "dist/THIRD_PARTY_NOTICES.txt"),
  "utf8",
);
for (const target of targets) {
  const packageInfo = serverMetadata.packages[target];
  const packageName = `@github/copilot-language-server-${target}`;
  const packageSpec = `${packageName}@${serverMetadata.version}`;
  const scratch = await mkdtemp(
    join(tmpdir(), "markdown-mint-copilot-package-"),
  );
  try {
    const packOutput = execFileSync(
      "npm",
      ["pack", packageSpec, "--json", "--pack-destination", scratch],
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    const packed = JSON.parse(packOutput)[0];
    if (
      packed?.name !== packageName ||
      packed.version !== serverMetadata.version ||
      packed.integrity !== packageInfo.integrity
    )
      throw new Error(
        `The published metadata for ${packageSpec} did not match the pinned package.`,
      );
    const tarball = join(scratch, basename(packed.filename));
    const actualIntegrity = `sha512-${createHash("sha512")
      .update(await readFile(tarball))
      .digest("base64")}`;
    if (actualIntegrity !== packageInfo.integrity)
      throw new Error(
        `The downloaded ${packageSpec} archive failed its pinned SHA-512 check.`,
      );

    const extracted = join(scratch, "unpacked");
    await mkdir(extracted);
    execFileSync(
      "tar",
      [
        "-xzf",
        tarball,
        "-C",
        extracted,
        `package/${packageInfo.binary}`,
        "package/package.json",
      ],
      { stdio: "pipe" },
    );
    const serverBinary = join(extracted, "package", packageInfo.binary);
    const sdkPackage = JSON.parse(
      await readFile(join(extracted, "package/package.json"), "utf8"),
    );
    if (
      sdkPackage.name !== packageName ||
      sdkPackage.version !== serverMetadata.version ||
      sdkPackage.license !== "MIT"
    )
      throw new Error(
        `${packageSpec} metadata did not match the pinned SDK manifest.`,
      );
    const binaryInfo = await stat(serverBinary);
    if (!binaryInfo.isFile() || binaryInfo.size === 0)
      throw new Error(
        `${packageSpec} did not contain a non-empty native executable.`,
      );
    if (!target.startsWith("win32-") && (binaryInfo.mode & 0o111) === 0)
      throw new Error(
        `${packageSpec} native executable is missing its executable mode.`,
      );

    await rm(join(root, "dist/copilot"), { recursive: true, force: true });
    const targetDirectory = join(root, "dist/copilot", target);
    await mkdir(targetDirectory, { recursive: true });
    const destinationBinary = join(targetDirectory, packageInfo.binary);
    await copyFile(serverBinary, destinationBinary);
    if (!target.startsWith("win32-")) await chmod(destinationBinary, 0o755);
    await copyFile(
      join(root, serverMetadata.license.file),
      join(targetDirectory, "LICENSE"),
    );
    const licenseNotice = [
      `GitHub Copilot Language Server ${serverMetadata.version} (${target})`,
      `Package: ${packageName}@${serverMetadata.version}`,
      `Source: ${serverMetadata.license.source}`,
      `License: MIT`,
      "",
      sdkLicense.trimEnd(),
      "",
    ].join("\n");
    await writeFile(
      join(root, "dist/THIRD_PARTY_NOTICES.txt"),
      `${baseNotices}\n${licenseNotice}`,
      "utf8",
    );

    const output = join(
      root,
      `${packageMetadata.name}-${packageMetadata.version}-${target}.vsix`,
    );
    await rm(output, { force: true });
    execFileSync(
      process.execPath,
      [
        join(root, "node_modules/@vscode/vsce/vsce"),
        "package",
        "--no-dependencies",
        "--target",
        target,
        "--out",
        output,
      ],
      {
        cwd: root,
        stdio: "inherit",
      },
    );
    const vsixSize = (await stat(output)).size;
    process.stdout.write(
      `Packaged ${target}: ${basename(output)} (${vsixSize} bytes; SDK ${packed.unpackedSize ?? "unknown"} bytes unpacked before VSIX compression).\n`,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
