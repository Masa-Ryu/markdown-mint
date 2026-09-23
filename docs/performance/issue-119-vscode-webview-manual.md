# Issue #119 VS Code Webview Large-table Proxy Reproduction

The benchmark branch now includes a runnable, benchmark-only VS Code bundle.
The current run still did not capture a Webview trace, so the values below must
be filled by a local Extension Development Host run; do not substitute the
headless Chromium timings.

## Build and launch

From the repository root, run:

```sh
npm ci
npm run benchmark:editor:vscode -- --launch
```

The command builds the normal extension host bundle, replaces only the local
ignored `dist/webview.js` with the benchmark bundle, and launches an Extension
Development Host. It does not change `src/`, `media/`, Preview, or package
settings. Open the fixture with **Reopen With → Markdown Mint**.

For a Current/native run, restore the normal bundle first:

```sh
npm run benchmark:editor:vscode -- --current --launch
```

Close the Development Host between Current and Threshold runs, then reload the
fixture so both measurements start from the same document state. The threshold
bundle defaults to `totalCells >= 10000`, OFF below `7500`, plus one
instance-local `viewport.scrollWidth > viewport.clientWidth` probe and a sticky
proxy. The normal bundle leaves the product native path unchanged.

## Reproduction and trace

1. Open `tests/github-markdown-test-suite/stress/github-table-2000x20.md` with
   the **Markdown Mint** custom editor. Confirm `R0001C01` is visible.
2. Open **Developer: Open Webview Developer Tools**. In Performance, start a
   recording.
3. Click `R0001C01`, type one character, and stop after the caret and DOM are
   responsive. Record click→caret, input→DOM, UI freeze, and the longest
   `RunTask`, `UpdateLifecycle`, `Layerize`, and
   `PaintArtifactCompositor::Update`.
4. In the threshold bundle, `globalThis.__markdownMintPerformanceBenchmark`
   exposes `snapshot()` and `counterSnapshot()` in the Webview console. Save
   those objects with the trace.
5. Repeat after reload for Current and Threshold. Do not report a Webview
   improvement unless the trace shows it.

Repeat the pair for `500×20`, `250×40`, and `2000×20`. The first two verify
that cell-count activation catches wide shapes; `2000×5` and `1000×10` are
useful negative controls because they should remain native when they do not
overflow horizontally.

## Candidate CSS A/B check

The headless investigation identified the following benchmark-only candidate. It has not been applied to `media/document.css`:

```css
.mm-document-content table {
  overflow-x: visible !important;
}
```

To compare it in VS Code, record the Current click first, then reload the document to reset the initial state. CSS cannot be executed by pasting a bare rule into the Console. Use a style element instead (or apply the rule from the Elements → Styles pane):

```js
const style = document.createElement("style");
style.textContent = ".mm-document-content table{overflow-x:visible!important}";
document.head.append(style);
```

Wait for two animation frames, repeat the same-cell click and Performance recording, and then reload again before treating the next result as a separate Current run. Record whether the candidate changes `PaintArtifactCompositor::Update`; do not claim native Webview reproduction or improvement unless these steps are completed in VS Code. The wrapper NodeView and scrollbar-proxy conditions require the benchmark bundle and are not represented by this CSS-only snippet.

## Threshold proxy checks

The prototype keeps ordinary tables on the existing native scroll path. A
cell-count candidate mounts in a non-scrolling pending presentation, so the
table never starts with `overflow-x:auto`. After rows mount, one
instance-local geometry read checks `viewport.scrollWidth > viewport.clientWidth`;
overflow attaches the sticky proxy and no-overflow candidates remain
native-equivalent. There is no global shape cache and ordinary text input does
not reclassify the presentation.

If a future Development Host bundle exposes the prototype, repeat the same
document reload sequence for Current and Proxy and record:

1. the active large table's proxy scrollbar at the editor viewport bottom;
2. horizontal scroll at 0%, 50%, and 100%, including column/row handle
   alignment;
3. right-edge and left-edge drag auto-scroll;
4. Tab/Shift+Tab reveal to the first and last columns;
5. rightmost-cell editing and Markdown/ProseMirror/DOM synchronization;
6. independent scrolling when two large tables are present, while small
   tables remain native.

For each reload, also record the activation timeline:

1. candidate mounted;
2. rows mounted;
3. overflow measured;
4. final mode selected;
5. sticky proxy ready;
6. first click and first caret.

At every 0%, 50%, and 100% position verify that the proxy is the only
horizontal source of truth:

```text
proxy.scrollLeft       = logical horizontal position
viewport.scrollLeft    = 0
table.scrollLeft       = 0
.mm-stage.scrollLeft   = 0
```

Click the visible row handle and a visible column handle at each position.
Move the pointer to a row and column boundary to show insert controls, then
drag a column toward both viewport edges. Confirm the move indicator and drag
preview follow the cell after auto-scroll. Repeat after resizing wide → narrow
→ wide. A horizontal wheel/trackpad `deltaX` should move the active proxy
while ordinary vertical scrolling remains available. Record any mismatch
rather than applying a permanent CSS or NodeView change in this investigation
branch.

## Record

| Field                                                  | Value                              |
| ------------------------------------------------------ | ---------------------------------- |
| VS Code version                                        | not measured (CLI 1.138.0 present) |
| Electron / Chromium version (Help → About)             | not measured                       |
| Worktree commit SHA                                    |                                    |
| Fixture loaded in Markdown Mint editor                 | yes / no                           |
| First click: pointer down → caret visible              |                                    |
| First click: UI unresponsive duration                  |                                    |
| First click: longest main-thread task                  |                                    |
| First click: longest `PaintArtifactCompositor::Update` |                                    |
| Activation: nodeViewCreated → proxy ready              |                                    |
| Activation: candidateMounted → proxy ready             |                                    |
| Activation: PAC max from mount through first input     |                                    |
| Proxy 0/50/100% handle clicks and alignment            |                                    |
| Proxy-only scroll ownership round-trip                 |                                    |
| Drag auto-scroll and overlay follow                    |                                    |
| Resize wide → narrow → wide                            |                                    |
| Threshold proxy mode (not forced)                      |                                    |
| Same-cell repeat: click latency                        |                                    |
| Same-cell repeat: longest lifecycle task               |                                    |
| Webview Performance trace file                         |                                    |

The current run did not capture a VS Code Webview trace. Headless Chromium
results therefore do not establish native Webview performance, and product
implementation should remain conditional until this table is filled.

Keep the VS Code trace local unless it is needed for review; it may contain unrelated workbench activity. No product CSS or editor behavior needs to be changed for this measurement.
