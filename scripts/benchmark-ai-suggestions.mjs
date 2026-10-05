import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
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
    source: "A useful sentence has a middle and an ending.",
  },
  {
    name: "short Japanese",
    profile: "github",
    source: "日本語の文章では位置を正確に保ちます。",
  },
  {
    name: "5,000 prose blocks",
    profile: "github",
    source: Array.from(
      { length: 5000 },
      (_, index) => `Paragraph ${index}`,
    ).join("\n\n"),
  },
  {
    name: "2,000 table rows",
    profile: "github",
    source: "| A | B |\n|---|---|\n" + "| Cell | Value |\n".repeat(2000),
  },
);

const bundled = await build({
  stdin: {
    contents: `
import { TextSelection } from "prosemirror-state";
import { parseMarkdown, serializeMarkdown } from ${JSON.stringify(resolve(repository, "src/core/index.ts"))};
import { MarkdownPositionMapCache } from ${JSON.stringify(resolve(repository, "src/core/markdownPositionMap.ts"))};
import { matchCompletionInput, planCompletionInsertion } from ${JSON.stringify(resolve(repository, "src/core/inlineCompletion.ts"))};
import { buildCompletionContext } from ${JSON.stringify(resolve(repository, "src/extension/aiSuggestionPrompt.ts"))};
import { getSuggestionTarget } from ${JSON.stringify(resolve(repository, "src/webview/aiSuggestionContext.ts"))};
export const results = ${JSON.stringify(fixtures)}.map(({ name, source, profile }) => {
  const markdown = source + "\\n\\nBenchmark continuation prose";
  const snapshot = parseMarkdown(markdown, profile);
  let cursor = -1;
  snapshot.doc.descendants((node, position) => {
    if (node.type.name === "paragraph" && node.textContent.trim()) {
      const text = node.textContent;
      const offset = Math.min(Math.max(1, Math.floor(text.length / 2)), text.length);
      cursor = position + 1 + offset;
    }
  });
  if (cursor < 0) cursor = Math.max(1, snapshot.doc.content.size - 1);
  const state = { doc: snapshot.doc, selection: TextSelection.create(snapshot.doc, cursor), storedMarks: null };
  const target = getSuggestionTarget(state);
  const samples = source.length > 100_000 ? 2 : source.length > 20_000 ? 5 : 25;
  const times = [];
  let accepted = false;
  let mappedOffset;
  const bridge = { parseMarkdown, serializeMarkdown };
  const mapCache = new MarkdownPositionMapCache();
  let coldPositionMapMs = 0;
  let cachedPositionMapLookupMs = 0;
  if (target) {
    const coldStart = performance.now();
    const initialMap = mapCache.get(markdown, snapshot.doc, profile, bridge, snapshot, 1);
    mappedOffset = initialMap.pmPositionToSourceOffset(target.position);
    coldPositionMapMs = performance.now() - coldStart;
    const cachedStart = performance.now();
    const reusedMap = mapCache.get(markdown, snapshot.doc, profile, bridge, snapshot, 1);
    reusedMap.pmPositionToSourceOffset(target.position);
    cachedPositionMapLookupMs = performance.now() - cachedStart;
  }
  const measure = () => {
    if (!target) return false;
    const map = mapCache.get(markdown, snapshot.doc, profile, bridge, snapshot, 1);
    mappedOffset = map.pmPositionToSourceOffset(target.position);
    if (mappedOffset === undefined) return false;
    const context = buildCompletionContext(markdown, mappedOffset, target.kind);
    if (!context) return false;
    const completion = " continued";
    const match = matchCompletionInput(completion, completion.slice(0, Math.min(2, completion.length)));
    if (!match) return false;
    const plan = planCompletionInsertion(markdown, snapshot.doc, mappedOffset, target.position, completion, profile, { parseMarkdown });
    accepted = Boolean(plan);
    return true;
  };
  for (let i = 0; i < samples; i += 1) {
    const start = performance.now();
    measure();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return { name, sourceUnits: source.length, documentUnits: markdown.length, samples, candidatePlanned: accepted, mappedOffset, coldPositionMapMs, cachedPositionMapLookupMs,
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
if (!source) throw Error("Failed to bundle the inline-completion benchmark");
const { results } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);
const report = {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  realCopilotRequests: 0,
  measured:
    "local Markdown position mapping, context construction, insertion safety planning, and matching-input reconciliation; model latency and network usage excluded",
  results,
};
const output = resolve(repository, "output/benchmarks/ai-suggestions");
await mkdir(output, { recursive: true });
await writeFile(
  resolve(output, "inline-completion.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
