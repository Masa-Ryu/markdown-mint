# Issue #119 Scroll Ownership Investigation

- Measurement commit: `6fe48f8`
- Chromium: `153.0.8010.12`
- Raw traces: `/tmp/markdown-mint-issue119-scroll-structure-traces` (representative traces are retained there)
- Product CSS and main were not changed; the wrapper NodeView is benchmark-only.

## Current baseline and scroll ownership

The Current condition records the existing table-owned horizontal scroll container. The stage condition is the fast performance baseline and intentionally moves horizontal scrolling to `.mm-stage`.

| Structure                                   | Local table scroll | Stage scroll |   PAC p50 |  Click p50 | Full interaction p50 | Controls / UX                              | Verdict      |
| ------------------------------------------- | -----------------: | -----------: | --------: | ---------: | -------------------: | ------------------------------------------ | ------------ |
| Current table overflow:auto                 |                yes |           no | 7316.4 ms | 15195.5 ms |           23135.5 ms | controls measured; independent scroll pass | slow         |
| Stage scroll (table overflow:visible)       |                 no |          yes |   10.6 ms |   434.5 ms |             882.4 ms | stage/table ownership changes UX           | fast         |
| Table wrapper overflow-x:auto               |                yes |           no | 1841.6 ms |  4253.5 ms |            6860.3 ms | controls measured; independent scroll pass | intermediate |
| Table wrapper auto + overflow-y:hidden      |                yes |           no | 1849.0 ms |  4272.5 ms |            6910.3 ms | controls measured; independent scroll pass | intermediate |
| Table wrapper auto + overflow-y:clip        |                yes |           no | 1854.2 ms |  4278.2 ms |            6894.1 ms | controls measured; independent scroll pass | intermediate |
| Non-scroll viewport + small scrollbar proxy |                yes |           no |    3.0 ms |   414.8 ms |            1127.5 ms | proxy not in existing listener set         | fast         |

## Effective style and geometry verification

The JSON stores computed style and geometry snapshots for `.mm-stage`, `.mm-rich-panel`, `.ProseMirror`, `.mm-table-scroll`, `table`, `tbody`, target row/cell, and paragraph. It also records all non-visible overflow ancestors and scroll dimensions. Wrapper C1-C3 differ only in wrapper overflow-y; cell padding, border, minimum width, border model, and header styling remain inherited from Current.

## TableControls and editing

The benchmark NodeView changes `view.nodeDOM(tablePos)` to the wrapper. The normal TableControls resolver therefore needs a descendant-table adapter; this branch uses a compile-time benchmark-only adapter solely to measure geometry. The existing scroll-container scan detects `.mm-table-scroll`, but it does not detect the proxy because the proxy is a child outside the table's ancestor chain.

The control geometry, right-edge edit, Tab/Shift+Tab, Markdown/DOM/PM state, and independent-scroll probes are stored under each condition. Wrapper C1-C3 keep a table-local scrollbar but remain intermediate. The proxy is fast and keeps stage.scrollLeft at 0, but its horizontal scroll is not currently in refreshScrollContainers() and the measured column-handle delta grows with proxy scroll; drag auto-scroll is therefore not claimed as passing. A product implementation must explicitly register and sync the proxy before adoption.

## Position verification

- row1: click 412.3 ms, PAC 3.0 ms, full interaction 1093.9 ms.
- row1000: click 409.6 ms, PAC 2.9 ms, full interaction 1091.3 ms.
- row2000: click 403.7 ms, PAC 0.3 ms, full interaction 1081.3 ms.

## Preview and VS Code

The preview was not modified by this benchmark-only NodeView/CSS path. VS Code Webview was not measured; do not treat the headless result as a Webview confirmation.

## Recommended product architecture

The simple wrapper (`overflow-x:auto` on `.mm-table-scroll`) is not the final architecture: it reduces PAC from about 7316ms to about 1842ms but remains above the 500ms target and keeps row-position sensitivity. The only fast diagnostic structure is a Rich Editor-only non-scroll table viewport plus a small horizontal proxy that translates the table. It preserves stage.scrollLeft=0, right-edge reachability, paragraph stability, independent table owners, and editing in this headless run, but it is not ready for product implementation until proxy-aware Controls and a usable scrollbar placement are designed. Keep Preview DOM/CSS unchanged. The stage-scroll condition remains the simplest fast baseline but changes the current table-local UX.

## Required product changes

1. Add a real table NodeView in `src/webview/editor.ts` while preserving PM table nodes, attrs, serialization, and `contentDOM` semantics.
2. Update the table target resolver and delete-preview paths that assume `view.nodeDOM(tablePos)` is an `HTMLTableElement`; resolve the descendant table while retaining the wrapper as the scroll ancestor.
3. Verify `TableControls.refreshScrollContainers()`, `updateLayout()`, and `scheduleAutoScroll()` observe and scroll the wrapper, then add browser/webview tests for 0/50/100% scroll and drag edge scrolling.
4. Add Rich Editor-only CSS and leave `media/document.css` Preview behavior unchanged.

## Known risks

- The benchmark NodeView and descendant-table adapter are compile-time benchmark paths only; they are not a product implementation.
- Headless Chromium results are not VS Code Webview measurements.
- C2/C3 computed overflow values must be reviewed from the saved snapshots because CSS overflow coupling can normalize `visible` or `clip`.
- The diagnostic proxy is appended inside the wrapper and currently sits after the table; its scrollbar placement and keyboard/drag affordance require a product UX design.
- The raw traces are temporary files outside git; the JSON retains summary data and paths.
