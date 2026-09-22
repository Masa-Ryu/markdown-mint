# Browser harness

Build the webview bundle, start the fixture server, and open
`http://127.0.0.1:4173/` in Playwright or Chrome:

```sh
npm run build:webview
node tests/browser/server.mjs
```

The fixture provides a guarded mock VS Code transport. It accepts only
protocol version `1`, validates operation ids and base versions, acknowledges
accepted edits with a `document` message, and returns `edit-rejected` with the
submitted draft for stale edits. `window.__markdownMintHarness` exposes
captured messages and a controlled external update for browser checks.

Open `http://127.0.0.1:4173/native.html` in another tab to inspect the native
VS Code CSS baseline for the same representative blocks. Its
`window.__markdownMintNative.metrics()` helper reports content, heading,
task, checkbox, and typography metrics for parity checks.

Use `http://127.0.0.1:4173/?fixture=math` for the multiline display and matrix
fixture. Both browser pages are served with a nonce-protected script policy and
the same `style-src-attr` allowance as the production Webview so KaTeX's
generated layout attributes are exercised under CSP.

Use `http://127.0.0.1:4173/?fixture=math&mode=preview` to show the dedicated
preview panel instead of the editable surface.

Use `http://127.0.0.1:4173/?fixture=mermaid` for the real Mermaid flowchart and
sequence regression fixture. After the diagrams render, evaluate
`window.__markdownMintHarness.mermaidCheck()` in the browser. It checks the
six flowchart node-label anchors and viewport-coordinate center deltas, keeps
the Yes/No edge labels and sequence messages aligned, confirms the source is
unchanged, and reports CSP violations. `style-src-elem` violations for an
inline stylesheet are expected for Mermaid 11.17.2; unexpected directives or
blocked URLs fail the check.

Use `http://127.0.0.1:4173/?fixture=mermaid-coverage` for the broader flowchart
TD, subgraph, rounded/diamond/rectangular, Japanese, multiline, Markdown
label, class-diagram, and state-diagram coverage. The same helper checks the
visible node geometry and diagram-type boundaries.

The dedicated harness supplies the packaged runtime URI and nonce as root
configuration but does not load `dist/mermaid.js` in its HTML. Mermaid fixtures
therefore exercise the real first-use loader; ordinary harness pages should
have no `/dist/mermaid.js` resource entry. Native pages load the lightweight
`dist/mermaid-loader.js` and request the heavy runtime only for Mermaid
placeholders.

Run the startup benchmark with:

```sh
npm run benchmark:mermaid-startup
```

It reports five local Chromium samples for ordinary-document time-to-editable,
Mermaid first-use latency, runtime request count/bytes, and production bundle
sizes. Set `MM_MERMAID_BENCHMARK_SAMPLES` or
`MM_MERMAID_BENCHMARK_PORT` to adjust the run.

Open `http://127.0.0.1:4173/native.html?fixture=math` to run the same equations
through the native preview cascade. The server generates the KaTeX markup with
`trust: false`, so the rich editor, dedicated preview, and native preview can
be compared at the same viewport and font settings.
The native fixture supplies a small dark-theme variable sheet because a standalone
browser tab does not receive VS Code's injected `--vscode-*` theme variables.

## Standalone HTML export smoke suite

Run the generated-HTML Chromium check with:

```sh
npm run test:browser:html-export
```

The test builds a temporary standalone export through `createExportHtml()`,
opens that exact file in Chromium with a dark OS preference, and verifies the
light Mermaid palette, CSP-authorized Mermaid SVG rendering, local and data
images, GitLab mixed task state, and the absence of console, page, or CSP
errors. Temporary files are removed after the run.

## Standalone PDF export smoke suite

Run the A4 PDF fixture through the same `createExportHtml()` and
`renderPdf()` functions used by the extension:

```sh
npm run test:browser:pdf-export
```

The suite uses the Chromium version pinned by the Playwright lockfile, renders
`tests/md/pdf-export.md` through the direct Chrome DevTools Protocol backend, and checks the PDF header, output
size, and multi-page pagination. The fixture includes a local image, long table
and code block, KaTeX, Mermaid, GitHub Alert, footnote, Japanese, and emoji.
Temporary browser output is removed after the run.

Open `http://127.0.0.1:4173/native.html?fixture=mermaid` to run the same
Mermaid flowchart and sequence placeholders through the native preview script.
Its `window.__markdownMintNative.metrics().mermaid` result reports node anchors,
viewport-coordinate center deltas, edge labels, sequence messages, and source
preservation.

## Direct table-controls regression suite

Run the real-browser table interaction checks with:

```sh
npm run test:browser:tables
```

The suite uses Chromium pointer events and keyboard focus against the bundled
Rich Editor. It checks row and column handle selection and dragging, boundary
and append controls, numbered-row renumbering, source/host edit delivery,
Undo/Redo, Delete/Backspace structural selection, Escape cancellation of
unselected row/column drags, and vertical/horizontal scrolling on a 100-row by
10-column table. Keyboard checks also cover the row/column roving handle groups,
arbitrary handle focus, selection, and post-selection movement. It also captures
light/dark/high-contrast diagnostic screenshots under
`output/playwright/table-controls/`. The presentation case uses an empty-header
five-column table and verifies that a wide table outer box does not move the
actual cell-grid line, highlight, or append control. It drags the fifth column
between columns two and three and asserts the exact result (`a b e c d`,
`f g j h i`, `k l o m n`), while checking the text-only preview, final-position
label, muted origin, and no-edit-before-drop invariant. Captured states include
idle, fifth-column hover, column drag, column drop, row drag, numbered-row drag,
wide horizontal scroll, light, dark, and high contrast. Pointer movement during
a drag is checked for zero host edits; actual VS Code focus, native IME
candidate windows, and screen-reader announcements remain manual/native
acceptance checks. The integrated Table Toolbar also captures
`table-toolbar-default.png`, `table-toolbar-row-selected.png`,
`table-toolbar-column-selected.png`, `table-toolbar-dark.png`, and
`table-toolbar-high-contrast.png`, checking axis-specific visibility,
numbering-column protection, disabled boundary moves, icon labels, hidden
button Tab order, and stable toolbar/table geometry.
The add controls keep the table/grid icons while the four movement controls
use separate arrow-only SVGs, and the browser assertions verify that those
icon identities do not overlap.

Run the focused large-table controls benchmark with:

```sh
npm run benchmark:table-controls
```

It uses the same bundled Rich Editor and browser harness, edits one existing
cell repeatedly, and reports edit latency, cell-rectangle queries, control-DOM
replacements, and Markdown-output change state as JSON under
`output/benchmark/table-controls.json`. The default 100x10 case is a
repeatable performance signal for ordinary cell edits; it does not impose a
wall-clock CI budget.

The server maps `/__vscode__/markdown.css` to the installed VS Code Markdown
stylesheet before `media/document.css` is loaded. Set `VSCODE_MARKDOWN_CSS` on
another machine to the matching installed stylesheet. This makes the rich and
dedicated preview layout checks exercise the same native cascade used by VS
Code.

## Block-spacing regression suite

Run the cross-surface spacing checks with:

```sh
npm run test:browser:spacing
```

The suite launches the real bundled Webview, the dedicated preview, and a
native-preview fixture at the same viewport. It measures actual DOM geometry
for Alert, code, paragraph, table, GitLab TOC, description list, Details,
math, Mermaid/static assets, raw fallback blocks, lists, quotes, comments, and
inline math. It also exercises code-card expansion/menu controls, Mermaid
fallback/source preservation, oversized-math fallback, narrow-width overflow,
larger typography, three themes, and document-edge cases. Native fixture
cases use the installed VS Code Markdown stylesheet in a standalone browser;
they are a CSS-cascade regression surface, not a replacement for the real
Extension Host. The run writes diagnostic screenshots under
`output/playwright/spacing/`.

The first run on a checkout may need the Playwright browser binary:

```sh
npx playwright install chromium
```

The harness keeps source comments and empty rendered atoms in the DOM model.
It does not insert placeholder paragraphs, `<br>` elements, or zero-width
content to manufacture spacing. Real OS IME candidate-window behavior still
requires a manual VS Code check.

The webview suite covers composition start/end and defers external snapshots
without dropping local input. The browser fixture can dispatch composition DOM
events but cannot create the native IME candidate window; Japanese IME behavior
still needs one manual check in VS Code.

## Direct block editing regression suite

Run the real-browser interaction checks with:

```sh
npm run test:browser:blocks
```

The suite uses Chromium mouse clicks, double clicks, drag selection, key presses,
and native focus transitions against the actual Webview bundle. It checks code
language selection and metadata preservation; Alert type selection and body
selection; inline Details headings, separate disclosure controls, nested bodies,
HTML summary preservation, cancellation, blur, Tab, and composition event order;
and existing Math/Mermaid source updates without duplicate insertion.

Arrow tests cross paragraph, code, Alert, structured Details, closed Details, and
consecutive rendered blocks in both directions. Actual textarea wrapping is
measured at a narrow viewport, including leaving the final displayed Alert row
and typing immediately into the next body. The suite verifies the preferred
horizontal caret coordinate survives short intermediate bodies and that empty
bodies, document edges, navigation, and cancellation emit no host edits or dirty
state. Synthetic composition events cover event handling only; these checks do
not exercise an OS IME candidate window or replace Japanese IME testing in VS Code.

The five required `tests/md/*test*.md` files are also rendered in their corresponding
CommonMark, GitHub, or GitLab profile, in Rich, dedicated Preview, and a native
preview fixture. Native fixtures call the same safe core renderer as the native
extension contribution and load the installed VS Code stylesheet, shared CSS,
KaTeX, Mermaid, and CSP. They do not replace `npm run test:extension` or prove
host-level focus/IME behavior. Screenshots of each document and its representative
code, Alert, Details, Math, and Mermaid blocks are saved under
`output/playwright/block-editing/`.

To run an individual case, set `MM_BLOCK_BROWSER_CASE` to a test function name
fragment, for example `WrappedVerticalNavigation`. Set
`MM_BLOCK_BROWSER_TEST_PORT` to change the suite's default port, `4175`.
The native document fixture is also available interactively at
`/native.html?fixture=document&file=github-test.md`; only the five repository
acceptance documents are allowed.
