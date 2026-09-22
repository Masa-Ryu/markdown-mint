import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const editAnchor = "Performance edit anchor.";

function bytes(source) {
  return Buffer.byteLength(source, "utf8");
}

function metadata(source, extra = {}) {
  return {
    bytes: bytes(source),
    lines: source.split(/\r\n|\n|\r/).length,
    topLevelBlocks: source.split(/\n\s*\n/).filter(Boolean).length,
    ...extra,
  };
}

function largeNormalMarkdown() {
  const paragraphs = [];
  let size = 0;
  let index = 0;
  while (size < 100 * 1024) {
    const paragraph = `Paragraph ${String(index + 1).padStart(4, "0")}: Markdown Mint performance baseline with several inline words, punctuation, and stable text for repeatable parsing.`;
    paragraphs.push(paragraph);
    size += bytes(`${paragraph}\n\n`);
    index += 1;
  }
  paragraphs.push(editAnchor);
  return paragraphs.join("\n\n");
}

function codeHeadingFootnoteMarkdown() {
  const sections = [];
  const definitions = [];
  for (let index = 1; index <= 100; index += 1) {
    const label = String(index).padStart(3, "0");
    const level = ((index - 1) % 5) + 2;
    sections.push(
      [
        `${"#".repeat(level)} Section ${label}`,
        `This section links a reference note[^note-${label}] and keeps repeated inline **formatting** in the parse path.`,
        "```ts",
        `export function transform${label}(input: string): string {`,
        `  const normalized = input.trim().replace(/\\s+/g, " ");`,
        `  return normalized + ":${label}";`,
        "}",
        "```",
      ].join("\n"),
    );
    definitions.push(
      `[^note-${label}]: Footnote ${label} records a stable reference body for the benchmark fixture.`,
    );
  }
  return [sections.join("\n\n"), editAnchor, definitions.join("\n")].join(
    "\n\n",
  );
}

function tableMarkdown(bodyRows, columns) {
  const headers = Array.from(
    { length: columns },
    (_, index) => `Column ${index + 1}`,
  );
  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
  ];
  for (let row = 1; row <= bodyRows; row += 1) {
    lines.push(
      `| ${headers.map((_, column) => `R${row}C${column + 1}`).join(" | ")} |`,
    );
  }
  return `${lines.join("\n")}\n\n${editAnchor}`;
}

export async function getPerformanceScenarios() {
  const stressSource = await readFile(
    resolve(
      repository,
      "tests/github-markdown-test-suite/stress/github-table-2000x20.md",
    ),
    "utf8",
  );
  const stressTableRows = stressSource
    .split(/\r\n|\n|\r/)
    .filter((line) => line.startsWith("|"));
  const stressHeader = stressTableRows[0] ?? "";
  const stressColumnCount = stressHeader.split("|").length - 2;
  const stressBodyRows = Math.max(0, stressTableRows.length - 2);
  const scenarios = [
    {
      id: "small-normal",
      category: "ordinary",
      profile: "github",
      markdown: [
        "# Small benchmark document",
        "",
        "A short paragraph with **bold text**, a [link](https://example.com), and stable punctuation.",
        "",
        "- First item",
        "- Second item",
        "",
        editAnchor,
      ].join("\n"),
    },
    {
      id: "normal-100kb-many-blocks",
      category: "ordinary",
      profile: "github",
      markdown: largeNormalMarkdown(),
    },
    {
      id: "code-heading-footnote-heavy",
      category: "ordinary",
      profile: "github",
      markdown: codeHeadingFootnoteMarkdown(),
    },
    {
      id: "large-table-100x10",
      category: "ordinary",
      profile: "github",
      markdown: tableMarkdown(100, 10),
      table: { bodyRows: 100, columns: 10 },
    },
    {
      id: "stress-table-2000x20",
      category: "stress-only",
      profile: "github",
      markdown: stressSource,
      table: { bodyRows: stressBodyRows, columns: stressColumnCount },
    },
  ];

  return scenarios.map((scenario) => ({
    ...scenario,
    metadata: metadata(scenario.markdown, {
      ...(scenario.table ? { table: scenario.table } : {}),
    }),
  }));
}
