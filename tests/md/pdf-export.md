# PDF export fixture

Markdown Mint reuses one profile-aware renderer for both standalone HTML and PDF exports.

This fixture includes Unicode text for print layout: 日本語、Markdown Mint、そして 🧪 📄.

## Lists and page flow

- First list item
- Second list item with enough text to wrap naturally across a printed page.
- Third list item

1. Ordered item one
2. Ordered item two
3. Ordered item three

## Table

| Feature     | Expected output   | Status |
| ----------- | ----------------- | ------ |
| Local image | Embedded image    | Ready  |
| KaTeX       | Printed formula   | Ready  |
| Mermaid     | Rendered SVG      | Ready  |
| Footnotes   | Printed reference | Ready  |

## Long table

| Row | Japanese text | Value |
| --: | ------------- | ----: |
|   1 | こんにちは    |    10 |
|   2 | さようなら    |    20 |
|   3 | 東京          |    30 |
|   4 | 京都          |    40 |
|   5 | 大阪          |    50 |
|   6 | 札幌          |    60 |
|   7 | 福岡          |    70 |
|   8 | 名古屋        |    80 |
|   9 | 横浜          |    90 |
|  10 | 神戸          |   100 |
|  11 | 仙台          |   110 |
|  12 | 広島          |   120 |
|  13 | 那覇          |   130 |
|  14 | 金沢          |   140 |
|  15 | 長崎          |   150 |
|  16 | 奈良          |   160 |
|  17 | 高松          |   170 |
|  18 | 熊本          |   180 |
|  19 | 静岡          |   190 |
|  20 | 岡山          |   200 |
|  21 | 甲府          |   210 |
|  22 | 宇都宮        |   220 |
|  23 | 新潟          |   230 |
|  24 | 盛岡          |   240 |
|  25 | 山形          |   250 |
|  26 | 和歌山        |   260 |
|  27 | 松山          |   270 |
|  28 | 鹿児島        |   280 |
|  29 | 鳥取          |   290 |
|  30 | 徳島          |   300 |
|  31 | 大分          |   310 |
|  32 | 津            |   320 |
|  33 | 青森          |   330 |
|  34 | 秋田          |   340 |
|  35 | 福井          |   350 |
|  36 | 佐賀          |   360 |
|  37 | 前橋          |   370 |
|  38 | 水戸          |   380 |
|  39 | 岐阜          |   390 |
|  40 | 高知          |   400 |

## Code

```ts
type ExportOptions = {
  format: "A4";
  landscape: false;
  printBackground: true;
};

const options: ExportOptions = {
  format: "A4",
  landscape: false,
  printBackground: true,
};

export async function renderMarkdownPdf(markdown: string): Promise<Uint8Array> {
  const html = await createExportHtml(markdown);
  return renderPdf(html, options);
}
```

## Long code block

```text
01  page one starts before this long code block
02  the print engine should split a block that is taller than one page
03  line content remains readable at the configured print width
04  PDF export must not create one endless page
05  PDF export must not leave a giant blank area before this block
06  the table above spans several printed pages
07  each page keeps the default A4 portrait size
08  margins come from the export stylesheet
09  background colors remain visible in print output
10  the source Markdown remains unchanged
11  the user can still undo edits after exporting
12  all output comes from the standalone HTML renderer
13  Mermaid becomes an SVG before the print call
14  KaTeX fonts finish loading before the print call
15  embedded local images finish loading before the print call
16  remote image assets are not downloaded by the extension host
17  a timeout reports which rendering step failed
18  every launched browser is closed on success and failure
19  this line exercises ordinary text wrapping on paper
20  Japanese glyphs stay available in the generated document
21  emoji glyphs stay available in the generated document 🧪
22  PDF bytes are returned directly to the extension host
23  workspace.fs.writeFile saves the selected destination
24  cancellation before browser startup causes no process to launch
25  a custom executable path takes precedence when it is valid
26  a missing custom executable path produces a clear error
27  system Chrome, Edge, and Chromium are checked in order
28  the managed Chrome version is fixed in the source tree
29  managed browser files live in extension global storage
30  the managed browser binary is excluded from the VSIX
31  normal extension install does not download a browser
32  an explicit install action is required for managed Chromium
33  PDF export is also available from the Command Palette
34  the editor Export menu offers HTML and PDF
35  unsent edits wait for their host acknowledgement
36  remote extension hosts need a browser on the remote machine
37  this content crosses the first printed page boundary
38  the browser uses the CSS page size before choosing defaults
39  printBackground preserves task list check marks
40  avoid rules keep short structures together when possible
41  elements taller than a page can still fragment
42  this content crosses the second printed page boundary
43  PDF generation does not use a Markdown-specific renderer
44  there is no second Markdown-to-HTML conversion path
45  the same HTML snapshot is passed to the PDF backend
46  conversion errors are surfaced as VS Code notifications
47  failed exports leave source and editor state untouched
48  temporary browser resources are cleaned up in all paths
49  the final page ends with regular text rather than clipped content
50  PDF export fixture complete
```

## Local image

![Markdown Mint sample image](../github-markdown-test-suite/assets/sample.png)

## Math and Mermaid

Inline math is printed as $x^2 + y^2 = z^2$.

$$
\int_0^1 x^2\,dx = \frac{1}{3}
$$

```mermaid
flowchart LR
  Markdown --> StandaloneHTML --> Chromium --> PDF
```

> [!NOTE]
> This GitHub Alert should stay together when it fits on a page.

## Footnote

The renderer keeps footnote output in the document.[^layout]

[^layout]: Print layout should preserve this footnote reference and text.
