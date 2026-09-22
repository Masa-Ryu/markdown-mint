# Issue #119 interaction investigation

Generated: 2026-09-22T10:52:12.739Z
Trace summary updated: 2026-09-22T11:18:16.804Z

## Click investigation

Current real click (visible → Playwright resolved): p50/p95/max 15694.9 ms / 15742.7 ms / 15748.0 ms (3 samples)

Playwright click call only: p50 15693.5 ms. Current click → immediate End: 98.4 ms; combined click+End: 15790.4 ms. Visible → benchmark action start: 1.4 ms; target found → visible: 55.7 ms.

Force click: p50/p95/max 7963.0 ms / 8004.5 ms / 8009.1 ms; immediate End 7891.0 ms; combined click+End 15852.9 ms. End keydown reached the page 7793.2 ms after the click call resolved.

DOM click: call p50 0.6 ms. Diagnostic only; it does not reproduce physical pointer/focus behavior.

Focus only: p50 10.8 ms (editor.focus()).

Direct PM selection: p50 128.4 ms (preparation 4.6 ms; dispatch 123.8 ms). First follow-up DOM-selection probe confirmed the target after 7699.8 ms; this is probe availability after dispatch, not proof the browser selection took that long to synchronize.

Event timeline (current click, p50 from action call start):

- scroll: n/a
- pointermove: 72.0 ms
- pointerdown: 200.4 ms
- mousedown: 200.5 ms
- focus/focusin: 201.4 ms
- mouseup: 213.5 ms
- pointerup: 213.5 ms
- selectionchange: 7915.3 ms
- click: 213.7 ms
- PM selection changed: p50 7916.5 ms after click start; in the forced condition End keydown waited 7793.2 ms after click completion.

posAtCoords: 3 calls; 1.0 ms total; 0.4 ms max.

Selection-only transaction during current click sequence: 3 calls; 160.3 ms total; 54.8 ms max. Phase breakdown is in JSON and this is separate from all dispatchTransaction time.

## End investigation

Real End: p50/p95/max 129.7 ms / 139.7 ms / 140.8 ms after setting the start caret directly in the target cell. In the uninterrupted current click sequence, click → End complete is 98.4 ms.

KeyboardEvent dispatch only: 0.6 ms in-page synchronous dispatch (117.7 ms Playwright evaluate roundtrip); diagnostic only and does not reproduce native editing behavior.

Direct PM end: p50 41.5 ms; first follow-up DOM-selection probe confirmed the target after 7742.3 ms (same probe-availability caveat as above).

tableEditing disabled: click 15820.7 ms, End 102.7 ms.

spellcheck disabled: click 15661.0 ms, End 97.9 ms, input-to-DOM 260.1 ms.

Current input start → DOM reflection: 255.4 ms; complete navigation → reflected input: 17470.9 ms.

End event timeline (real End-only, p50 from key action call start): keydown 0.0 ms; selectionchange n/a; keyup 1.3 ms. beforeinput: n/a; input: n/a. Full event sequences are in JSON; End normally should omit beforeinput/input.

Selection-only transaction: End-only samples recorded 0 calls, 0.0 ms total, 0.0 ms max after setup was excluded by per-phase reset. Per-condition counts are in JSON.

## Chromium trace

Trace scope: one separate traced run for each of click, End, and input; trace overhead is excluded from the three-sample condition summaries. Input trace events are clipped at the TypingCommand::InsertText completion marker aligned with the DOM mutation observer. PerformanceObserver tasks after that boundary are reported separately. Raw trace files were not committed; summaries are in the JSON.

Longest tasks:

- click: 1. RunTask (disabled-by-default-devtools.timeline, 7880.4 ms, parent none); longest nested event WebFrameWidgetImpl::UpdateLifecycle (blink, 7726.8 ms, parent RunTask); 2. RunTask (disabled-by-default-devtools.timeline, 7772.9 ms, parent none); longest nested event WebFrameWidgetImpl::UpdateLifecycle (blink, 7740.4 ms, parent RunTask); 3. RunTask (disabled-by-default-devtools.timeline, 186.0 ms, parent none); longest nested event LatencyInfo.Flow (input,benchmark,latencyInfo, 185.9 ms, parent RunTask); 417592 trace events
- end: 1. RunTask (disabled-by-default-devtools.timeline, 1.0 ms, parent none); 2. RunTask (disabled-by-default-devtools.timeline, 1.0 ms, parent none); longest nested event LatencyInfo.Flow (input,benchmark,latencyInfo, 0.9 ms, parent RunTask); 3. RunTask (disabled-by-default-devtools.timeline, 0.3 ms, parent none); longest nested event Commit (disabled-by-default-devtools.timeline, 0.1 ms, parent RunTask); 340 trace events
- input: 1. RunTask (disabled-by-default-devtools.timeline, 0.2 ms, parent none); 2. RunTask (disabled-by-default-devtools.timeline, 0.1 ms, parent none); 3. RunTask (disabled-by-default-devtools.timeline, 0.1 ms, parent none); 1891 trace events; input window keydown EventDispatch → TypingCommand::InsertText completion (290.9 ms; 136236 outside events clipped); PerformanceObserver post-reflection Long Task 7752.0 ms (outside the clipped input window)

Largest event per category in each measured window (selection/input category combines trace event names containing those terms; the input window is keydown → DOM mutation):

- Layout: Document::UpdateStyleAndLayout (18.2 ms, input)
- EventDispatch: EventDispatch (262.9 ms, input)
- FunctionCall: v8.callFunction (262.9 ms, input)
- SelectionInput: WebFrameWidgetImpl::HandleInputEvent (185.9 ms, click)
- Paint: WebFrameWidgetImpl::UpdateLifecycle (7740.4 ms, click)
- Other: RunTask (7880.4 ms, click)

## Conclusion

- Force click reduces the click call by 7732.0 ms, but the uninterrupted click+End p50 is 15790.4 ms current vs 15852.9 ms forced. The End keydown in the forced case arrives 7793.2 ms after the click promise completes, so force moves the wait into the next call rather than removing it.
- Direct PM selection p50 128.4 ms vs real click 15694.9 ms.
- Click trace stages: click event at 213.7 ms, first selectionchange at 7915.3 ms, PM selection update at 7916.5 ms, Playwright resolution at 15694.9 ms.
- Real End itself is 98.4 ms after a normal click and 129.7 ms standalone; direct PM end dispatch is 41.5 ms. The previously reported 7.6-second End interval does not reproduce as native End key handling in the corrected continuous sequence.
- tableEditing disabled click p50 15820.7 ms vs current 15694.9 ms.
- spellcheck disabled click p50 15661.0 ms vs current 15694.9 ms.
- posAtCoords: 3 calls, 1.0 ms total, 0.4 ms max across current-click samples.
- Selection-only transactions during the click sequence: 3 calls, 160.3 ms total, 54.8 ms max; End-only after setup reset: 0 calls.
- Chromium's click trace contains two 7880.4 ms / 7772.9 ms RunTask long tasks; their dominant nested events are WebFrameWidgetImpl::UpdateLifecycle and WebFrameWidgetImpl::UpdateLifecycle. Both span lifecycle paint/compositing.
- Chromium lifecycle paint/compositing is the dominant measured stage: its largest click event is WebFrameWidgetImpl::UpdateLifecycle at 7740.4 ms, while the largest Layout event across traces is 18.2 ms.
- PerformanceObserver recorded 27 long tasks (94841.0 ms total, 7912.0 ms longest) across current click/End/input runs.
- In the traced typing sample, the DOM mutation occurred 290.5 ms after keydown. A separate PerformanceObserver Long Task began after that mutation and lasted 7752.0 ms; it is outside the clipped input trace window and accounts for the longer Playwright typing roundtrip (15959.1 ms).

These conclusions describe the measured Chromium build, fixture, and environment below. They do not establish causes outside these measured paths.

## Conditions and environment

- Branch: `codex/issue-119-editor-performance`
- Commit SHA: `64aac441cbbc1b7d8f31ddc7a2691a3281a32406`
- Condition measurement commit SHAs: `f70f2e6d61b488f821970e309c8cca401c1fde81`, `64aac441cbbc1b7d8f31ddc7a2691a3281a32406`
- Trace capture commit SHA: `27d8677326ca15cff00ff994a75c863e2b9234e1`
- Fixture: `tests/github-markdown-test-suite/stress/github-table-2000x20.md` (434328 bytes, 2000 body rows, 20 columns, 2001 table rows, 40020 cells)
- Chromium: 153.0.8010.12
- OS: Darwin 25.6.0; CPU: Apple M1 Pro (10 logical CPUs)
- Node: v24.5.0; viewport: 1280×900, DPR 1
- tableEditing plugin disabled and spellcheck=false were applied only via benchmark options in this benchmark bundle; no product behavior optimization was made.
- PerformanceObserver longtask support: available.
