import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { existsSync } from "node:fs";
import { access, constants, readFile, realpath } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { basename, delimiter, dirname, join, resolve } from "node:path";

const markdownCssRelativePath = [
  "extensions",
  "markdown-language-features",
  "media",
  "markdown.css",
];

function installedCodeCandidates() {
  if (process.platform === "darwin")
    return [
      "/Applications/Visual Studio Code.app/Contents/MacOS/Code",
      "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
      "/Applications/Visual Studio Code - Insiders.app/Contents/MacOS/Code",
    ];
  if (process.platform === "win32")
    return [
      join(
        process.env.LOCALAPPDATA ?? "",
        "Programs",
        "Microsoft VS Code",
        "Code.exe",
      ),
      join(
        process.env.LOCALAPPDATA ?? "",
        "Programs",
        "Microsoft VS Code Insiders",
        "Code - Insiders.exe",
      ),
    ];
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .flatMap((directory) => [
      join(directory, "code"),
      join(directory, "code-insiders"),
    ]);
}

async function appRootsForExecutable(executablePath) {
  const appRoots = [];
  const executableDirectory = dirname(executablePath);
  // Recent Windows distributions keep resources under a commit-named folder.
  // The CLI launcher identifies the active folder even after an update leaves
  // older versions beside it. Read the launcher; never execute it here.
  for (const launcher of ["code.cmd", "code-insiders.cmd"]) {
    try {
      const script = await readFile(
        join(executableDirectory, "bin", launcher),
        "utf8",
      );
      const match = script.match(
        /%~dp0\.\.\\([0-9a-f]{10,40})\\resources\\app\\out\\cli\.js/iu,
      );
      if (match)
        appRoots.push(join(executableDirectory, match[1], "resources", "app"));
    } catch {
      // Legacy Windows, macOS, and Linux distributions use the roots below.
    }
  }
  let directory = dirname(executablePath);
  for (let depth = 0; depth < 8; depth += 1) {
    appRoots.push(
      join(directory, "resources", "app"),
      join(directory, "Resources", "app"),
      join(directory, "Contents", "Resources", "app"),
    );
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return [...new Set(appRoots)];
}

async function executableVersion(executablePath) {
  for (const appRoot of await appRootsForExecutable(executablePath)) {
    for (const filename of ["package.json", "product.json"]) {
      try {
        const metadata = JSON.parse(
          await readFile(join(appRoot, filename), "utf8"),
        );
        if (typeof metadata.version === "string") return metadata.version;
      } catch {
        // Continue through the selected VS Code distribution's metadata.
      }
    }
  }

  if (process.platform === "win32")
    throw new Error(
      "Could not find VS Code version metadata for " + executablePath,
    );

  let output;
  try {
    output = execFileSync(executablePath, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
  } catch (error) {
    throw new Error(
      "Could not read the VS Code version from " +
        executablePath +
        ": " +
        (error instanceof Error
          ? error.message +
            (error.stderr ? "\n" + String(error.stderr).trim() : "")
          : String(error)),
    );
  }
  return output.trim().split(/\r?\n/u)[0] || "unknown";
}

async function downloadedVSCodeExecutable(version) {
  const executablePath = await downloadAndUnzipVSCode(version);
  // Older test-electron versions return Electron for macOS bundles. Recent
  // VS Code releases name that executable Code (or Code - Insiders).
  if (
    !existsSync(executablePath) &&
    basename(executablePath) === "Electron" &&
    basename(dirname(executablePath)) === "MacOS"
  ) {
    for (const name of ["Code", "Code - Insiders"]) {
      const candidate = join(dirname(executablePath), name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return executablePath;
}

export async function resolveVSCodeExecutable(options = {}) {
  const explicitExecutable = process.env.MARKDOWN_MINT_CODE;
  const requestedVersion = process.env.MARKDOWN_MINT_VSCODE_VERSION;
  let executablePath;
  let selection;

  if (explicitExecutable) {
    executablePath = resolve(explicitExecutable);
    selection = "MARKDOWN_MINT_CODE";
  } else if (requestedVersion || options.forceDownload) {
    const version = requestedVersion ?? "stable";
    executablePath = await downloadedVSCodeExecutable(version);
    selection = "downloaded " + version;
  } else {
    executablePath = installedCodeCandidates().find((candidate) => {
      return existsSync(candidate);
    });
    if (executablePath) selection = "installed VS Code";
    else {
      executablePath = await downloadedVSCodeExecutable("stable");
      selection = "downloaded stable";
    }
  }

  if (!executablePath)
    throw new Error(
      "Could not find a VS Code executable. Set MARKDOWN_MINT_CODE to an executable path or MARKDOWN_MINT_VSCODE_VERSION to a version to download.",
    );
  try {
    await access(executablePath, constants.X_OK);
  } catch {
    throw new Error(
      "VS Code executable is missing or not executable: " + executablePath,
    );
  }

  const version = await executableVersion(executablePath);
  process.stdout.write(
    "VS Code version: " +
      version +
      " (" +
      selection +
      ")\nVS Code executable: " +
      executablePath +
      "\n",
  );
  return executablePath;
}

async function markdownCssForExecutable(executablePath) {
  let resolvedExecutable = resolve(executablePath);
  try {
    resolvedExecutable = await realpath(resolvedExecutable);
  } catch {
    // The executable itself is validated by resolveVSCodeExecutable().
  }

  for (const appRoot of await appRootsForExecutable(resolvedExecutable)) {
    const candidate = join(appRoot, ...markdownCssRelativePath);
    try {
      await access(candidate, constants.R_OK);
      return candidate;
    } catch {
      // Continue through the executable's containing application directories.
    }
  }
  return undefined;
}

export async function resolveVSCodeMarkdownCss() {
  const explicitCss = process.env.VSCODE_MARKDOWN_CSS;
  if (explicitCss) {
    const cssPath = resolve(explicitCss);
    try {
      await access(cssPath, constants.R_OK);
      process.stdout.write(
        "VS Code Markdown CSS: " + cssPath + " (VSCODE_MARKDOWN_CSS)\n",
      );
      return cssPath;
    } catch {
      throw new Error(
        "VSCODE_MARKDOWN_CSS points to a missing or unreadable file: " +
          cssPath,
      );
    }
  }

  let executablePath = await resolveVSCodeExecutable();
  let cssPath = await markdownCssForExecutable(executablePath);
  if (!cssPath && !process.env.MARKDOWN_MINT_CODE) {
    executablePath = await resolveVSCodeExecutable({ forceDownload: true });
    cssPath = await markdownCssForExecutable(executablePath);
  }
  if (!cssPath)
    throw new Error(
      "Could not find VS Code's markdown.css beside " +
        executablePath +
        ". Set VSCODE_MARKDOWN_CSS to the installed file or set MARKDOWN_MINT_CODE / MARKDOWN_MINT_VSCODE_VERSION to select a VS Code installation.",
    );
  process.stdout.write("VS Code Markdown CSS: " + cssPath + "\n");
  return cssPath;
}
