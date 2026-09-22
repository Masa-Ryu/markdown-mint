# 2000×20 Paint/Compositor Investigation

Generated: 2026-09-22T12:42:13.319Z

## Measurement corrections

**phase attribution:** Events and PM selection transactions capture the active phase and phase-specific start at dispatch time. clickStartedAt, endStartedAt, inputStartedAt, and directSelectionStartedAt are independent fields; no post-hoc phase guessing is applied. Companion input PM-selection offsets from inputStartedAt were [60.5,7519.0999999940395,7497.399999991059] ms, including one delayed event still classified as input.

**End validation:** Real End moved the target-cell caret in 0/3 trials. The first failed sample stayed PM 146 / DOM offset 0; direct PM-end validation moved PM 146→154, DOM 0→8. The direct caret landed at the end of the 8-character target cell. Absolute PM positions depend on the benchmark document shape. Failed End attempts are excluded from successful-caret latency summaries.

**DOM mutation vs settled:** Companion current-input run (2026-09-22T23:14:01.780Z) p50: input → DOM mutation 278.8 ms, post-mutation longest task 7438.0 ms, task duration overlapping after mutation 7566.2 ms, legacy post-mutation task total 7850.0 ms, input → first idle 7892.6 ms. DOM mutation therefore did not mean the browser had settled. The overlap metric clips each task at the mutation timestamp; the legacy total is retained for JSON compatibility. The idle marker uses requestIdleCallback (or two animation frames when unavailable).

## Scaling

| body rows | cells | click p50 | largest UpdateLifecycle | second-largest UpdateLifecycle | PaintArtifactCompositor::Update max | Layerize max | UpdateLifecycle max |
| --------: | ----: | --------: | ----------------------: | -----------------------------: | ----------------------------------: | -----------: | ------------------: |
|       100 |  2020 |  116.7 ms |                 27.2 ms |                         9.8 ms |                             20.0 ms |      20.0 ms |             27.2 ms |
|       250 |  5020 |  255.9 ms |                139.2 ms |                        23.9 ms |                            122.8 ms |     122.8 ms |            139.2 ms |
|       500 | 10020 |  685.4 ms |                515.5 ms |                        46.1 ms |                            484.8 ms |     484.8 ms |            515.5 ms |
|      1000 | 20020 | 2228.8 ms |               1949.0 ms |                        92.9 ms |                           1884.3 ms |    1884.3 ms |           1949.0 ms |
|      1500 | 30020 | 4664.6 ms |               4289.7 ms |                       137.9 ms |                           4197.5 ms |    4197.5 ms |           4289.7 ms |
|      2000 | 40020 | 8126.1 ms |               7611.9 ms |                       185.2 ms |                           7489.6 ms |    7489.6 ms |           7611.9 ms |

**Observed growth:** approximately quadratic in row count at fixed column count; log-log exponent 1.98; PaintArtifactCompositor::Update p50 ratio 2000 rows / 100 rows = 374.1 while rows increase 20×. Each row condition has 3 real Playwright clicks. Scroll-to-target and the two-frame visibility settle are timed outside click latency.

## DOM isolation

**ProseMirror:** 3 samples; click p50/p95/max 8126.1 ms / 8140.8 ms / 8142.5 ms; PaintArtifactCompositor::Update p50 7489.6 ms.

**Plain contenteditable:** 3 samples; click p50/p95/max 7803.7 ms / 8072.9 ms / 8102.8 ms; Update p50 7460.6 ms.

**Static table:** 3 samples; click p50/p95/max 244.8 ms / 250.1 ms / 250.7 ms; Update p50 0.0 ms.

**Conclusion:** Static table was materially faster than editable conditions; contenteditable/editing representation contributes to the measured lifecycle cost.

## CSS isolation

**Current CSS:** 3 current-style ProseMirror samples; click p50 8126.1 ms; PaintArtifactCompositor::Update p50 7489.6 ms.

**Minimal CSS:** 3 samples; click p50 488.9 ms; PaintArtifactCompositor::Update p50 20.8 ms.

**Relevant properties:** Minimal CSS reduced the lifecycle pause; none of 9 individually restored properties reproduced it (largest one-sample PaintArtifactCompositor::Update 22.4 ms). A property combination or an untested CSS rule remains unisolated. Each restoration was screened once: display:block: click 531.8 ms, Update 20.4 ms, Layerize 20.4 ms; width:max-content: click 527.3 ms, Update 16.5 ms, Layerize 16.5 ms; min-width:100% + max-width:100%: click 515.2 ms, Update 20.8 ms, Layerize 20.8 ms; border-collapse:collapse: click 534.0 ms, Update 22.4 ms, Layerize 22.4 ms; overflow-x:auto: click 514.3 ms, Update 20.5 ms, Layerize 20.5 ms; cell min-width:5em: click 468.3 ms, Update 22.3 ms, Layerize 22.3 ms; cell padding:7px 10px: click 403.7 ms, Update 13.6 ms, Layerize 13.6 ms; cell border: click 444.8 ms, Update 18.9 ms, Layerize 18.9 ms; vertical-align:top: click 530.4 ms, Update 20.7 ms, Layerize 20.7 ms.

## Effective style verification

**Current:** click p50 8004.6 ms, PAC p50 7398.6 ms, Layerize p50 7398.6 ms (slow)

**Minimal:** click p50 503.7 ms, PAC p50 20.6 ms, Layerize p50 20.6 ms (fast)

Minimal override assertions: **passed**. The post-override snapshot is stored with stage, rich panel, ProseMirror, table, tbody, target row/cell/paragraph styles, non-visible overflow ancestors, and geometry. Current→Minimal differences: 28 computed properties.

| node      | property          | Current                            | Minimal                     |
| --------- | ----------------- | ---------------------------------- | --------------------------- |
| richPanel | height            | 119765px                           | 93739.3px                   |
| editor    | height            | 119765px                           | 93739.3px                   |
| table     | display           | block                              | table                       |
| table     | minWidth          | 100%                               | 0px                         |
| table     | maxWidth          | 100%                               | none                        |
| table     | margin            | 0px 0px 14px                       | 0px                         |
| table     | borderSpacing     | 0px                                | 2px                         |
| table     | borderCollapse    | collapse                           | separate                    |
| table     | overflowX         | auto                               | visible                     |
| table     | overflowY         | auto                               | visible                     |
| tbody     | width             | 1400px                             | 983.25px                    |
| tbody     | height            | 119600px                           | 93584.9px                   |
| row       | width             | 1400px                             | 983.25px                    |
| row       | height            | 59.7812px                          | 44.7812px                   |
| cell      | minWidth          | 70px                               | 0px                         |
| cell      | width             | 70px                               | 46.75px                     |
| cell      | height            | 59.7812px                          | 44.7812px                   |
| cell      | padding           | 7px 10px                           | 0px                         |
| cell      | paddingTop        | 7px                                | 0px                         |
| cell      | paddingRight      | 10px                               | 0px                         |
| cell      | paddingBottom     | 7px                                | 0px                         |
| cell      | paddingLeft       | 10px                               | 0px                         |
| cell      | border            | 1px solid rgba(127, 127, 127, 0.3) | 0px none rgb(212, 212, 212) |
| cell      | borderTopWidth    | 1px                                | 0px                         |
| cell      | borderRightWidth  | 1px                                | 0px                         |
| cell      | borderBottomWidth | 1px                                | 0px                         |
| cell      | borderLeftWidth   | 1px                                | 0px                         |
| cell      | verticalAlign     | top                                | middle                      |

## Current → removal screening

| condition                           | properties | class | click p50 | PaintArtifactCompositor::Update p50 |
| ----------------------------------- | ---------: | ----- | --------: | ----------------------------------: |
| Minimal + restore tableMargin       |          1 | fast  |  444.6 ms |                             20.3 ms |
| Minimal + restore borderSpacing     |          1 | fast  |  473.8 ms |                             22.3 ms |
| Minimal + restore headerBackground  |          1 | fast  |  448.9 ms |                             20.6 ms |
| Group A: table scroll formatting    |          2 | fast  |  391.5 ms |                             10.8 ms |
| Group B: table width constraints    |          3 | slow  | 8003.9 ms |                           7353.3 ms |
| Group C: A + B                      |          5 | fast  |  408.0 ms |                             10.7 ms |
| Group D: separate border model      |          2 | slow  | 8091.7 ms |                           7420.0 ms |
| Group E: cell box model             |          4 | fast  |  457.0 ms |                             22.4 ms |
| Group F: header background          |          1 | slow  | 8060.8 ms |                           7453.8 ms |
| Group G: full table formatting only |          8 | fast  |  386.1 ms |                              9.5 ms |
| Group H: full cell formatting only  |          5 | fast  |  456.9 ms |                             21.8 ms |

## Delta debugging

**Slow set:** Current CSS; **fast set:** Minimal CSS and any condition classified below 500 ms.
**Minimal reproducing property set:** Delta: overflowOnly (1 properties). Other singleton fast screenings: Delta: displayOnly, Minimal + restore tableMargin, Minimal + restore headerBackground, Minimal + restore borderSpacing; these remain screening results unless separately A/B/A-confirmed.

| delta condition            | properties | class | click p50 | PaintArtifactCompositor::Update p50 |
| -------------------------- | ---------: | ----- | --------: | ----------------------------------: |
| Delta: displayOnly         |          1 | fast  |  396.7 ms |                             11.2 ms |
| Delta: overflowOnly        |          1 | fast  |  429.0 ms |                             11.1 ms |
| Delta: widthOnly           |          1 | slow  | 8028.6 ms |                           7419.4 ms |
| Delta: minMaxWidthOnly     |          2 | fast  |  393.5 ms |                              5.9 ms |
| Delta: displayPlusOverflow |          2 | fast  |  396.3 ms |                             10.7 ms |
| Delta: displayPlusWidth    |          2 | fast  |  389.8 ms |                             10.9 ms |
| Delta: overflowPlusWidth   |          2 | fast  |  390.1 ms |                             11.0 ms |

## A/B/A confirmation

**Current:** click p50 8000.9 ms, PAC p50 7400.8 ms, Layerize p50 7400.8 ms (slow)

**Candidate:** click p50 391.4 ms, PAC p50 10.7 ms, Layerize p50 10.7 ms (fast)

**Current again:** click p50 8030.4 ms, PAC p50 7418.2 ms, Layerize p50 7418.2 ms (slow)

**Verdict:** **causal CSS candidate**. Representative PAC traces: 7400.8 ms → 10.7 ms → 7418.2 ms. Raw trace paths: /tmp/markdown-mint-issue119-css-current-a.json, /tmp/markdown-mint-issue119-css-candidate.json, /tmp/markdown-mint-issue119-css-current-b.json.

**Lifecycle trace summary:** Current A UpdateLifecycle 7514.2 ms, RunPaint 7496.9 ms, push 7400.8 ms, Layerize 7400.8 ms; candidate UpdateLifecycle 45.4 ms, RunPaint 21.1 ms, push 10.7 ms, Layerize 10.7 ms; Current again UpdateLifecycle 7539.1 ms.

**VS Code DevTools candidate snippet:** <code>.mm-document-content table{overflow-x:visible!important}</code>.

## Position verification

| target  | Current                                                                       | Candidate                                                        |
| ------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| row1    | click p50 8084.9 ms, PAC p50 7429.1 ms, Layerize p50 7429.1 ms (slow)         | click p50 420.5 ms, PAC p50 10.8 ms, Layerize p50 10.8 ms (fast) |
| row1000 | click p50 2501.9 ms, PAC p50 1867.7 ms, Layerize p50 1867.7 ms (intermediate) | click p50 424.0 ms, PAC p50 9.7 ms, Layerize p50 9.7 ms (fast)   |
| row2000 | click p50 650.4 ms, PAC p50 4.9 ms, Layerize p50 9.4 ms (fast)                | click p50 420.3 ms, PAC p50 0.2 ms, Layerize p50 0.3 ms (fast)   |

## Full interaction verification

**Current:** click 7930.5 ms, input→DOM 245.0 ms, input→first idle 15400.8 ms, total 39092.9 ms, post-mutation PAC 7334.8 ms.

**Candidate:** click 401.1 ms, input→DOM 241.7 ms, input→first idle 614.8 ms, total 3203.3 ms, post-mutation PAC 10.4 ms.

## CSS investigation conclusion

A/B/A confirms Delta: overflowOnly as a causal CSS candidate: Current is slow, the candidate is fast, Current again is slow, and the representative compositor traces change in the same direction.

## Selection trigger

**First selection:** click p50 8126.1 ms; selectionchange p50 7913.5 ms; PM selection changes per trial [1,1,1]; compositor Update p50 7489.6 ms.

**Repeat same-cell click:** click p50 15354.9 ms; selectionchange p50 n/a; PM selection changes per trial [0,0,0]; compositor Update p50 7461.9 ms; the two longest CDP RunTask events containing UpdateLifecycle have p50 7644.5 ms / 7462.4 ms.

## Position sensitivity

**Row 1:** from the 2000-row scaling samples, click p50 8126.1 ms; scroll preparation p50 36.9 ms.

**Row 1000:** click p50 2555.6 ms; scroll preparation p50 132.6 ms.

**Row 2000:** click p50 655.6 ms; scroll preparation p50 142.3 ms.

## VS Code Webview

**Headless:** Chrome for Testing 153.0.8010.12; the current ProseMirror condition reports the values above.

**VS Code:** manual-check-required. The Mac was locked and CUA reported that automatic unlock failed, so VS Code could not be opened for this run. Headless Playwright cannot establish whether VS Code's embedded Electron Webview reproduces this lifecycle pause; no native Webview trace was captured. Use the recorded manual procedure and report its measurements separately.

Manual repro notes: docs/performance/issue-119-vscode-webview-manual.md.

## Chromium trace

**Longest lifecycle chain:** RunTask (disabled-by-default-devtools.timeline, 7632.8 ms, parent none, depth 0) → WebFrameWidgetImpl::UpdateLifecycle (blink, 7594.5 ms, parent RunTask, depth 1) → LocalFrameView::RunPaintLifecyclePhase (blink,benchmark, 7576.8 ms, parent WebFrameWidgetImpl::UpdateLifecycle, depth 2) → LocalFrameView::pushPaintArtifactToCompositor (blink, 7476.4 ms, parent LocalFrameView::RunPaintLifecyclePhase, depth 3) → Blink.CompositingCommit.UpdateTime (blink, 7476.4 ms, parent LocalFrameView::pushPaintArtifactToCompositor, depth 4) → Layerize (devtools.timeline, 7476.4 ms, parent Blink.CompositingCommit.UpdateTime, depth 5) → PaintArtifactCompositor::Update (blink, 7476.4 ms, parent Layerize, depth 6)

**RunTask → UpdateLifecycle → RunPaintLifecyclePhase → pushPaintArtifactToCompositor → Layerize → PaintArtifactCompositor::Update:** detailed named events with name, category, start, duration, parent, and depth are in JSON representativeTrace.lifecycleHierarchy and lifecycleEvents.

**Deepest measurable expensive child:** No nested child event was reported under the longest PaintArtifactCompositor::Update.

Top ten measurable descendants under each of the three longest compositor updates are saved in representativeTrace.longestPaintUpdates[].longestChildren. Raw trace: /tmp/markdown-mint-issue119-paint-click-trace.json (34753510 bytes); it is retained outside Git for additional analysis.

## Conclusion

- Scaling: PaintArtifactCompositor::Update p50 rises from 20.0 ms at 100 rows to 7489.6 ms at 2000 rows (ratio 374.1, exponent 1.98); this is approximately quadratic in row count at fixed column count.
- DOM isolation: ProseMirror current p50 8126.1 ms, plain contenteditable p50 7803.7 ms, static table p50 244.8 ms.
- CSS isolation: PaintArtifactCompositor::Update p50 is 7489.6 ms with current CSS and 20.8 ms with minimal CSS; no individually restored tested property reproduced the pause, so one or more omitted rules or a combination of rules remain candidates.
- Selection trigger: first click p50 8126.1 ms with selectionchange p50 7913.5 ms; same-cell repeat p50 15354.9 ms with no selectionchange, but CDP still shows lifecycle tasks p50 7644.5 ms and 7462.4 ms. A selectionchange is therefore not required for the repeat-click lifecycle pause.
- Overlay DOM removal p50 7894.9 ms after removing 8 matched nodes.
- Real End caret validation: 0/3 successful; unsuccessful End trials are excluded. Direct PM end moved PM 146→154 and DOM offset 0→8.
- VS Code Webview: manual-check-required; no Webview runtime measurement is claimed unless its measured fields are populated.

This report contains measurements only. No permanent CSS, table, ProseMirror, or TableControls behavior change was introduced.

## Conditions and environment

- Branch: codex/issue-119-editor-performance
- Measurement base commit SHA: c099a327e4f4c2f6e4c7b0b3b116e393438802e4; instrumentation commit SHA: e87be434c8f8c89a92ebaec7f0f8c12d96e0a55b.
- Capture source note: Only derived aggregation and report labels were corrected after timing capture; browser interaction paths and captured measurements were unchanged.
- Fixture: tests/github-markdown-test-suite/stress/github-table-2000x20.md; 2000 body rows × 20 columns; 434328 bytes; 40020 body/header cells.
- Chromium: 153.0.8010.12; OS: Darwin 25.6.0; CPU: Apple M1 Pro (10 logical CPUs); Node v24.5.0.
- Viewport: 1280×900, device scale factor 1. LongTask PerformanceObserver supported: true.
- Conditions: row scaling 3 per size; plain contenteditable/static/minimal CSS 3 each; overlays 1; first/repeat click shares each 2000-row scaling sample; row 1000/2000 3 each; End correctness 3 each.
- Result JSON: [issue-119-interaction-investigation.json](../../output/benchmark/issue-119-interaction-investigation.json), including this paintCompositorInvestigation dataset.
- Chromium CDP trace categories: devtools.timeline,blink,input,rendering,v8,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame,disabled-by-default-devtools.timeline.layers.
