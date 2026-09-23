# Issue #119 VS Code Webview Paint Reproduction

The current benchmark machine reported that macOS is locked, so this run could not open or drive VS Code. Use these steps to collect the native Webview result separately; do not substitute the headless Chromium timings.

## Reproduction

1. Check out `codex/issue-119-editor-performance` and launch the Markdown Mint Extension Development Host from this worktree (Run and Debug → Launch Extension).
2. Open `tests/github-markdown-test-suite/stress/github-table-2000x20.md` with the **Markdown Mint** custom editor (`markdownMint.editor`). Confirm that the Rich Editor shows the first table body cell `R0001C01`.
3. Open the Webview developer tools from the Command Palette using **Developer: Open Webview Developer Tools**. In its Performance panel, start a recording.
4. Return to the Rich Editor, click once in `R0001C01`, and wait until the caret appears and the UI responds. Stop the recording after the editor is responsive.
5. In the Performance trace, inspect the click interval and main-thread tasks for `RunTask`, `WebFrameWidgetImpl::UpdateLifecycle`, `LocalFrameView::RunPaintLifecyclePhase`, `LocalFrameView::pushPaintArtifactToCompositor`, `Layerize`, and `PaintArtifactCompositor::Update`. Record the longest task and its nested lifecycle events.
6. Repeat by clicking `R0001C01` again without changing cells. Compare the first and repeat clicks.

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

## Large-table proxy prototype

The final headless prototype keeps ordinary tables on the existing native
scroll path. It selects the proxy only when the PM table shape reaches the
measured large-table boundary (500 body rows in this run), then confirms
`table.scrollWidth > table.clientWidth` after the table has mounted. The
overflow guard keeps a tall but narrow 2,000×5 table native. A 250-row off
threshold is used to avoid switching the DOM presentation during ordinary
cell typing. The proxy bundle is benchmark-only and is not enabled by the
normal Extension Development Host build.

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

The proxy scrollbar must not move `.mm-stage` horizontally. A horizontal
wheel/trackpad `deltaX` should move the active proxy while ordinary vertical
scrolling remains available. Record any mismatch rather than applying a
permanent CSS or NodeView change in this investigation branch.

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
| Same-cell repeat: click latency                        |                                    |
| Same-cell repeat: longest lifecycle task               |                                    |
| Webview Performance trace file                         |                                    |

The current run did not capture a VS Code Webview trace. Headless Chromium
results therefore do not establish native Webview performance, and product
implementation should remain conditional until this table is filled.

Keep the VS Code trace local unless it is needed for review; it may contain unrelated workbench activity. No product CSS or editor behavior needs to be changed for this measurement.
