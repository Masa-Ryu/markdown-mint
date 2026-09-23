# Issue #119 Large-table Activation and Proxy Controls Investigation

- Measurement commit: `28d6b2ac4f59249aca2bf255fc8c88640ef6dfc6`
- Chromium: `153.0.8010.12`
- Raw traces: `/tmp/markdown-mint-issue119-large-table-traces`
- Product CSS, main, Preview, and production table NodeView were not changed.

## Measurement naming

`inputToDomMutationMs = mutationAt - inputStartedAt`; `postMutationToFirstIdleMs = idleAt - mutationAt`; `inputToFirstIdleMs = idleAt - inputStartedAt`. The JSON keeps these fields separately.

## Scroll ownership baseline

- Current 2,000x20: table scrollWidth/clientWidth 1401/987; the table owns the native horizontal scrollbar and stage.scrollLeft remains 0 at the baseline probe.
- Proxy 2,000x20: table overflow is visible; the proxy owns the horizontal scrollbar, stage.scrollLeft remains 0, and the rightmost cell is reachable through selection reveal/programmatic reveal.
- Mixed document: small tables remain native, each large table has an independent proxy owner, and sticky visibility follows the active table (visible,hidden then hidden,visible).

## Large-table activation threshold

| Rows | Columns | Cells | Horizontal overflow |   PAC p50 |  Click p50 | Full interaction p50 |
| ---: | ------: | ----: | :-----------------: | --------: | ---------: | -------------------: |
|  100 |      20 |  2000 |         yes         |   21.4 ms |   115.8 ms |             195.3 ms |
|  250 |      20 |  5000 |         yes         |  131.3 ms |   260.1 ms |             594.3 ms |
|  500 |      20 | 10000 |         yes         |  523.8 ms |  1242.5 ms |            1929.9 ms |
|  750 |      20 | 15000 |         yes         | 1173.6 ms |  2592.5 ms |            3996.8 ms |
| 1000 |      20 | 20000 |         yes         | 2071.9 ms |  4467.7 ms |            6830.4 ms |
| 1500 |      20 | 30000 |         yes         | 4633.2 ms |  5147.6 ms |           14863.1 ms |
| 2000 |      20 | 40000 |         yes         | 8193.0 ms | 16966.4 ms |           25795.7 ms |

### Same cell count shape matrix

| Rows | Columns | Cells | Horizontal overflow |  PAC p50 | Click p50 |
| ---: | ------: | ----: | :-----------------: | -------: | --------: |
| 2000 |       5 | 10000 |         no          |   1.1 ms |  222.6 ms |
| 1000 |      10 | 10000 |         no          |   2.8 ms |  159.8 ms |
|  500 |      20 | 10000 |         yes         | 527.6 ms | 1238.8 ms |
|  250 |      40 | 10000 |         yes         | 456.0 ms | 1092.4 ms |
|  125 |      80 | 10000 |         yes         | 359.7 ms |  897.8 ms |

**Recommended activation rule:** proxy when PM rows >= 500 **and** one post-mount geometry read reports `table.scrollWidth > table.clientWidth`; turn it off below 250 rows. The shape decision is O(1) from PM row/column counts, the overflow guard is one table-level read, and no cell scan or 40,000 rectangle reads are used. The presentation is stable during ordinary text edits.

- False-positive risk: tall tables that remain fast receive the proxy and a separate scrollbar.
- False-negative risk: a wide table below the selected row boundary may still cross the latency target; re-evaluate the boundary if browser or Webview baselines differ.
- Switching behavior: NodeView presentation is stable during text edits; a structural row/column change causes ProseMirror to recreate the benchmark NodeView only when the hysteresis boundary is crossed.

## Proxy Controls Integration

- 0/50/100% alignment: pass; maximum measured column/row center error is recorded in JSON.
- Drag auto-scroll: pass; right/left proxy deltas and overlay state are recorded.
- Wheel/trackpad diagnostic: pass; deltaY is not intercepted by the benchmark listener.
- Selection reveal: Tab pass (C20), Shift+Tab pass, programmatic pass.
- Rightmost-cell edit/source/DOM probe: pass.

## Proxy Placement

- Bottom-only: PAC 5.7 ms, click 630.0 ms, full 1350.3 ms. It is not usable for a 2,000-row table without reaching the bottom.
- Active sticky: PAC 5.7 ms, click 640.0 ms, full 1379.8 ms. Visibility switches with the active large table; the proxy remains benchmark-only.

## Normal and mixed tables

- Narrow/normal threshold tables: native table path; no proxy DOM. The 2,000x5 tall/narrow probe is used to enforce the horizontal-overflow guard.
- Mixed document modes: native, proxy, native, proxy; large table owners are independent and small tables remain native in the benchmark probe.
- Active sticky visibility: A=visible,hidden; B=hidden,visible.

## VS Code Webview

Current/proxy Webview measurements were not captured. The CLI reports VS Code 1.138.0; Electron/Chromium and Webview PAC/click values remain not measured. The manual procedure has been updated and must be run before product implementation.

## Final Recommendation

**CONDITIONAL.** Large-table-only proxy is viable in headless Chromium: PAC/click/full-interaction targets pass, controls align at 0/50/100%, drag and wheel probes pass, selection reveal reaches C20, and mixed documents keep small tables native. It remains conditional because VS Code Webview performance and the final visual/manual Extension Development Host checks were not captured. Keep normal tables native, keep Preview unchanged, and move product work to a new Issue/branch after those checks.

### Product implementation plan for the next Issue

- `src/webview/editor.ts`: production table NodeView with O(1) shape classification, hysteresis lifecycle, proxy owner, active sticky lifecycle, and selection reveal hook; preserve PM nodes/attrs/serialization.
- `src/webview/tableControls.ts`: use a horizontal scroll owner for native/proxy, register proxy scroll events, update layout/presentation, and route edge auto-scroll through the owner.
- `media/webview.css`: Rich Editor-only viewport/proxy/sticky presentation. Do not change Preview rules in `media/document.css` without a separate compatibility decision.
- `tests/webview/table-ux.test.ts`: threshold split, native/proxy DOM, selection reveal, Markdown/PM/DOM sync.
- `tests/webview/table-controls.test.ts` and `tests/browser/table-controls.test.mjs`: 0/50/100% geometry, drag edge scrolling, wheel behavior, multi-table independence, and wide-table editing.
