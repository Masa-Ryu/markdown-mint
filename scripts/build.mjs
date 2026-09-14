import { build, context } from "esbuild";
import { existsSync, mkdirSync } from "node:fs";
import { cp, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { writeThirdPartyNotices } from "./third-party-notices.mjs";

const watch = process.argv.includes("--watch");
const extensionOnly = process.argv.includes("--extension-only");
const webviewOnly = process.argv.includes("--webview-only");

mkdirSync("dist", { recursive: true });

const require = createRequire(import.meta.url);
const mermaidPackagePath = require.resolve("mermaid/package.json");
const mermaidPackage = JSON.parse(await readFile(mermaidPackagePath, "utf8"));
if (typeof mermaidPackage.version !== "string" || !mermaidPackage.version)
  throw new Error("The installed Mermaid package does not declare a version.");
const mermaidVersion = mermaidPackage.version;

async function copyRenderingAssets() {
  await mkdir("dist/katex/fonts", { recursive: true });
  await cp("node_modules/katex/dist/katex.min.css", "dist/katex/katex.css");
  await cp("node_modules/katex/dist/fonts", "dist/katex/fonts", {
    recursive: true,
  });
}

await copyRenderingAssets();
await writeThirdPartyNotices();

const extensionOptions = {
  entryPoints: ["src/extension/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
  sourcemap: true,
  minify: false,
  legalComments: "none",
  loader: { ".svg": "text" },
};

const webviewOptions = {
  entryPoints: ["src/webview/main.ts"],
  bundle: true,
  outfile: "dist/webview.js",
  platform: "browser",
  format: "iife",
  target: "es2022",
  sourcemap: true,
  minify: false,
  legalComments: "none",
  loader: { ".svg": "text" },
};

const integrationOptions = {
  entryPoints: ["tests/extension/integration/index.ts"],
  bundle: true,
  outfile: "dist/test-extension.js",
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
  sourcemap: true,
  minify: false,
  legalComments: "none",
};

const mermaidOptions = {
  entryPoints: ["src/webview/mermaidRuntime.ts"],
  bundle: true,
  outfile: "dist/mermaid.js",
  platform: "browser",
  format: "iife",
  target: "es2022",
  sourcemap: true,
  minify: false,
  legalComments: "none",
  define: {
    __MERMAID_VERSION__: JSON.stringify(mermaidVersion),
  },
};

async function buildOne(options) {
  if (watch) {
    const buildContext = await context(options);
    await buildContext.watch();
    return buildContext;
  }
  await build(options);
  return undefined;
}

const contexts = [];
if (!webviewOnly) contexts.push(await buildOne(extensionOptions));
if (!extensionOnly) {
  if (!existsSync("src/webview/main.ts")) {
    throw new Error(
      "src/webview/main.ts is required to build the extension package.",
    );
  }
  contexts.push(await buildOne(webviewOptions));
  contexts.push(await buildOne(mermaidOptions));
  if (!watch) {
    if (!existsSync("tests/extension/integration/index.ts")) {
      throw new Error(
        "tests/extension/integration/index.ts is required for the native extension test runner.",
      );
    }
    contexts.push(await buildOne(integrationOptions));
  }
}

if (watch) {
  process.stdout.write("Watching extension and webview bundles.\n");
  process.on("SIGINT", async () => {
    await Promise.all(
      contexts.filter(Boolean).map((buildContext) => buildContext.dispose()),
    );
    process.exit(0);
  });
  await new Promise(() => undefined);
}
