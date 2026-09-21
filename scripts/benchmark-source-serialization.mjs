import { build } from "esbuild";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
const blockCount = Math.max(
  100,
  Number.parseInt(process.env.MM_SOURCE_SERIALIZATION_BLOCKS ?? "5000", 10),
);
const samples = Math.max(
  5,
  Number.parseInt(process.env.MM_SOURCE_SERIALIZATION_SAMPLES ?? "20", 10),
);
const coreModule = resolve(repository, "src/core/index.ts");

const entry = `
import { Node as PMNode } from "prosemirror-model";
import {
  parseMarkdown,
  schema,
  serializeMarkdown,
} from ${JSON.stringify(coreModule)};

const blockCount = ${JSON.stringify(blockCount)};
const samples = ${JSON.stringify(samples)};
const source = Array.from(
  { length: blockCount },
  (_, index) => "paragraph " + index,
).join("\\n\\n") + "\\n";
const snapshot = parseMarkdown(source);
const originalChildren = [];
snapshot.doc.forEach((child) => originalChildren.push(child));
const changedChildren = originalChildren.slice();
changedChildren[Math.floor(blockCount / 2)] = schema.nodes.paragraph.create(
  null,
  schema.text("updated"),
);
const warmDocument = schema.topNodeType.create(null, changedChildren);

function coldDocument() {
  return schema.topNodeType.create(
    null,
    changedChildren.map((node) => schema.nodeFromJSON(node.toJSON())),
  );
}

function percentile(values, fraction) {
  const sorted = values.slice().sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower] ?? 0;
  const weight = position - lower;
  return (
    (sorted[lower] ?? 0) +
    ((sorted[upper] ?? 0) - (sorted[lower] ?? 0)) * weight
  );
}

let toJSONCalls = 0;
const originalToJSON = PMNode.prototype.toJSON;
PMNode.prototype.toJSON = function () {
  toJSONCalls += 1;
  return originalToJSON.call(this);
};

const expected = serializeMarkdown(warmDocument, snapshot);
for (let index = 0; index < 5; index += 1)
  serializeMarkdown(warmDocument, snapshot);

function measure(name, createDocument) {
  const timings = [];
  let calls = 0;
  for (let index = 0; index < samples; index += 1) {
    const document = createDocument();
    toJSONCalls = 0;
    const started = performance.now();
    const serialized = serializeMarkdown(document, snapshot);
    timings.push(performance.now() - started);
    calls += toJSONCalls;
    if (serialized !== expected)
      throw new Error(name + " serialization changed source output");
  }
  return {
    name,
    p50: percentile(timings, 0.5),
    p95: percentile(timings, 0.95),
    toJSONCalls: calls,
  };
}

const results = [
  measure("warm (reused node identities)", () => warmDocument),
  measure("cold (new node identities)", coldDocument),
];

console.log("Source-preserving serialization benchmark");
console.log(
  "Blocks: " + blockCount + ", samples: " + samples +
    ", one changed middle paragraph",
);
console.log("");
console.log("| scenario | p50 ms | p95 ms | toJSON calls |");
console.log("| --- | ---: | ---: | ---: |");
for (const result of results) {
  console.log(
    "| " + result.name + " | " + result.p50.toFixed(3) + " | " +
      result.p95.toFixed(3) + " | " + result.toJSONCalls + " |",
  );
}
`;

const bundled = await build({
  stdin: {
    contents: entry,
    loader: "js",
    resolveDir: repository,
    sourcefile: "benchmark-source-serialization-entry.mjs",
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
if (!source) throw new Error("Failed to bundle source serialization benchmark");
await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);
