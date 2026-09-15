import { build } from "esbuild";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sharedModule = resolve(repository, "src/shared/workspaceFileSearch.ts");
const samples = Math.max(
  20,
  Number.parseInt(process.env.MM_FILE_SEARCH_BENCHMARK_SAMPLES ?? "100", 10),
);

const entry = `
import {
  createWorkspaceFileSearchIndex,
  WorkspaceFileSearch,
} from ${JSON.stringify(sharedModule)};

const sizes = [1000, 10000, 50000];
const samples = ${JSON.stringify(samples)};
const documentPath = "/workspace/docs/search.md";
const workspaceFolderPath = "/workspace";
const query = "bmk";
const scenarios = [
  { name: "Link modal", filter: "all" },
  { name: "Image modal", filter: "image" },
  { name: "selected-text picker", filter: "all" },
];

function filesForSize(size) {
  return Array.from({ length: size }, (_, index) => {
    const group = String(Math.floor(index / 100)).padStart(3, "0");
    const number = String(index).padStart(5, "0");
    const extension = index % 2 === 0 ? ".png" : ".md";
    return { path: "/workspace/docs/benchmark/" + group + "/benchmark-" + number + extension };
  });
}

function percentile(values, fraction) {
  const index = (values.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return values[lower] ?? 0;
  const weight = index - lower;
  return (values[lower] ?? 0) + ((values[upper] ?? 0) - (values[lower] ?? 0)) * weight;
}

function summarize(values) {
  const sorted = values.slice().sort((left, right) => left - right);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1) ?? 0,
    over100: values.filter((value) => value > 100).length,
  };
}

function formatMilliseconds(value) {
  return value.toFixed(3);
}

const search = new WorkspaceFileSearch();
const rows = [];
for (const size of sizes) {
  const files = filesForSize(size);
  const warmupStart = performance.now();
  const index = createWorkspaceFileSearchIndex(workspaceFolderPath, files);
  const warmupMilliseconds = performance.now() - warmupStart;
  for (const scenario of scenarios) {
    const options = {
      documentPath,
      workspaceFolderPath,
      files: [],
      query,
      filter: scenario.filter,
      index,
    };
    for (let index = 0; index < 20; index += 1) search.search(options);
    const timings = [];
    for (let index = 0; index < samples; index += 1) {
      const start = performance.now();
      const candidates = search.search(options);
      timings.push(performance.now() - start);
      if (candidates.length === 0) throw new Error("benchmark query returned no candidates");
    }
    rows.push({ size, scenario: scenario.name, warmupMilliseconds, ...summarize(timings) });
  }
}

console.log("Workspace file search benchmark (cache-warm shared ranking)");
console.log("The index build is outside the measured query samples.");
console.log("Samples: " + samples + ", query: " + query + " (filename fuzzy query)");
console.log("");
console.log("| files | surface | index warm-up ms | p50 ms | p95 ms | p99 ms | max ms | >100ms |");
console.log("| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const row of rows) {
  console.log(
    "| " + row.size + " | " + row.scenario + " | " +
      formatMilliseconds(row.warmupMilliseconds) + " | " +
      formatMilliseconds(row.p50) + " | " +
      formatMilliseconds(row.p95) + " | " +
      formatMilliseconds(row.p99) + " | " +
      formatMilliseconds(row.max) + " | " + row.over100 + " |",
  );
}
`;

const bundled = await build({
  stdin: {
    contents: entry,
    loader: "js",
    resolveDir: repository,
    sourcefile: "benchmark-workspace-file-search-entry.mjs",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  write: false,
  logLevel: "silent",
});

const source = bundled.outputFiles[0]?.text;
if (!source)
  throw new Error("Failed to bundle workspace file search benchmark");
await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);
