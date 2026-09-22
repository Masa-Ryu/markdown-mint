# Issue #119 interaction investigation

Generated: 2026-09-22T12:32:50.361Z
Trace summary updated: 2026-09-22T12:32:50.361Z

## Click investigation

Current real click (visible → Playwright resolved): p50/p95/max 15210.7 ms / 15453.3 ms / 15480.3 ms (3 samples)

Playwright click call only: p50 15209.5 ms. Current click → immediate End: 7567.4 ms; combined click+End: 22732.0 ms. Visible → benchmark action start: 1.2 ms; target found → visible: 51.4 ms.

Force click: p50/p95/max n/a / n/a / n/a; immediate End n/a; combined click+End n/a. End keydown reached the page n/a after the click call resolved.

DOM click: call p50 n/a. Diagnostic only; it does not reproduce physical pointer/focus behavior.

Focus only: p50 n/a (editor.focus()).

Direct PM selection: p50 n/a (preparation n/a; dispatch n/a). First follow-up DOM-selection probe confirmed the target after n/a; this is probe availability after dispatch, not proof the browser selection took that long to synchronize.

Event timeline (current click, p50 from action call start):

- scroll: n/a
- pointermove: 55.1 ms
- pointerdown: 182.5 ms
- mousedown: 182.5 ms
- focus/focusin: 183.5 ms
- mouseup: 194.4 ms
- pointerup: 194.3 ms
- selectionchange: 7723.6 ms
- click: 194.6 ms
- PM selection changed: p50 7724.7 ms after click start; in the forced condition End keydown waited n/a after click completion.

posAtCoords: 3 calls; 0.9 ms total; 0.3 ms max.

Selection-only transaction during current click sequence: 3 calls; 153.3 ms total; 53.3 ms max. Phase breakdown is in JSON and this is separate from all dispatchTransaction time.

## End investigation

Real End: p50/p95/max n/a / n/a / n/a after setting the start caret directly in the target cell. In the uninterrupted current click sequence, click → End complete is 7567.4 ms.

KeyboardEvent dispatch only: n/a in-page synchronous dispatch (n/a Playwright evaluate roundtrip); diagnostic only and does not reproduce native editing behavior.

Direct PM end: p50 n/a; first follow-up DOM-selection probe confirmed the target after n/a (same probe-availability caveat as above).

tableEditing disabled: click n/a, End n/a.

spellcheck disabled: click n/a, End n/a, input-to-DOM n/a.

Current input start → DOM reflection: 255.9 ms; complete navigation → reflected input: 24388.6 ms.

End event timeline (real End-only, p50 from key action call start): keydown n/a; selectionchange n/a; keyup n/a. beforeinput: n/a; input: n/a. Full event sequences are in JSON; End normally should omit beforeinput/input.

Selection-only transaction: End-only samples recorded 0 calls, n/a total, n/a max after setup was excluded by per-phase reset. Per-condition counts are in JSON.

Corrected caret validation from the paint/compositor run: standalone real End moved the caret in 0/3 trials. Each attempt stayed at PM position 146 and DOM anchor offset 0 (target text length 8); the raw action duration p50 was about 102 ms and is excluded from successful End latency. Direct PM end moved 146→154 and DOM offset 0→8 in all 3 trials (dispatch p50 40.4 ms; complete evaluate p50 140.3 ms). See [paint/compositor report](issue-119-paint-compositor-investigation.md) and the `endCorrectness` object in the JSON.

## Chromium trace

Trace scope: one separate traced run for each of click, End, and input; trace overhead is excluded from the three-sample condition summaries. Input trace events are clipped at the TypingCommand::InsertText completion marker aligned with the DOM mutation observer. PerformanceObserver tasks after that boundary are reported separately. Raw trace files were not committed; summaries are in the JSON.

Longest tasks:

- unavailable: unavailable (Tracing disabled by MM_EDITOR_INTERACTION_TRACE=0)

Largest event per category in each measured window (selection/input category combines trace event names containing those terms; the input window is keydown → DOM mutation):

- Layout: no event captured
- EventDispatch: no event captured
- FunctionCall: no event captured
- SelectionInput: no event captured
- Paint: no event captured
- Other: no event captured

## Conclusion

- Force click reduces the click call by NaN ms, but the uninterrupted click+End p50 is 22732.0 ms current vs n/a forced. The End keydown in the forced case arrives n/a after the click promise completes, so force moves the wait into the next call rather than removing it.
- Direct PM selection p50 n/a vs real click 15210.7 ms.
- Click trace stages: click event at 194.6 ms, first selectionchange at 7723.6 ms, PM selection update at 7724.7 ms, Playwright resolution at 15210.7 ms.
- The earlier click→End interval was 7567.4 ms, but standalone real End did not move the caret in 0/3 corrected trials; treat that interval as an interaction wait, not a successful caret-move duration. Direct PM end moved to the cell end in 3/3 trials.
- tableEditing disabled click p50 n/a vs current 15210.7 ms.
- spellcheck disabled click p50 n/a vs current 15210.7 ms.
- posAtCoords: 3 calls, 0.9 ms total, 0.3 ms max across current-click samples.
- Selection-only transactions during the click sequence: 3 calls, 153.3 ms total, 53.3 ms max; End-only after setup reset: 0 calls.
- PerformanceObserver recorded 26 long tasks (92291.0 ms total, 7981.0 ms longest) across current click/End/input runs.

These conclusions describe the measured Chromium build, fixture, and environment below. They do not establish causes outside these measured paths.

## Conditions and environment

- Branch: `codex/issue-119-editor-performance`
- Commit SHA: `c099a327e4f4c2f6e4c7b0b3b116e393438802e4`
- Condition measurement commit SHAs: `c099a327e4f4c2f6e4c7b0b3b116e393438802e4`
- Trace capture commit SHA: `c099a327e4f4c2f6e4c7b0b3b116e393438802e4`
- Fixture: `tests/github-markdown-test-suite/stress/github-table-2000x20.md` (434328 bytes, 2000 body rows, 20 columns, 2001 table rows, 40020 cells)
- Chromium: 153.0.8010.12
- OS: Darwin 25.6.0; CPU: Apple M1 Pro (10 logical CPUs)
- Node: v24.5.0; viewport: 1280×900, DPR 1
- tableEditing plugin disabled and spellcheck=false were applied only via benchmark options in this benchmark bundle; no product behavior optimization was made.
- PerformanceObserver longtask support: available.
