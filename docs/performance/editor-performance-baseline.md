# Rich Editor performance baseline

This baseline records the same real-Webview benchmark on both sides of #122.
The pre-#122 snapshot is the first parent of merge commit #129; the post-#122
snapshot is the current `main` revision that includes #122. Both JSON reports
are checked in alongside this summary:

- [Pre-#122 JSON](baselines/editor-performance-pre-122.json)
- [Post-#122 JSON](baselines/editor-performance-post-122.json)

## Method

The benchmark builds the same `src/webview/main.ts` bundle used by the browser
tests. A separate benchmark build enables the timing hook; normal extension and
Webview builds compile the hook off. Playwright sends actual keyboard and
pointer input to the Rich Editor and waits for the ProseMirror DOM or table
structure to reflect it. No latency thresholds are asserted.

Each revision used 20 samples per edit operation, 3 startup and preview samples
per scenario, and one 30-keystroke burst with 15 ms between keystrokes. The
2000x20 table is stress-only and used 3 startup and preview samples. Percentiles
use linear interpolation over sorted samples. Timings are milliseconds; each
cell below is p50 / p95 / max.

The reports were collected on 2026-09-22 with Chromium 153.0.8010.12, Node
24.5.0, macOS Darwin 25.6.0, and an Apple M1 Pro. The viewport was 1280x900.
Numbers are a local baseline for this machine, not CI budgets.

| Scenario                      |   Bytes | Pre-#122 startup to accepted input | Post-#122 startup to accepted input |         Pre-#122 preview ready |        Post-#122 preview ready |
| ----------------------------- | ------: | ---------------------------------: | ----------------------------------: | -----------------------------: | -----------------------------: |
| Small normal Markdown         |     174 |           292.40 / 312.11 / 314.30 |            284.60 / 317.81 / 321.50 |       167.30 / 170.45 / 170.80 |       179.10 / 185.31 / 186.00 |
| Normal Markdown, many blocks  | 102,456 |           312.00 / 322.89 / 324.10 |            382.10 / 422.78 / 427.30 |       201.10 / 206.14 / 206.70 |       215.30 / 229.79 / 231.40 |
| Code, headings, and footnotes |  36,225 |     1,786.10 / 1,786.37 / 1,786.40 |      1,775.50 / 1,797.01 / 1,799.40 | 1,000.00 / 1,004.50 / 1,005.00 |   997.10 / 1,005.56 / 1,006.50 |
| Large table, 100x10           |   8,420 |           313.20 / 333.63 / 335.90 |            319.30 / 320.38 / 320.50 |       192.80 / 193.52 / 193.60 |       190.30 / 194.26 / 194.70 |
| Stress table, 2000x20         | 434,328 |  40,884.20 / 41,404.40 / 41,462.20 |   40,587.30 / 40,626.36 / 40,630.70 | 1,353.90 / 1,371.54 / 1,373.50 | 1,306.80 / 1,334.79 / 1,337.90 |

Startup-to-input starts when the benchmark harness first runs, waits for the
Rich Editor to become editable, then clicks into the document and sends a real
character. The JSON also keeps the separate time until the editor is editable.
Preview-ready measures startup with Preview selected and waits for rendered
content.

## Edit latency

Each edit cell is DOM-reflection latency, measured immediately before the real
keyboard or pointer action. The 100x10 row insertion uses the existing
row-insert control at a visible row boundary.

| Operation                       | Pre-#122 p50 / p95 / max | Post-#122 p50 / p95 / max |
| ------------------------------- | -----------------------: | ------------------------: |
| Small document text edit        |     3.35 / 10.07 / 43.70 |       4.35 / 9.01 / 47.20 |
| 100KB document text edit        |     7.55 / 16.07 / 23.10 |      8.35 / 12.63 / 18.80 |
| Code/heading/footnote text edit | 640.95 / 673.22 / 688.90 |  652.80 / 673.05 / 683.60 |
| 100x10 table text edit          |      6.30 / 7.63 / 21.40 |      7.00 / 12.09 / 17.60 |
| 100x10 table cell edit          |     9.75 / 23.32 / 65.60 |     16.50 / 25.52 / 63.90 |
| 100x10 table row insertion      |    56.90 / 66.22 / 74.20 |     52.60 / 55.77 / 60.80 |

## Typing-burst costs

Both revisions synchronized and serialized all 30 edits. #122 reduced derived
compatibility and parse work from once per keystroke to once for the final
snapshot in this burst:

| Measurement                      | Pre-#122 calls / cumulative ms | Post-#122 calls / cumulative ms |
| -------------------------------- | -----------------------------: | ------------------------------: |
| `parseMarkdown`                  |                     30 / 147.1 |                         1 / 7.5 |
| `inspectCompatibility`           |                     30 / 150.8 |                         1 / 7.7 |
| `renderMarkdown`                 |                          0 / 0 |                           0 / 0 |
| `serializeMarkdown`              |                      30 / 26.6 |                       30 / 26.7 |
| ProseMirror `applyTransaction`   |                      30 / 12.2 |                       30 / 11.4 |
| Rich Editor transaction dispatch |                     30 / 120.9 |                      30 / 117.6 |

## Code-heavy single edits

The 36KB code/heading/footnote scenario remained expensive after #122. Across
20 isolated text edits, the hook recorded 204,020 `parseMarkdown` calls on both
revisions (10,201 per edit), with 11,248.7 ms pre-#122 and 11,654.9 ms
post-#122 cumulative parse time. `inspectCompatibility` made 20 calls and used
53.0 / 126.5 ms; `serializeMarkdown` made 20 calls and used 46.8 / 48.7 ms.
Transaction dispatch used 12,506.9 / 12,884.1 ms in total.

This makes the post-#122 report the relevant baseline for follow-up CPU or WASM
investigation: the burst-only parse reduction is already in place, while this
isolated-edit workload still records substantial parse call volume. These
measurements identify the cost and frequency; they do not attribute the
204,020 calls to a single caller or establish that a WASM boundary would be
faster.

`renderMarkdown` time includes its parse and nested document render.
`renderMarkdownDocument` is measured separately for render work. The reports
also keep compatibility and parse measurements separate; compatibility time
includes its nested parse time, so those two totals overlap and must not be
added together.

Regenerate the current revision's JSON with `npm run benchmark:editor`. To
match the sample counts above, set `MM_EDITOR_PERFORMANCE_SAMPLES=20`,
`MM_EDITOR_PERFORMANCE_STARTUP_SAMPLES=3`,
`MM_EDITOR_PERFORMANCE_PREVIEW_SAMPLES=3`, and
`MM_EDITOR_PERFORMANCE_BURST_EDITS=30`.
