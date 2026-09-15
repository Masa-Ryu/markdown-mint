import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseMarkdown, schema, serializeMarkdown } from "../../src/core";
import { MAX_CLIPBOARD_TEXT_LENGTH } from "../../src/shared/protocol";
import {
  createTableNodeFromMatrix,
  detectSpreadsheetPaste,
  hasClipboardTableMarkup,
  matrixToTsv,
  parseClipboardHtml,
  parseClipboardHtmlWithStatus,
  parseTsv,
  parseTsvWithStatus,
  validateClipboardMatrix,
} from "../../src/webview/tableClipboard";

describe("table clipboard parsing", () => {
  it("recognizes table start-tag boundaries including a trailing slash", () => {
    expect(hasClipboardTableMarkup("<table/>")).toBe(true);
    expect(hasClipboardTableMarkup("<table />")).toBe(true);
    expect(hasClipboardTableMarkup("<table>\n")).toBe(true);
    expect(hasClipboardTableMarkup("<tablefoo>")).toBe(false);
    expect(hasClipboardTableMarkup("<table-custom>")).toBe(false);
  });

  it("preserves displayed strings, quotes, CRLF rows, and literal punctuation", () => {
    expect(
      parseTsv('00123\t2026/09/14\r\n"a""b"\tA|B\r\n<&>\t日本語'),
    ).toMatchObject({
      values: [
        ["00123", "2026/09/14"],
        ['a"b', "A|B"],
        ["<&>", "日本語"],
      ],
      rows: 3,
      columns: 2,
    });
    expect(parseTsv('a"b\tc')).toMatchObject({
      values: [['a"b', "c"]],
      rows: 1,
      columns: 2,
    });
  });

  it("parses the repository spreadsheet clipboard fixture without type inference", () => {
    const matrix = parseTsv(
      readFileSync(
        resolve(
          process.cwd(),
          "tests/github-markdown-test-suite/assets/clipboard-3x4.tsv",
        ),
        "utf8",
      ),
    );
    expect(matrix).toMatchObject({
      values: [
        ["001", "", "日本語", "末尾A"],
        ["002", "A|B", "🧑‍💻", ""],
        ["003", "café", "0001", "末尾C"],
      ],
      rows: 3,
      columns: 4,
    });
  });

  it("rejects unclosed quoted fields instead of creating a malformed matrix", () => {
    expect(parseTsv('"unclosed\tvalue')).toBeNull();
  });

  it("round-trips displayed special values through TSV and Markdown", () => {
    const matrix = {
      values: [
        [
          "a|b",
          '"quoted"',
          "<hello>&",
          "日本語😀",
          "",
          "line 1\r\nline 2",
          "tab\tvalue",
        ],
        ["00123", "2026/09/14", "true", "$90", "", "", ""],
      ],
      rows: 2,
      columns: 7,
    };
    expect(parseTsv(matrixToTsv(matrix))?.values).toEqual(matrix.values);

    const table = createTableNodeFromMatrix(schema, matrix);
    expect(table).not.toBeNull();
    expect(table?.child(0).child(5).firstChild?.childCount).toBe(3);
    const markdown = serializeMarkdown(
      schema.topNodeType.create(null, table ? [table] : []),
    );
    const reparsed = parseMarkdown(markdown, "github").doc;
    expect(reparsed.firstChild?.type.name).toBe("table");
    expect(reparsed.firstChild?.textContent).toContain("a|b");
    expect(reparsed.firstChild?.textContent).toContain("line 1");
    expect(reparsed.firstChild?.textContent).toContain("line 2");
    expect(reparsed.firstChild?.textContent).toContain("日本語😀");
  });

  it("extracts HTML cell text without importing spreadsheet attributes", () => {
    expect(
      parseClipboardHtml(
        '<table class="excel"><tr><td style="color:red"><span>00123</span><br>line<script>bad()</script><style>.x{color:red}</style></td><td data-formula="=1">&lt;&amp;&gt;</td></tr></table>',
      ),
    ).toMatchObject({
      values: [["00123\nline", "<&>"]],
      rows: 1,
      columns: 2,
    });
  });

  it("keeps empty cells and content from merged HTML cells", () => {
    expect(parseTsv("A\t\tC\n1\t2\t")).toMatchObject({
      values: [
        ["A", "", "C"],
        ["1", "2", ""],
      ],
      rows: 2,
      columns: 3,
    });
    expect(
      parseClipboardHtml(
        '<table><tr><td rowspan="2">A</td><td>B</td></tr><tr><td>C</td></tr></table>',
      ),
    ).toMatchObject({
      values: [
        ["A", "B"],
        ["C", ""],
      ],
      rows: 2,
      columns: 2,
    });
  });

  it("normalizes rectangular rows and rejects malformed or oversized matrices", () => {
    expect(validateClipboardMatrix([["A"], ["B", "C"]])).toEqual({
      matrix: {
        values: [
          ["A", ""],
          ["B", "C"],
        ],
        rows: 2,
        columns: 2,
      },
      failure: null,
    });
    expect(validateClipboardMatrix([["A"], [42]])).toEqual({
      matrix: null,
      failure: "malformed",
    });
    expect(
      validateClipboardMatrix(
        Array.from({ length: 100 }, () =>
          Array.from({ length: 100 }, () => "cell"),
        ),
      ).matrix?.rows,
    ).toBe(100);
    expect(
      validateClipboardMatrix(Array.from({ length: 10_001 }, () => ["cell"])),
    ).toEqual({ matrix: null, failure: "too-large" });
  });

  it("uses internal, TSV, then HTML priority and leaves one-cell data non-table", () => {
    expect(
      detectSpreadsheetPaste({
        internal: "",
        text: "TSV\tvalue",
        html: "<table><tr><td>HTML</td><td>value</td></tr></table>",
      }),
    ).toMatchObject({ kind: "matrix", source: "tsv" });
    expect(
      detectSpreadsheetPaste({
        internal: "",
        text: "",
        html: "<table><tr><td>one</td></tr></table>",
      }),
    ).toMatchObject({ kind: "single-cell", source: "html" });
    expect(
      detectSpreadsheetPaste({
        internal: JSON.stringify({ values: [["one", "two"]] }),
        text: "TSV\tvalue",
        html: "",
      }),
    ).toMatchObject({ kind: "matrix", source: "internal" });
  });

  it("rejects oversized TSV, HTML, and internal matrices without truncation", () => {
    const values = Array.from({ length: 10_001 }, (_, index) => [`${index}`]);
    const oversizedInternal = JSON.stringify({ values });
    const oversizedHtml = `<table><tbody>${values
      .map(([value]) => `<tr><td>${value}</td></tr>`)
      .join("")}</tbody></table>`;
    expect(
      detectSpreadsheetPaste({
        internal: "",
        text: values.map(([value]) => value).join("\n"),
        html: "",
      }),
    ).toEqual({ kind: "none" });
    expect(
      detectSpreadsheetPaste({
        internal: "",
        text: values.map(([value]) => `${value}\tvalue`).join("\n"),
        html: "",
      }),
    ).toEqual({ kind: "too-large", source: "tsv" });
    expect(
      detectSpreadsheetPaste({
        internal: "",
        text: "",
        html: oversizedHtml,
      }),
    ).toEqual({ kind: "too-large", source: "html" });
    expect(
      detectSpreadsheetPaste({
        internal: oversizedInternal,
        text: "",
        html: "",
      }),
    ).toEqual({ kind: "too-large", source: "internal" });
  });

  it("accepts exactly 10,000 TSV cells and stops oversized matrices while parsing", () => {
    const values = Array.from({ length: 100 }, (_, row) =>
      Array.from({ length: 100 }, (_, column) => `${row}:${column}`),
    );
    expect(
      detectSpreadsheetPaste({
        internal: "",
        text: matrixToTsv({ values, rows: 100, columns: 100 }),
        html: "",
      }),
    ).toMatchObject({
      kind: "matrix",
      source: "tsv",
      matrix: { rows: 100, columns: 100 },
    });

    const tooWide = Array.from({ length: 100 }, () => "\t".repeat(100)).join(
      "\n",
    );
    expect(parseTsvWithStatus(tooWide)).toEqual({
      matrix: null,
      failure: "too-large",
    });

    const largeEmpty = Array.from({ length: 1_000 }, () =>
      "\t".repeat(999),
    ).join("\n");
    expect(parseTsvWithStatus(largeEmpty)).toEqual({
      matrix: null,
      failure: "too-large",
    });

    expect(
      parseTsvWithStatus(`A\t${"x".repeat(MAX_CLIPBOARD_TEXT_LENGTH)}`),
    ).toEqual({
      matrix: null,
      failure: "too-large",
    });
  });

  it("rejects oversized HTML before constructing a DOM", () => {
    const parseFromString = vi.spyOn(DOMParser.prototype, "parseFromString");
    const html = `<table><tr>${Array.from(
      { length: 10_001 },
      () => "<td>cell</td>",
    ).join("")}</tr></table>`;
    try {
      expect(parseClipboardHtmlWithStatus(html)).toEqual({
        matrix: null,
        failure: "too-large",
      });
      expect(parseFromString).not.toHaveBeenCalled();
      expect(
        parseClipboardHtmlWithStatus(
          '<table><tr><td colspan="10001">cell</td></tr></table>',
        ),
      ).toEqual({ matrix: null, failure: "too-large" });
      expect(parseFromString).not.toHaveBeenCalled();
    } finally {
      parseFromString.mockRestore();
    }
  });

  it("creates an unbounded clipboard table with header row normalization", () => {
    const matrix = {
      values: Array.from({ length: 51 }, (_, row) =>
        Array.from({ length: 21 }, (_, column) => `${row}:${column}`),
      ),
      rows: 51,
      columns: 21,
    };
    const table = createTableNodeFromMatrix(schema, matrix);
    expect(table?.childCount).toBe(51);
    expect(table?.firstChild?.childCount).toBe(21);
    expect(table?.firstChild?.firstChild?.type.name).toBe("table_header");
    expect(table?.child(1).firstChild?.type.name).toBe("table_cell");
  });
});
