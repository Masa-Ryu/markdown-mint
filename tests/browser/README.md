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

Open `http://127.0.0.1:4173/native.html?fixture=math` to run the same equations
through the native preview cascade. The server generates the KaTeX markup with
`trust: false`, so the rich editor, dedicated preview, and native preview can
be compared at the same viewport and font settings.
The native fixture supplies a small dark-theme variable sheet because a standalone
browser tab does not receive VS Code's injected `--vscode-*` theme variables.

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
`output/playwright/table-controls/`. Pointer movement during a drag is checked
for zero host edits; actual VS Code focus, native IME candidate windows, and
screen-reader announcements remain manual/native acceptance checks.

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
