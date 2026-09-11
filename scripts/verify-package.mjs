import { cp, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Module from "node:module";

const requiredAssets = [
  "dist/mermaid.js",
  "dist/katex/katex.css",
  "dist/katex/fonts/KaTeX_Main-Regular.woff2",
];
for (const asset of requiredAssets) {
  if (!existsSync(asset))
    throw new Error("Missing packaged rendering asset: " + asset);
}

const packageDir = await mkdtemp(join(tmpdir(), "markdown-mint-package-"));
const bundlePath = join(packageDir, "extension.js");
await cp("dist/extension.js", bundlePath);

// The VS Code API is intentionally external in the VSIX. Mock only that host
// module so this check exercises the bundled core and formatter with no package
// dependencies visible from the temporary directory.
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "vscode")
    return new Proxy(
      {},
      {
        get: (_target, property) => {
          if (property === "Uri") return class Uri {};
          return () => undefined;
        },
      },
    );
  return originalLoad.call(this, request, parent, isMain);
};

try {
  const extension = await import(bundlePath);
  const input = "# A heading";
  const output = await extension.formatMarkdownDocument(input, "github", {
    printWidth: 20,
    proseWrap: "always",
  });
  if (output === input || !output.includes("# A heading")) {
    throw new Error(
      "Bundled formatter did not produce a validated formatting change.",
    );
  }
  process.stdout.write("Bundled formatter verification passed.\n");
} finally {
  Module._load = originalLoad;
  await rm(packageDir, { recursive: true, force: true });
}
