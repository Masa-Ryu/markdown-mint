import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const samples = 1000;
const fixtures = await Promise.all(
  [
    ["common-test.md", "commonmark"],
    ["github-test.md", "github"],
    ["github-test-class-B.md", "github"],
    ["gitlab-test.md", "gitlab"],
    ["gitlab-test-class-B.md", "gitlab"],
  ].map(async ([name, profile]) => ({
    name,
    profile,
    source: await readFile(resolve(repository, "tests/md", name), "utf8"),
  })),
);
fixtures.push(
  {
    name: "short English",
    profile: "github",
    source: "Writing a short sentence",
  },
  {
    name: "short Japanese",
    profile: "github",
    source: "短い日本語の文章を書いている",
  },
  {
    name: "5000 prose blocks",
    profile: "github",
    source: Array.from(
      { length: 5000 },
      (_, index) => `Paragraph ${index}`,
    ).join("\n\n"),
  },
  {
    name: "2000 table rows",
    profile: "github",
    source: "| A | B |\n|---|---|\n" + "| Cell | Value |\n".repeat(2000),
  },
);
const bundled = await build({
  stdin: {
    contents: `
import { EditorState, TextSelection } from "prosemirror-state";
import { parseMarkdown } from ${JSON.stringify(resolve(repository, "src/core/index.ts"))};
import { getSuggestionTarget, buildSuggestionContext } from ${JSON.stringify(resolve(repository, "src/webview/aiSuggestionContext.ts"))};
export const results = ${JSON.stringify(fixtures)}.map(({ name, source, profile }) => {
  // Parse/selection preparation is outside the measured debounce-time extraction.
  const doc = parseMarkdown(source + "\\n\\nBenchmark continuation", profile).doc;
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, doc.content.size - 1) });
  const extract = () => buildSuggestionContext(state, getSuggestionTarget(state));
  for (let i = 0; i < 100; i += 1) extract();
  const times = [];
  let units = 0;
  for (let i = 0; i < ${samples}; i += 1) {
    const start = performance.now();
    const context = extract();
    times.push(performance.now() - start);
    if (!context) throw Error("Missing benchmark context");
    units = context.before.length + context.after.length + context.heading.length;
    if (units > 6000) throw Error("Context budget exceeded");
  }
  times.sort((a, b) => a - b);
  return { name, sourceUnits: source.length, contextUnits: units,
    p50Ms: times[Math.floor(times.length * 0.5)], p95Ms: times[Math.floor(times.length * 0.95)] };
});`,
    loader: "js",
    resolveDir: repository,
    sourcefile: "benchmark-ai-suggestions-entry.mjs",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  write: false,
  logLevel: "silent",
  loader: { ".svg": "text" },
});
const source = bundled.outputFiles[0]?.text;
if (!source) throw Error("Failed to bundle context benchmark");
const { results } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);
const report = {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  samples,
  realCopilotRequests: 0,
  measured:
    "debounce-time context extraction only; parsing and model latency excluded",
  results,
};
const output = resolve(repository, "output/benchmarks/ai-suggestions");
await mkdir(output, { recursive: true });
await writeFile(
  resolve(output, "context.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
