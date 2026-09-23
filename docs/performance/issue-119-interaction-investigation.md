# Issue #119 interaction investigation

Generated: 2026-09-22T12:32:50.361Z
Trace summary updated: 2026-09-22T23:14:01.780Z

## Click investigation

Current real click (visible → Playwright resolved): p50/p95/max 15016.6 ms / 15053.0 ms / 15057.0 ms (3 samples)

Playwright click call only: p50 15015.6 ms. Current click → immediate End: 7359.5 ms; combined click+End: 22370.2 ms. Visible → benchmark action start: 1.1 ms; target found → visible: 46.6 ms.

Force click: p50/p95/max n/a / n/a / n/a; immediate End n/a; combined click+End n/a. End keydown reached the page n/a after the click call resolved.

DOM click: call p50 n/a. Diagnostic only; it does not reproduce physical pointer/focus behavior.

Focus only: p50 n/a (editor.focus()).

Direct PM selection: p50 n/a (preparation n/a; dispatch n/a). First follow-up DOM-selection probe confirmed the target after n/a; this is probe availability after dispatch, not proof the browser selection took that long to synchronize.

Event timeline (current click, p50 from action call start):

- scroll: n/a
- pointermove: 59.7 ms
- pointerdown: 179.4 ms
- mousedown: 179.4 ms
- focus/focusin: 180.4 ms
- mouseup: 191.3 ms
- pointerup: 191.3 ms
- selectionchange: 7552.3 ms
- click: 191.5 ms
- PM selection changed: p50 7553.4 ms after click start; in the forced condition End keydown waited n/a after click completion.

posAtCoords: 3 calls; 0.8 ms total; 0.3 ms max.

Selection-only transaction during current click sequence: 3 calls; 155.2 ms total; 52.0 ms max. Phase breakdown is in JSON and this is separate from all dispatchTransaction time.

## End investigation

Real End: 0/0 trials moved the caret to the cell end. Only successful trials contribute to the p50/p95/max n/a / n/a / n/a. Unsuccessful trials (including before/after PM position and DOM offset) remain in JSON and are excluded from latency summaries. In the uninterrupted current click sequence, click → End complete is 7359.5 ms.

KeyboardEvent dispatch only: n/a in-page synchronous dispatch (n/a Playwright evaluate roundtrip); diagnostic only and does not reproduce native editing behavior.

Direct PM end: p50 n/a; first follow-up DOM-selection probe confirmed the target after n/a (same probe-availability caveat as above).

tableEditing disabled: click n/a, End n/a.

spellcheck disabled: click n/a, End n/a, input-to-DOM n/a.

Current input keydown → DOM mutation: 278.8 ms; after mutation, longest Long Task 7438.0 ms, cumulative Long Tasks 7850.0 ms, and input → first idle 7892.6 ms. Complete navigation → reflected input: 31449.1 ms. These are separate milestones; DOM mutation alone is not treated as interaction settled.

End event timeline (real End-only, p50 from key action call start): keydown n/a; selectionchange n/a; keyup n/a. beforeinput: n/a; input: n/a. Full event sequences are in JSON; End normally should omit beforeinput/input.

Phase attribution: pointer/keyboard events are timestamped with the browser phase that was active at dispatch. PM selection and selection-only transaction events capture phase and phase-local start inside the transaction path; no post-hoc phase inference is used. Each sample retains clickStartedAt, endStartedAt, inputStartedAt, and directSelectionStartedAt where applicable.

Selection-only transaction: End-only samples recorded 0 calls, n/a total, n/a max after setup was excluded by per-phase reset. Per-condition counts are in JSON.

## Chromium trace

Trace scope: one separate traced run for each of click, End, and input; trace overhead is excluded from the three-sample condition summaries. Input trace events are clipped at the TypingCommand::InsertText completion marker aligned with the DOM mutation observer. PerformanceObserver tasks after that boundary are reported separately. Raw trace files were not committed; summaries are in the JSON.

Longest tasks:

- click: 1. RunTask (disabled-by-default-devtools.timeline, 7463.1 ms, parent none); longest nested event WebFrameWidgetImpl::UpdateLifecycle (blink, 7314.8 ms, parent RunTask); 2. RunTask (disabled-by-default-devtools.timeline, 7416.2 ms, parent none); longest nested event WebFrameWidgetImpl::UpdateLifecycle (blink, 7389.7 ms, parent RunTask); 3. RunTask (disabled-by-default-devtools.timeline, 170.1 ms, parent none); longest nested event LatencyInfo.Flow (input,benchmark,latencyInfo, 170.0 ms, parent RunTask); 416174 trace events
- end: 1. RunTask (disabled-by-default-devtools.timeline, 1.1 ms, parent none); 2. RunTask (disabled-by-default-devtools.timeline, 0.8 ms, parent none); longest nested event LatencyInfo.Flow (input,benchmark,latencyInfo, 0.8 ms, parent RunTask); 3. RunTask (disabled-by-default-devtools.timeline, 0.3 ms, parent none); longest nested event Commit (disabled-by-default-devtools.timeline, 0.1 ms, parent RunTask); 338 trace events
- input: 1. RunTask (disabled-by-default-devtools.timeline, 0.4 ms, parent none); 2. RunTask (disabled-by-default-devtools.timeline, 0.1 ms, parent none); 3. RunTask (disabled-by-default-devtools.timeline, 0.1 ms, parent none); 1709 trace events; input window keydown EventDispatch → TypingCommand::InsertText completion (272.4 ms; 134693 outside events clipped); PerformanceObserver post-reflection Long Task 7471.0 ms (outside the clipped input window)

Largest event per category in each measured window (selection/input category combines trace event names containing those terms; the input window is keydown → DOM mutation):

- Layout: Document::UpdateStyleAndLayout (16.7 ms, input)
- EventDispatch: EventDispatch (246.8 ms, input)
- FunctionCall: v8.callFunction (246.8 ms, input)
- SelectionInput: WebFrameWidgetImpl::HandleInputEvent (170.0 ms, click)
- Paint: WebFrameWidgetImpl::UpdateLifecycle (7389.7 ms, click)
- Other: RunTask (7463.1 ms, click)

## Conclusion

- Force click reduces the click call by NaN ms, but the uninterrupted click+End p50 is 22370.2 ms current vs n/a forced. The End keydown in the forced case arrives n/a after the click promise completes, so force moves the wait into the next call rather than removing it.
- Direct PM selection p50 n/a vs real click 15016.6 ms.
- Click trace stages: click event at 191.5 ms, first selectionchange at 7552.3 ms, PM selection update at 7553.4 ms, Playwright resolution at 15016.6 ms.
- Real End itself is 7359.5 ms after a normal click and n/a standalone; direct PM end dispatch is n/a. The previously reported 7.6-second End interval does not reproduce as native End key handling in the corrected continuous sequence.
- tableEditing disabled click p50 n/a vs current 15016.6 ms.
- spellcheck disabled click p50 n/a vs current 15016.6 ms.
- posAtCoords: 3 calls, 0.8 ms total, 0.3 ms max across current-click samples.
- Selection-only transactions during the click sequence: 3 calls, 155.2 ms total, 52.0 ms max; End-only after setup reset: 0 calls.
- Chromium's click trace contains two 7463.1 ms / 7416.2 ms RunTask long tasks; their dominant nested events are WebFrameWidgetImpl::UpdateLifecycle and WebFrameWidgetImpl::UpdateLifecycle. Both span lifecycle paint/compositing.
- Chromium lifecycle paint/compositing is the dominant measured stage: its largest click event is WebFrameWidgetImpl::UpdateLifecycle at 7389.7 ms, while the largest Layout event across traces is 16.7 ms.
- PerformanceObserver recorded 29 long tasks (90976.0 ms total, 7448.0 ms longest) across current click/End/input runs.
- In the traced typing sample, the DOM mutation occurred 272.0 ms after keydown. A separate PerformanceObserver Long Task began after that mutation and lasted 7471.0 ms; it is outside the clipped input trace window and accounts for the longer Playwright typing roundtrip (15306.0 ms).

These conclusions describe the measured Chromium build, fixture, and environment below. They do not establish causes outside these measured paths.

## Conditions and environment

- Branch: `codex/issue-119-editor-performance`
- Commit SHA: `c099a327e4f4c2f6e4c7b0b3b116e393438802e4`
- Condition measurement commit SHAs: `e87be434c8f8c89a92ebaec7f0f8c12d96e0a55b`
- Trace capture commit SHA: `e87be434c8f8c89a92ebaec7f0f8c12d96e0a55b`
- Fixture: `tests/github-markdown-test-suite/stress/github-table-2000x20.md` (434328 bytes, 2000 body rows, 20 columns, 2001 table rows, 40020 cells)
- Chromium: 153.0.8010.12
- OS: Darwin 25.6.0; CPU: Apple M1 Pro (10 logical CPUs)
- Node: v24.5.0; viewport: 1280×900, DPR 1
- tableEditing plugin disabled and spellcheck=false were applied only via benchmark options in this benchmark bundle; no product behavior optimization was made.
- PerformanceObserver longtask support: available.
