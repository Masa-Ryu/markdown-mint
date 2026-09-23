# Issue #119 Large-table Activation and Proxy Controls Investigation

- Measurement commit: `1dda06cfc607a505bac48d69fee162383c2573f8`
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

- Matrix provenance: the row-growth and same-cell tables are retained from the previous current-native series in the JSON. The threshold matrix below is also retained from the previous current-native series; the final comparison table uses its separately recorded three-run baseline.

### Cell-count activation threshold

| Rows | Columns | Cells | Horizontal overflow |  PAC p50 |  PAC max | Click p50 | Click max |  Full p50 |
| ---: | ------: | ----: | :-----------------: | -------: | -------: | --------: | --------: | --------: |
|  400 |      20 |  8000 |         yes         | 342.6 ms | 343.6 ms |  832.5 ms |  837.2 ms | 1296.5 ms |
|  200 |      40 |  8000 |         yes         | 285.4 ms | 298.0 ms |  730.1 ms |  738.8 ms | 1147.4 ms |
|  100 |      80 |  8000 |         yes         | 227.3 ms | 232.7 ms |  605.3 ms |  611.3 ms |  961.3 ms |
|  500 |      20 | 10000 |         yes         | 524.8 ms | 529.2 ms | 1241.3 ms | 1242.7 ms | 1929.6 ms |
|  250 |      40 | 10000 |         yes         | 446.7 ms | 452.9 ms | 1076.8 ms | 1084.8 ms | 1681.7 ms |
|  125 |      80 | 10000 |         yes         | 356.6 ms | 358.6 ms |  885.5 ms |  888.4 ms | 1397.0 ms |
|  600 |      20 | 12000 |         yes         | 747.3 ms | 747.4 ms | 1710.1 ms | 1714.7 ms | 2661.3 ms |
|  300 |      40 | 12000 |         yes         | 630.9 ms | 650.6 ms | 1462.5 ms | 1492.2 ms | 2280.1 ms |
|  150 |      80 | 12000 |         yes         | 512.4 ms | 519.1 ms | 1217.1 ms | 1218.6 ms | 1913.3 ms |

**Recommended activation rule:** proxy when totalCells (PM rows × first-row columns) >= 10000 **and** one post-mount geometry read reports `viewport.scrollWidth > viewport.clientWidth`; turn it off below 7500 cells. Large candidates mount in a non-scrolling pending presentation, so the table never starts with `overflow-x:auto`. The shape decision is O(1) from PM row/column counts, the overflow guard is one viewport-level read, and no cell scan or 40,000 rectangle reads are used. The presentation is stable during ordinary text edits.

- Nearest tested lower cell-count point: 8000 cells; nearest tested upper/selected point: 10000 cells. The threshold was selected from the first measured overflowing level where any tested shape crossed PAC >=500 ms or click >=1000 ms; values are preserved in JSON for review.

## Shape independence

- 8,000 cells (400×20, 200×40, 100×80) stayed below both native targets in the measured shapes.
- 10,000 cells crossed the target for 500×20 and 250×40 while 125×80 remained below it; the cell-count rule intentionally chooses the conservative level that catches the worst horizontal shapes.
- 12,000 cells crossed the target for all three measured shapes. 2,000×5 and 1,000×10 remain native when the one instance-local overflow guard reports no horizontal overflow.

## Final activation rule

- ON: totalCells >= 10000; OFF: totalCells < 7500; horizontal overflow is required. Header rows are included because the PM table child count and first-row child count describe the complete table shape consistently.
- Decision complexity: O(1) PM row/column counts plus one viewport-level geometry read per candidate mount/structural change/resize; no cell scan and no shape-global cache.
- Ordinary cell text input does not reclassify the NodeView. A product implementation should recheck after row/column structure changes and container resize; if text can change table width, schedule a debounced instance-local overflow read without changing presentation on every transaction.

- False-positive risk: tall tables that remain fast receive the proxy and a separate scrollbar.
- False-negative risk: a wide table below the selected cell boundary may still cross the latency target; re-evaluate the boundary if browser or Webview baselines differ.
- Switching behavior: large candidates use a per-instance pending/probe state, remeasure only on initial mount, structural shape changes, and resize, and use ON/OFF hysteresis. Ordinary cell text edits do not reclassify the presentation.

### Threshold + sticky automatic path

- 3 samples: nodeViewCreated→proxy ready p50 699.7 ms, candidateMounted→proxy ready p50 0.4 ms, first interaction after open p50 122.7 ms, click p50 583.2 ms, full interaction p50 1315.3 ms, PAC max from mount through interaction 5.8 ms.
- Acceptance: pass (PAC max <500 ms, click <1000 ms, full interaction <2000 ms).

## Final performance comparison

| Condition                | Activation                           |         PAC p50 / max |         Click p50 / max |          Full p50 / max | Viewport/table/stage scrollLeft | Verdict               |
| ------------------------ | ------------------------------------ | --------------------: | ----------------------: | ----------------------: | ------------------------------- | --------------------- |
| Current native           | native at open                       | 7316.4 ms / 7327.4 ms | 15195.5 ms / 15234.9 ms | 23135.5 ms / 23191.0 ms | 0 / 0 / 0                       | slow                  |
| Threshold + sticky proxy | pending → one viewport probe → proxy |       5.8 ms / 5.8 ms |     583.2 ms / 584.2 ms |   1315.3 ms / 1317.4 ms | 0 / 0 / 0                       | fast; VS Code pending |

## Product-like controls validation

- Product-like 0/50/100% alignment: pass; maximum measured column/row center error is recorded in JSON. The older forced probe is retained separately as diagnosticForcedControls.
- Drag auto-scroll: pass; right/left proxy deltas and overlay state are recorded.
- Wheel/trackpad diagnostic: pass; deltaY is not intercepted by the benchmark listener.
- Scroll ownership round-trip: pass; proxy is the only horizontal source and viewport/table/stage remain at scrollLeft 0.
- Natural row/column handle clicks: pass at 0/50/100%; 640px natural row/column clicks: pass. The forced diagnostic probe is not used for acceptance.
- Older diagnostic insertion/resize probe: insertion pass; resize pass; these results used forced visibility and are not the product-like acceptance gate.
- Selection reveal: Tab pass (C20), Shift+Tab pass, programmatic pass.
- Rightmost-cell edit/source/DOM probe: pass.

## Proxy Placement

- Bottom-only: PAC 5.6 ms, click 634.6 ms, full 1345.6 ms. It is not usable for a 2,000-row table without reaching the bottom.
- Active sticky: PAC 5.9 ms, click 621.4 ms, full 1363.5 ms. Visibility switches with the active large table; the proxy remains benchmark-only.

## Normal and mixed tables

- Narrow/normal threshold tables: no proxy scrollbar; the tall candidate uses a safe non-scrolling probe wrapper and stays native-equivalent. The 2,000x5 tall/narrow probe is used to enforce the horizontal-overflow guard.
- Mixed document modes: native, proxy, native, native, proxy; large table owners are independent and small tables remain native in the benchmark probe.
- Active sticky visibility: A=visible,hidden; B=hidden,visible.

## VS Code Development Host

Current/proxy Webview measurements were not captured. The CLI reports VS Code 1.138.0; Electron/Chromium and Webview PAC/click values remain not measured. Run `npm run benchmark:editor:vscode -- --current --launch` and `npm run benchmark:editor:vscode -- --launch` in separate Development Hosts; the manual procedure records the trace fields before product implementation.

## Final Recommendation

**CONDITIONAL.** The automatic threshold + sticky path now mounts large candidates safely, reaches proxy without a native table stall, keeps proxy as the only horizontal owner, and passes headless performance/control acceptance. VS Code Webview performance and the final visual/manual Extension Development Host checks remain unmeasured; do not call this product-ready until that environment is confirmed.

### Product implementation plan for the next Issue

- `src/webview/editor.ts`: production table NodeView with O(1) shape classification, hysteresis lifecycle, proxy owner, active sticky lifecycle, and selection reveal hook; preserve PM nodes/attrs/serialization.
- `src/webview/tableControls.ts`: use a horizontal scroll owner for native/proxy, register proxy scroll events, update layout/presentation, and route edge auto-scroll through the owner.
- `media/webview.css`: Rich Editor-only viewport/proxy/sticky presentation. Do not change Preview rules in `media/document.css` without a separate compatibility decision.
- `tests/webview/table-ux.test.ts`: threshold split, native/proxy DOM, selection reveal, Markdown/PM/DOM sync.
- `tests/webview/table-controls.test.ts` and `tests/browser/table-controls.test.mjs`: 0/50/100% geometry, drag edge scrolling, wheel behavior, multi-table independence, and wide-table editing.
