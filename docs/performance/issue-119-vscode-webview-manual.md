# Issue #119 VS Code Webview Paint Reproduction

The current benchmark machine reported that macOS is locked, so this run could not open or drive VS Code. Use these steps to collect the native Webview result separately; do not substitute the headless Chromium timings.

## Reproduction

1. Check out `codex/issue-119-editor-performance` and launch the Markdown Mint Extension Development Host from this worktree (Run and Debug → Launch Extension).
2. Open `tests/github-markdown-test-suite/stress/github-table-2000x20.md` with the **Markdown Mint** custom editor (`markdownMint.editor`). Confirm that the Rich Editor shows the first table body cell `R0001C01`.
3. Open the Webview developer tools from the Command Palette using **Developer: Open Webview Developer Tools**. In its Performance panel, start a recording.
4. Return to the Rich Editor, click once in `R0001C01`, and wait until the caret appears and the UI responds. Stop the recording after the editor is responsive.
5. In the Performance trace, inspect the click interval and main-thread tasks for `RunTask`, `WebFrameWidgetImpl::UpdateLifecycle`, `LocalFrameView::RunPaintLifecyclePhase`, `LocalFrameView::pushPaintArtifactToCompositor`, `Layerize`, and `PaintArtifactCompositor::Update`. Record the longest task and its nested lifecycle events.
6. Repeat by clicking `R0001C01` again without changing cells. Compare the first and repeat clicks.

## Record

| Field                                                  | Value    |
| ------------------------------------------------------ | -------- |
| VS Code version                                        |          |
| Electron / Chromium version (Help → About)             |          |
| Worktree commit SHA                                    |          |
| Fixture loaded in Markdown Mint editor                 | yes / no |
| First click: pointer down → caret visible              |          |
| First click: UI unresponsive duration                  |          |
| First click: longest main-thread task                  |          |
| First click: longest `PaintArtifactCompositor::Update` |          |
| Same-cell repeat: click latency                        |          |
| Same-cell repeat: longest lifecycle task               |          |
| Webview Performance trace file                         |          |

Keep the VS Code trace local unless it is needed for review; it may contain unrelated workbench activity. No product CSS or editor behavior needs to be changed for this measurement.
