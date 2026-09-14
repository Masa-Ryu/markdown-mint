# Requirements and implementation status

This page keeps the original R01–R08 identifiers unchanged. Status is based on
the unit suite, the installed VS Code Extension Development Host acceptance
run (`npm run test:extension`), and the completed browser parity pass. Browser
evidence and native API evidence are recorded separately; browser-level
composition events are covered by regression tests, while the real operating
system IME candidate UI remains unverified.

| Requirement | Intended behavior                                | Implementation and current evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R01         | Rich Markdown editing in VS Code                 | The dedicated editor uses the shared ProseMirror schema, Markdown parser, serializer, and commands. The host treats the VS Code `TextDocument` as the only source of truth. The 0.0.3 browser pass exercised toolbar word selection, list editing, code-language mouse editing, image loading, and source preservation after DOM observation and an edit. Rich IME behavior remains a manual check.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| R02         | Buttons, toolbar, and menu actions               | The Mint toolbar keeps heading, B/I/S, inline code, link, image, list, table, format, undo, and redo actions as direct buttons. The **Source** button returns to VS Code's standard raw Markdown editor, and dedicated preview remains a command-palette command; the 0.0.3 native acceptance suite verified command registration and format execution.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| R03         | Direct mouse manipulation                        | ProseMirror selection, drag, image, and table interactions are wired in the webview editor. The 0.0.3 browser pass verified toolbar word selection, code-language mouse editing, image loading, and preservation of the raw relative image path after DOM observation and an edit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| R04         | Rectangular table selection and matrix clipboard | ProseMirror tables use a rectangular selection and matrix clipboard path, with Markdown round trips in the core tests. In the 0.0.3 evidence, a real 2×3 rectangle copy/paste preserved its dimensions and one Undo request restored the prior table in the browser harness; native VS Code resource Undo/Redo was verified independently.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| R05         | Keyboard operations                              | Webview keymaps cover formatting, lists, tables, undo, redo, and navigation. Within a table, Enter moves to the next row in the same column and adds one row at the bottom when needed; Shift+Enter remains an in-cell hard break, and Tab/Shift+Tab retain cell navigation. Plain ArrowLeft/Right/Up/Down use one actual-target graph: flow-to-flow and flow-to-structural transitions are direct, while only adjacent structural-to-structural targets expose one `BlockBoundarySelection` insertion stop. `EditorView.endOfTextblock` preserves native visual-row movement for interior text. Wrapped continuation rows, controls, modifiers, IME, and expanded-code focus remain guarded. Regression tests cover composition guards, Markdown round trips, and host-backed undo/redo; real operating system IME candidate behavior remains a manual check. |
| R06         | Identical editor and preview output              | The dedicated preview and native Markdown preview use the same profile-aware core rendering path and shared `media/document.css`; the package contributes that stylesheet and a MarkdownIt adapter to the built-in preview. In the 0.0.3 evidence, across two fixtures and three viewport/typography combinations covering widths 1100 and 500 with Arial 14 and Georgia 20 cases, actual bundled rich output, core HTML, and the installed VS Code `markdown.css`/shared CSS produced matching block and table-cell metrics. The dedicated preview switch was included. Native API checks separately verified headings, GitHub/CommonMark table behavior, and relative image resources. Typography values are copied from `markdown.preview.*`.                                                                                                               |
| R07         | GitHub and GitLab profiles                       | `github`, `gitlab`, and `commonmark` are validated protocol/profile values. Profile settings reach the editor, dedicated preview, and native adapter. The 0.0.3 native acceptance suite verified GitHub versus CommonMark table output; GitLab-specific fixtures remain a follow-up compatibility check.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| R08         | Safe formatting and format-on-save               | Prettier runs with the bundled Markdown parser/plugin, after/before core validation, project `.prettierrc` JSON/YAML options, `.editorconfig` EOL settings, `.prettierignore`, and explicit extension option overrides. Save-time failures leave the source unchanged, write diagnostics to the Markdown Mint output channel, and use a standard VS Code error notification when user action is required. The VS Code auto-save setting is not changed by the extension.                                                                                                                                                                                                                                                                                                                                                                                       |

## Quality requirements

| Requirement                            | Implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q01 authoritative synchronization      | Every webview edit and save request carries the protocol version, document version, and operation id. The host serializes requests per document, checks the version before and after asynchronous validation, applies one minimal `WorkspaceEdit`, and acknowledges from the resulting `TextDocument` change. The webview retains the exact base Markdown for pending input, keeps only the newest queued edit, ignores delayed acknowledgements for completed operations, and uses a conservative three-way merge for independent external changes. Save results distinguish the requested version, the version known to be on disk, the current version, and current dirty state; external changes are broadcast to every panel. |
| Q02 native history and conflict safety | Undo and redo invoke VS Code commands and wait for the authoritative document change; the host keeps no second snapshot history. A stale edit is rebased against its exact base when the local and external changes do not overlap. Unmergeable edits keep both the local draft and external source available, pause only the unsafe operation, and use the standard source-editor/notification path. Recovery data is scoped by document id, base source, version, and profile, and never overwrites a different document.                                                                                                                                                                                                        |
| Q03 webview security                   | Webviews use a nonce-based strict CSP, bounded `localResourceRoots`, safe image/link rendering, bounded message fields, and no arbitrary command or filesystem bridge.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Q04 profile and resource limits        | Markdown sources are capped at two million UTF-16 code units, operation ids and resource URLs are bounded, and relative local images resolve through scoped webview resources.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## Synchronization, save, and recovery boundary

The host `TextDocument` remains the sole authoritative source. Webview input is
sent as one operation at a time; later typing replaces the queued candidate but
never the in-flight snapshot. A duplicate or delayed acknowledgement for an
already-observed version is ignored, while a newer acknowledgement from
another panel is treated as an authoritative external update. If a host
notification reports a newer source, Markdown Mint compares the exact pending
base, local draft, and external source. Non-overlapping line changes are applied to the latest source;
overlapping changes, repeated stale responses (maximum three attempts or
30 seconds), and actual workspace-application failures preserve the local
draft and stop only the unsafe path.

Saving is a separate operation. The save request records the version it asked
VS Code to save. A successful `TextDocument.save()` remains successful even if
new input arrives afterward; that input stays dirty and is synchronized as its
own edit. `savedVersion` is reported only when the resulting document is known
to be clean, so a later version is never mislabeled as the version on disk.
Format-on-save uses the existing VS Code save lifecycle and does not alter the
user's auto-save setting. Real save failures are recorded in the Markdown Mint
Output channel and surfaced through VS Code's error notification.

Recovery state is retained independently of the editor DOM. After webview
recreation, a draft is restored automatically only when its document id,
profile, and exact base source still match; an empty draft is valid. A draft
from another document or a changed base remains stored and is not silently
applied. Parser failures keep the raw Markdown and route editing to VS Code's
standard source editor. Serializer failures keep the ProseMirror state and a
JSON recovery snapshot without replacing it with `lastValidMarkdown`. Native
filesystem read-only constraints are never overridden.

There is no dedicated bottom status element, empty status bar, or persistent
replacement banner for these internal states. Only an actual save failure or
an external change that cannot be safely integrated requires a standard VS Code
notification; the preserved source and local draft remain available at that
boundary. The acceptance fixtures used for the current manual/browser check
are `md/common-test.md`, `md/github-test.md`, `md/github-test-class-B.md`,
`md/gitlab-test.md`, and `md/gitlab-test-class-B.md`.

## Current UI refinement

The following interaction and validation record belongs to the 0.0.3 UI pass.
The focused browser checks were complete in that build. Native integration was
exercised separately there; native VS Code visual geometry is kept distinct
from the browser evidence.

## Mermaid editor modal (0.1.0)

Mermaid Insert and Edit dialogs use a large, viewport-bounded layout with the
source editor occupying the flexible space between the title/status header and
the action row. The visual “Diagram source” label is hidden, while the
textarea retains its accessible name. The header reports the bundled Mermaid
runtime version and the current validation state, including a humanized
diagram type after a successful parse.

The dialog titles are `Insert Mermaid` and `Edit Mermaid`; the shared feature
labels and the existing Math, Alert, Details, and other feature dialog titles
remain unchanged.

Validation removes the same NUL characters and Mermaid directives as the
renderer before calling the bundled Mermaid runtime's `parse()` method. It is
debounced during typing, rejects empty and over-limit input, and guards
delayed results against newer input or a closed dialog. Insert and Update,
including Ctrl/Cmd+Enter, require a current successful validation result.
The renderer continues to use the existing strict security configuration and
sanitization path.

## Image file drag-and-drop import (0.2.0)

The Rich Editor consumes a drop only when `DataTransfer.files` contains a
potential image. PNG, JPEG/JPG, GIF, and WebP files are read in the Webview and
sent as bounded base64 payloads; the Webview never writes to the filesystem.
The Extension Host validates the MIME type and extension again, decodes the
payload with the 10 MB limit, creates the Markdown document's sibling `images`
directory through `workspace.fs`, chooses the first unused basename (then
`-1`, `-2`, and so on), and returns only a `./images/<name>` source path. SVG,
arbitrary MIME/extension combinations, unsafe names, oversized payloads, and
failed writes leave the Markdown document unchanged and use the existing VS
Code error notification route. Existing non-image ProseMirror drops continue
through the normal handler.

Each imported file receives an independent request id. Its pending drop
position is held in a ProseMirror plugin state and widget decoration; every
transaction maps that position, and the existing `image` node is inserted only
after the host returns. Pending decorations are not serialized, and the normal
image insertion transaction is undoable while the saved file is intentionally
retained on Undo.

Protocol, Extension Host, and Webview regressions cover validation, duplicate
names, unsafe paths, size and write failures, non-image fall-through, mapped
positions, multiple-file order, failure cleanup, and temporary-state
non-serialization. The browser block suite also passed all five required
fixtures (`common-test.md`, `github-test.md`, `github-test-class-B.md`,
`gitlab-test.md`, and `gitlab-test-class-B.md`) on Rich, dedicated preview, and
native-preview surfaces. The installed Extension Development Host could not
complete this run because VS Code terminated with `SIGABRT`; direct Finder or
Explorer drag/drop, GIF animation, native host persistence, and operating-system
IME behavior remain manual checks.

## Alert inline editing refinement

Alerts keep their existing visual design and raw Markdown representation while
their inline textarea becomes more responsive. Alert input updates the source
without rebuilding the textarea on every keystroke, resizes before dispatching
the source update, preserves lazy blockquote continuation lines and quoted
blank lines, and keeps the source line-ending style. Preview and compatibility
updates are coalesced for a burst of native textarea input while source,
recovery, and host synchronization remain immediate. An ArrowRight at the body
end or ArrowLeft at the body start moves directly to a consecutive Alert body
or adjacent text block; the reverse boundary moves from a paragraph into the
Alert body. At the final Alert, an arrow is handled without changing the
selection, document, or scroll position. Textarea composition events,
non-collapsed selections, and native host Undo/Redo commands keep their native
behavior.

The webview regression suite covers these flows, including CRLF and
save/reload round trips. Live VS Code and operating-system IME behavior remain
manual checks.

Alert bodies remain directly editable on a single click. The header and body
both open the existing Profile Feature dialog on a double click; Alert type
and detailed body changes are made there. A single click on the header does not
open a picker or dialog. The dialog flushes the native textarea before taking
its edit snapshot, retains stale-target and composition/conflict guards, and
restores the body caret after Cancel or Update.

## Alert body focus and modal editing (0.0.37)

The Alert NodeView still uses a ProseMirror `NodeSelection` for block-boundary
navigation. Focusing its native textarea adds the `mm-alert-body-focused`
visual state, which suppresses only the selected-node outline while the body
has focus; blur removes that state. Opening the edit dialog uses a separate
`mm-alert-dialog-open` state so the background Alert does not show a blue block
outline while the dialog is active.

The old single-click type picker, select, and **Edit source…** action are no
longer rendered. Physical header clicks are inert, while a zero-detail
synthetic click from programmatic or assistive-technology activation, keyboard
Enter/Space, or a header/body double click uses the existing Alert edit dialog.
The physical clicks that precede a double click remain inert. Cancel restores
the original body selection without a host edit. Update changes the existing
Alert in place, preserving marker/body source behavior and the existing
stale-document, conflict, recovery, and composition protections.

## Alert header activation semantics (0.0.38)

The Alert header remains a focusable `role="button"` with the accessible name
`Edit Alert`. Physical mouse clicks use their nonzero `MouseEvent.detail` and
remain inert, including the clicks that precede a double click. A zero-detail
synthetic click, Enter, or Space uses the same guarded edit-dialog path. An
already-open dialog absorbs the follow-up synthetic event so it cannot flush or
open a second dialog.

## Rendered block editing and selection (0.0.39)

Math and Mermaid rendered blocks no longer show a persistent source label. Their
NodeView is focusable with an accessible Edit Math or Edit Mermaid name; a
physical single click keeps normal selection behavior, while a double click or
Enter/Space reuses the existing guarded Profile Feature edit dialog. Double
clicks and keyboard events from links, buttons, inputs, selects, and textareas
inside a renderer are left to those controls.

Details and Code NodeViews select the whole ProseMirror node when their outer
padding, Details header whitespace, Code header whitespace, or line numbers are
clicked. Details toggles, summary controls, body content, Code text, language
controls, menus, and Copy/Expand/More actions retain their existing behavior.
The nearest nested Details owns its padding event and stops it before an outer
NodeView can observe it. Selection transactions set `addToHistory: false`, so
selection alone emits no host edit or dirty state; standard ProseMirror
Delete/Backspace then removes the selected block and the host-backed Undo/Redo
path restores its exact source.

## Details scanner inline token boundaries (0.0.36)

Details range discovery now asks markdown-it's inline tokenizer which source
fragments are actual `html_inline` tokens. It accepts a candidate only when the
complete token is a `<details>` or `</details>` tag. A `<span>` token therefore
consumes its quoted attributes as one unit; strings such as `title="</details>"`
or `data-open="<details>"` cannot close or nest the surrounding block. The same
token boundary keeps link destinations and titles, image alt labels, entities,
and escaped punctuation out of the Details stack. `code_inline` tokens are
opaque. HTML comments remain atomic, while a real Details token after a comment
terminator on the same line remains discoverable.

The position wrapper records `state.pos` when markdown-it emits each inline HTML
token; it does not rebuild or normalize the HTML. Image-label child tokenization
is intentionally outside the enclosing state, so an alt label containing
`</details>` is not promoted to a candidate. The existing block analysis still
provides the paragraph, fence, raw HTML, quote, list, heading, and math ranges,
and the configured GitHub, GitLab, and CommonMark parser is used for every
inline context. The caller's `html` option is restored after the temporary scan.

Summary splitting uses the same actual boundary tokens to locate `</summary>`.
Consequently an inline attribute containing `</summary>` cannot truncate a
summary source, while a real Details/summary token inside a summary still marks
that header unsupported. Profile-aware cached ranges and immutable-node WeakMap
entries continue to serve rendering, serialization, and direct heading edits.
All source bytes, tag spelling, attribute order, quote style, entities, unknown
HTML, separators, and LF/CRLF/CR endings remain source-preserving.

Core regressions cover double and single quoted attributes, `>` and `&quot;`,
opening/closing strings together, inline summary attributes, link titles,
image alt text, all three profiles, and a caller parser whose HTML option starts
disabled. The earlier block-context, raw HTML type 1–7, nested Details, escape
parity, Math/table, 80+ Details cache, heading-ID/TOC, Alert, Code, and cursor
regressions remain in the suite. The browser regression opens a structured
Details containing Details-like strings in summary and body HTML attributes,
toggles it without edits, single-click edits the summary, types in the body,
and compares every saved source byte. The inline HTML is rendered safely and no
dialog is opened.

Final 0.0.36 verification includes the latest main integration from 0.0.35.
The core suite has 566 tests across 33 files; 31 new cases cover this inline
boundary fix and all earlier Details regressions remain enabled. `npm run
compile`, `npm test`, `npm run lint` (zero errors, 49 warnings), `npm run
format:check`, `npm run test:browser:blocks` (16 groups plus the five required
fixtures on Rich, Dedicated Preview and native-preview surfaces), `npm run
test:browser:spacing` (37 cases on each surface), `npm run test:extension`
(isolated installed VS Code, exit 0), `npm run package` (96-file 0.0.36 VSIX,
4.76 MB, bundled formatter verification), and `git diff --check` passed. Real
OS Japanese IME candidate UI, cross-region selection/copy/cut, zoom, and
visible native Undo/Redo remain manual checks.

Final 0.0.37 verification adds the Alert body/header click matrix and visual
outline assertions to the existing suite. The targeted Alert webview tests and
the full browser Alert flow cover single-click body editing, single-click
header inertness, body/header double-click dialog reuse, latest textarea input
flushing, Cancel/Update focus restoration, and absence of the picker controls.

Final 0.0.38 verification adds physical versus synthetic header activation,
Enter/Space keyboard activation, and duplicate-dialog suppression assertions.

Final 0.0.39 verification adds rendered Math/Mermaid double-click and
Enter/Space dialog activation, source-label absence, interactive-child guards,
and Details/Code padding, header, line-number, nested-selection, deletion, and
host-Undo checks. The unit suite has 591 tests across 33 files. `npm run
compile`, `npm test`, `npm run lint` (zero errors, 48 existing warnings),
`npm run format:check`, `npm run test:browser:blocks` (17 interaction groups
plus the five required fixtures on Rich, Dedicated Preview and native-preview
surfaces), `npm run test:browser:spacing` (37 cases on each surface),
`npm run test:extension` (isolated installed VS Code, exit 0), `npm run
package` (96-file 0.0.39 VSIX, 4.76 MB, bundled formatter verification), and
`git diff --check` passed. Real OS Japanese IME candidate UI and cross-region
selection/copy/cut remain manual checks.

## Details scanner block contexts (0.0.35)

Details discovery uses the configured profile's markdown-it block parser before
examining inline syntax. Each inline token supplies a bounded source range:
unmatched backticks cannot reach a later heading, list, quote, fence or HTML
block. The scanner no longer approximates paragraph boundaries with blank lines.
The rule that exposes Details wrappers and their summaries runs only during this
analysis pass; normal Markdown parsing retains its existing rules. Real nested
Details remain transparent, including when wrappers have no intervening blank
lines. Original offsets are mapped across LF, CRLF and CR without rewriting source.

This follows [CommonMark block-before-inline precedence](https://spec.commonmark.org/0.31.2/#precedence)
and the [seven HTML block types](https://spec.commonmark.org/0.31.2/#html-blocks).
Types 1 (script/pre/style/textarea), 3 (processing instructions), 4 (declarations),
5 (CDATA), and ordinary type 6/7 HTML blocks are opaque to Details discovery.
Type 2 comments are consumed atomically; the existing supported case of real
Details markup after a comment terminator on the same line remains supported.
Only Details wrappers and summaries within an open Details are exposed instead
of treating the complete wrapper as a type 6 HTML block. Type 6/7 content stays
opaque until the blank-line boundary supplied by markdown-it; an outer closer
inside that region cannot close a structured Details and remains preserved raw.
Raw HTML is never rebuilt as an HTML tree for serialization.

Tests compare the installed markdown-it 14.3.1 token maps, including ordered
lists starting at one versus two, setext headings, and type 7 HTML that cannot
interrupt a paragraph. Existing escape parity, remaining delimiter runs, comments,
code spans, fenced code and all source-preservation regressions remain intact.
The core reuses its profile-configured parser and passes detected tag ranges
directly to the Details splitter. A bounded source/profile cache shares these
parts with rendering, serialization and header editing, including profile math
blocks. Immutable node attributes also retain parts through a WeakMap, so a
document exceeding the bounded cache does not rescan each Details during redraw.
Wrapper depth is local to markdown-it's recursive quote/list tokenization.
A source boundary before an edited Details or after unchanged raw HTML
is retained rather than supplemented with a blank line; existing CR and mixed
blank separators are recognized independently of generated line endings.

The real-browser regression opens an unmatched-backtick paragraph followed by a
Details containing a script string with `</details>`. It opens/closes the Details
without an edit message, single-clicks and types into the summary, and types
directly into the body. Each save is compared with exact expected Markdown,
including `data-test="keep"`, the complete inert script, and unchanged separators.
The script is not executed. The screenshot is
`output/playwright/block-editing/details-unmatched-backtick-raw-script.png`.

An instrumented local check found zero additional scanner calls on two renders
of documents containing 100/300 sibling Details or 60/100/140 nested Details.
The 100/140-level renders took about 28/35 ms, comparable with 27/34 ms before
this change. The five required fixtures took about 1.1–6.2 ms for an uncached
parse plus unchanged serialization; these are local observations, not timing
thresholds in the regression suite.

Final 0.0.35 verification includes latest main `a8afcdd` and its save/recovery
changes. Alert composition/rebase integration retains accepted input and is
covered by three additional synchronization tests. The Details change adds 48
core cases (all previous 44 remain unchanged), nine profile-aware NodeView
cases, and one real-browser workflow. An 80-Details fixture checks exact edits
after visiting another large document, without relying on implementation details
or timing assertions. `npm run compile`, `npm test` (535 tests in 33 files),
`npm run lint` (zero errors, 49 existing warnings), `npm run format:check`,
`npm run test:browser:blocks` (15 groups plus five required fixtures on three
surfaces), `npm run test:browser:spacing` (37 cases on each of three surfaces),
and `npm run test:extension` (installed VS Code, exit 0) passed.
`npm run package` produced `markdown-mint-0.0.35.vsix` (96 files, 4.76 MB) and
passed bundled formatter verification. `git diff --check` passed.

Real OS Japanese IME candidate UI, cross-region selection/copy/cut, zoom and
visible native Undo/Redo remain manual checks. Synthetic composition and browser
keyboard checks do not establish those results. PR #23 remains a draft.

## Details scanner escaped syntax (0.0.34)

The scanner checks consecutive backslashes immediately before a candidate
backtick or `<`: odd counts escape that character, while even counts leave it
available as syntax. Only the escaped character is consumed, so the remaining
backticks in a run can still start a shorter code span. Escaped comment openers
and Details tags remain ordinary Markdown text; an escaped closing tag in a
Details body cannot close its outer block.

This follows [CommonMark 0.31.2 backslash escapes](https://spec.commonmark.org/0.31.2/#backslash-escapes)
and was checked against the installed markdown-it 14.3.1 CommonMark parser.
Backslashes inside already-open code or HTML comments remain literal, so they
do not prevent a real closing delimiter. Code-span matching also stops at blank
lines, respecting [block-before-inline precedence](https://spec.commonmark.org/0.31.2/#precedence):
the supplied even-backslash example contains separate paragraphs, not one code
span spanning the intervening Details. CRLF remains a single line ending.

The implementation adds one small parity helper and bounds the existing code
delimiter search. It retains sequential consumption of fences, code spans, and
real comments, with no new Markdown parser or whole-document exclusion pass.
Original source bytes, tags, attributes, and line endings remain preserved.

There are 29 additional core cases covering odd/even backslashes, escaped
comment/tag openers, escaped outer closers, remaining delimiter runs, literal
backslashes inside code/comments, and single versus blank LF/CRLF/CR boundaries.
Existing nested Details, quoted attributes, malformed fallback, long code spans,
fences, comments, and round-trip tests remain intact. The browser regression
edits a Details summary by single click and types directly into its body between
escaped backtick paragraphs, checking exact saved Markdown and quoted attributes.

The 2026-09-12 verification on main `5372934` plus this change passed
`npm run compile`, `npm test` (463 tests in 33 files), `npm run lint` (zero errors,
33 existing warnings), `npm run format:check`, `npm run test:browser:blocks`
(14 groups, including all five required documents on three surfaces),
`npm run test:browser:spacing` (37 cases per surface), and
`npm run test:extension` (installed VS Code, exit 0). The browser run saved
93 screenshots, including `details-escaped-backticks.png`. The previous Alert
conflict, expanded-code caret, code/comment exclusion, and heading/TOC tests also
passed. The version is 0.0.34; OS IME, cross-region clipboard, zoom, and visible
native Undo/Redo checks remain the manual boundaries documented below.
`npm run package` produced `markdown-mint-0.0.34.vsix` (96 files, 4.75 MB) and
passed standalone bundled-formatter verification. `git diff --check` passed.

## Direct block editing and navigation (0.0.32–0.0.33)

Code keeps its editable ProseMirror contentDOM, language search/custom names,
metadata-removal confirmation, copy, line numbers, highlight, wrap, and expand
controls. Clicking the language label once opens the chooser; chooser arrows
stay in the candidate list. The chooser initially focuses its search input
without activating a candidate, keeps only the configured language selected,
and switches between keyboard active indication and pointer hover feedback
while preserving the existing DOM focus behavior. An empty Enter does not
remove a language; removal remains an explicit selection of **Language not
specified**. A language-only change preserves the original fence, line
endings, body whitespace, and metadata.

Alert keeps its native textarea and source-preserving marker/body writer. Its
outer ProseMirror NodeSelection identifies the owning Alert while the native
textarea owns the character selection. Body input continues through the same
host synchronization, recovery, clipboard, and Undo/Redo path. Moving focus
alone creates no edit. The textarea measures its height after attachment and
when its width changes so wrapped body text remains visible.

Details uses a structured `details` node with the same ProseMirror body surface
as ordinary paragraphs, lists, nested Details, and code. The arrow button alone
toggles visibility; a single click on the summary opens a one-line input,
including while collapsed. Enter commits, Escape cancels only this draft, and
blur/Tab commit without reclaiming the explicitly chosen focus. Empty summaries
are preserved. Existing summary HTML/Markdown is edited as source so decoration
and unknown attributes are retained. The original opening/summary/closing tags
and a nested source snapshot preserve untouched body bytes and nested blocks.
Malformed or unsupported summary structures remain raw, source-preserving
rendered blocks; they do not gain a misleading flattened body editor.

Details expansion is local display state, independent of the Markdown `open`
attribute. Header/body updates and unrelated rerenders keep that state. Closing
an active body moves its selection to the owning block and focus to the visible
arrow. Header sessions validate the live target, profile, source, and editability;
removed/conflicting targets retain the heading draft in a copyable dialog.

Math and Mermaid keep their renderers and existing diagram controls. Their
small header labels open the existing source dialog with **Update**, which
updates that block rather than inserting another. Cancelling and unchanged
submissions emit no edit. Fence metadata and unchanged source delimiters are
preserved; conflicting external updates leave the source draft visible.

`bodyNavigation.ts` transfers a plain collapsed caret in all four directions
among ordinary text, code, Alert, and open Details bodies. Closed Details and
rendered atoms are actual selection stops without opening or editing.
`EditorView.endOfTextblock` keeps interior vertical movement native; when an
arrow reaches a displayed textblock edge, the shared `Selection.findFrom`
exploration crosses directly to the next or previous actual target. Horizontal
and vertical code, Alert, and table edges use their first/last editable
position, and table edge traversal is position-based at any container depth.
`BlockBoundarySelection` remains unchanged for pointer and dedicated insertion
UX (`+`, slash, Enter, and composition), but it is never created or retained
as an ArrowLeft/Right/Up/Down stop. An atomic block itself remains one stop,
empty paragraphs remain individual stops, and flow document edges are handled
without moving or scrolling. When the first or last document child is
structural, its corresponding document edge exposes a `BlockBoundarySelection`
at position `0` or `doc.content.size`; arrows outward from that edge remain a
handled no-op. While a boundary selection is active in the focused editor, its
decoration reserves one visual line as a temporary insertion slot. Leaving it
without input collapses that line immediately with no document edit; the slot
is not a paragraph, transient paragraph, or Markdown blank line. Typing, Enter,
or slash then turns the insertion position into meaningful editing, with slash
reusing the existing Insert block popup. The vertical goal X is retained across
short intermediate targets. A temporary styled textarea layout mirror handles
Alert wrapping, font metrics, width, line height, and scrolling. Modified
arrows, selection ranges, IME candidate keys, and expanded-code controls keep
their own handlers. Navigation itself dispatches only selection transactions.

Validation is recorded separately for real Chromium keyboard/mouse/layout
checks and VS Code native APIs. `npm run test:browser:blocks` covers header
clicks, cancel/unchanged edits, selection retention, exact source updates,
bidirectional boundaries, wrapped Alert rows, focus, nested/closed Details,
and rendered-block passage. It also loads `md/common-test.md`,
`md/github-test.md`, `md/github-test-class-B.md`, `md/gitlab-test.md`, and
`md/gitlab-test-class-B.md` in rich, dedicated preview, and the native CSS
fixture, saving screenshots in `output/playwright/block-editing/`.

The final 0.0.32 verification on 2026-09-12 passed `npm run compile`,
`npm test` (383 tests in 29 files), `npm run lint` (zero errors; 33 existing
`no-explicit-any` warnings), `npm run format:check`, `npm run test:extension`
(installed VS Code, exit 0), and `npm run package` (bundled formatter verified).
The browser block suite passed 11 interaction groups including 15 fixture/surface
checks; the spacing suite passed 37 cases on each of three surfaces. The run
saved 89 block screenshots, including focused views of the affected blocks in
all five required documents. The artifact is `markdown-mint-0.0.32.vsix`.

The 0.0.33 conflict transition immediately makes Alert textareas read-only
without blurring their selection. Text already accepted by the native input,
including a delayed composition commit, is flushed into the local Markdown and
recovery draft while host synchronization stays paused. A rejected older edit
cannot overwrite that newer recovery draft. Expanded code retains vertical
movement within displayed rows and traps only an attempted exit at the edges.
Details scanning consumes code and real HTML comments in source order, so a
literal `<!--` inside code cannot hide its closing tag. Heading IDs use document
root and position, preserving the body parse cache while keeping repeated and
nested Details headings, rendered HTML, rich attributes, and TOC links unique.
TOCs also refresh when an edit changes the document's headings.

Regression coverage includes a focused Alert receiving `edit-rejected` and
subsequent real keyboard input, Chromium protocol composition around rejection,
native caret positions across the middle and edges of expanded code, literal
comment markers mixed with real comments in inline/fenced code, and identical
Details bodies with nested headings and live TOC updates. Chromium protocol
composition checks supplement synthetic unit events; they do not verify an
operating-system IME candidate window.

The final 0.0.33 verification on 2026-09-12 passed `npm run compile`, `npm test`
(429 tests in 33 files), `npm run lint` (zero errors; 33 existing warnings),
`npm run format:check`, `npm run test:extension` (installed VS Code, exit 0),
and `npm run package` (bundled formatter verified). The browser block suite
passed 13 groups, including the five required documents on three surfaces,
and saved 92 screenshots. The spacing suite passed 37 cases per surface.
The artifact is `markdown-mint-0.0.33.vsix`. This final verification includes
main commit `81f03c1`, retaining its color-literal decorations and initial-load
starter fix alongside the heading/TOC and Alert changes.

The initial native run exposed an unrelated test-fixture race: an unsaved
plaintext CodeLens fixture appeared as a new tab during a later profile check.
Using a saved `.txt` fixture in the isolated workspace removes that asynchronous
tab while retaining strict tab-count, index, active-source, and plaintext
CodeLens assertions. Fresh native runs passed after that harness correction.

Manual checks still required: actual Japanese OS IME candidate windows and
compositionend key ordering in VS Code; browser zoom/font scaling across
mixed scripts; native cross-region drag/copy/cut between an Alert textarea and
the outer ProseMirror document; and repeated Undo/Redo of header/body changes
through the visible Extension Host UI. Synthetic composition events and the
native API acceptance suite do not establish those manual observations.

- Toolbar buttons and selects use the editor or widget foreground paired with
  their surface background. Primary and secondary dialog actions use their
  corresponding VS Code button colors, and disabled, focus, hover, and
  high-contrast states remain visible across light, dark, and high-contrast
  themes, following the [VS Code theme color reference](https://code.visualstudio.com/api/references/theme-color).
- Selecting **Table** opens a size modal first. The modal provides a keyboard
  reachable grid, a live row-by-column size label, help text, and explicit
  cancel/insert actions. It does not insert a fixed table before the user
  chooses a size. The design was informed by [Confluence table controls](https://support.atlassian.com/confluence-cloud/docs/simplify-data-with-tables/),
  which document direct 3×3 insertion plus size and row/column controls; this
  extension requires the size choice before insertion.
- When the caret or cell selection is inside a table, a nearby contextual
  toolbar stays above the active table and exposes row, column, alignment, and
  table deletion actions. It remains usable at narrow widths.
- **Arrow Down** or **Arrow Right** at the end of the last table cell is handled
  without creating a boundary or trailing paragraph. **Escape** retains its
  separate writable-paragraph behavior, and that paragraph remains transient
  while empty, so cancelling or leaving it does not add blank lines to the
  Markdown source.
- Clicking below the final document block positions the caret at the clicked
  height with temporary blank paragraphs. They are removed when unused, while
  the first typed character commits them and authored blank lines remain intact.
- The **Emoji** toolbar button opens an accessible searchable picker, restores
  the saved selection for insertion, and safely cancels when the document
  changes. Image and table buttons use distinct SVG icons.
- An empty document starts with a visible `Title` placeholder on its initial
  H1. The placeholder is a decoration and does not add Markdown text or
  change document geometry until the user types.

Focused checks for this pass covered theme foreground/background pairs and
focus states, modal-first table insertion with several grid sizes and cancel,
contextual actions on a selected table, narrow-width positioning, and the
empty-document H1 placeholder.

The following five-palette measurements are retained from the previous
toolbar/table UI pass and are separate from the writing-flow CSS parity check
below.

The browser harness passed the five-palette theme check using the
actual Light Modern and Dark Modern variables, light and dark high-contrast
palettes/classes, and a synthetic theme with opposite editor/widget/dropdown
foreground and background pairs. The minimum contrast ratio for enabled
visible text controls was 6.31:1 in Light Modern, 4.53:1 in Dark Modern,
15.7:1 in high-contrast dark, 8.1:1 in high-contrast light, and 8.1:1 in the
synthetic theme. Screenshots at 500×850 and 320×640 were inspected; the
contextual table toolbar wrapped within the viewport, and the long-table
header remained above the stage. The same pass verified modal-first insertion,
20×50 numeric size selection, arrow/Enter grid selection without insertion, cancel
and reopen, table row/column actions with Undo, and the empty-document H1 to
body flow. Explicit Text selection in the rich editor and blank-preview behavior also
passed. The 0.0.3 VS Code 1.137.0 native integration run using the installed
`Contents/MacOS/Code` executable passed. Native VS Code visual geometry was
not claimed here; those visual parity measurements use the browser harness,
the installed VS Code `markdown.css`, and the shared stylesheet.

## Writing UX and shared typography update

This section records the writing-flow design and validation status for the
0.0.3 UI pass. The writing controls and browser interaction checks were
complete in that build. Native integration was exercised separately; native
VS Code visual geometry and the real operating-system IME candidate UI remain
outside the automated evidence.

- The 0.0.3 validation build kept the upper toolbar compact with **Insert**
  and **Formatting** groups. In the 0.0.5 surface, heading, B/I/S, inline code,
  link, image, list, and table controls stay directly visible; an empty-line `+`
  still opens the **Insert** menu.
- An empty document starts from a virtual H1 `Title`; the blank starter stays
  out of emitted Markdown until it is given content. Pressing Enter moves into
  a normal paragraph. An empty paragraph shows a `+` button that opens the
  **Insert** menu.
- At paragraph starts, typing `#` through `######`, `>`, `-`/`+`/`*`, or a
  positive `N.` followed by a space applies the matching heading, quote, or
  list block. A non-empty text selection shows the formatting popover
  automatically; `Tab` moves keyboard focus into it.
- Theme colors and VS Code Markdown preview font family, size, and line height
  remain the source for the writing surface.

The writing references are [Notion's writing and editing basics](https://www.notion.com/help/writing-and-editing-basics)
and [note's editor guide](https://www.help-note.com/hc/ja/articles/360012426133).
They inform the compact writing flow and paragraph shortcuts; this project
keeps Markdown as the document model.

The current CSS parity check passed for two fixtures × three conditions across
the rich editor, dedicated preview, and native preview: widths 1100 and 500,
Arial 14 and Georgia 20 typography cases, and representative H1–H6,
blockquote, list, task, table, and code content had matching block and cell
metrics in all six comparisons. The browser interaction pass also covered the
compact toolbar at 500px (one row) and 320px (two rows), selection Bold with a
single edit, entering the selection formatting popover with Tab and committing
it from the keyboard, paragraph-start heading/list markers
including NBSP-delivered terminators, empty-line Insert followed by modal
cancel with zero edits, keyboard table insertion with a 2×3 result, a row
addition followed by Undo back to three rows, and a one-edit link action on
selected words. The 0.0.3 validation passed the full unit suite of 103 tests;
compile, lint, and format checks passed, and the isolated VS Code 1.137.0
native integration run using the installed `Contents/MacOS/Code` executable
passed. That native integration result covers host behavior and APIs; visual
geometry remains represented by the browser parity measurements above.

The final writing UI contrast pass covered Light Modern, Dark Modern, light and
dark high-contrast palettes, and an opposite foreground/background theme. The
minimum enabled text-control contrast was 6.31:1, 4.53:1, 4.53:1, 6.31:1,
and 6.31:1 respectively. In a 3,946px document, the selection popover stayed
within a 320px viewport. The 0.0.3 UI artifact contained 10 intended files,
and its isolated bundled-formatter verification passed.

## 0.0.4 rename verification

The 0.0.4 rename verification passed the 103 unit tests, TypeScript compile,
lint, and format checks; the browser parity harness passed all six comparisons;
and the 0.0.4 VSIX contained 10 intended files with the bundled formatter
verified in isolation. The package metadata and activation use the new
Markdown Mint identity, and the old brand identifiers scan to zero. The native
runner activated the extension, verified command registration, and opened the
custom tab, but the full suite did not complete because the Mac was locked:
the Extension Development Host could not obtain OS/webview focus and VS Code's
built-in Undo timed out. The native result for 0.0.4 is therefore incomplete;
the native passes recorded above belong to 0.0.3.

## 0.0.5 current writing flow

The 0.0.5 writing surface uses **Mint** and **Source** buttons. **Mint**
opens the structured rich editor; **Source** returns to VS Code's standard raw
Markdown text editor, where the Mint toolbar is not shown. A profile dropdown
offers **GitHub** (the default) and **GitLab**. The Mint toolbar keeps heading,
**B**, **I**, **S**, inline code, link, image, list, and table controls directly
visible alongside the other editing actions. It does not include a **Preview**
button; the dedicated preview remains available through the command palette's
**Markdown Mint: Open Dedicated Preview** command. The blank document starter,
paragraph-start Markdown shortcuts, empty-line `+` **Insert** menu, selection
formatting popover, and profile-aware rendering remain part of this flow.

The confirmed 0.0.5 validation includes the following evidence:

- The native VS Code 1.137.0 integration suite exited 0. It covered the
  same-group **Source → TabInputText** transition, save and format, native
  Undo/Redo, and the native preview adapter.
- In the real browser checks, pressing Enter and receiving an exact snapshot,
  followed by a `trimFinalNewlines`-style version advance, preserved the exact
  ProseMirror document and caret (position 17). Japanese text could then be
  entered normally.
- At viewport widths 1100, 500, and 320, all 20 top-toolbar controls remained
  visible without horizontal overflow. The measured toolbar heights were
  42px, 75.6px, and 107.4px.
- Five theme palettes kept closed-control contrast at or above 8.1:1 and the
  table modal at or above 4.53:1.
- Browser profile acknowledgements succeeded in the sequence GitHub (default)
  → GitLab → GitHub. **Source** sent its host request while the inline raw
  editor stayed hidden; the native transition was verified separately.
  Bold on selected Japanese text produced one edit. A 2-column × 3-row table
  inserted in one edit, row addition reached four rows, Undo returned to three,
  and Redo returned to four.
- The full unit suite passed 118 tests across 12 files, including six
  autosave/snapshot regression cases and an IME composition scenario.
- TypeScript compilation passed. Packaging via the `npm run package` script
  produced the Markdown Mint 0.0.5 VSIX with 11 files and a 1.98 MB size;
  bundled-formatter verification also passed.

The remaining manual boundary is the real operating-system IME candidate UI,
which has not been exercised in a live IME session. The automated composition
regression is covered by the suite above.

## 0.0.7 current editing and local previews

The current editing surface keeps the contextual table toolbar above the active
table, including at narrow widths. Arrow Down at the end of the final cell and
Escape create a writable paragraph after the table. Clicking below the final
authored block positions the caret at that height with temporary paragraphs;
unused paragraphs are discarded, while the first typed character commits them
and preserves authored blank lines. The Emoji button opens a searchable common
emoji picker and restores the saved selection for insertion. Image and table
actions use distinct SVG icons.

Raw HTML, front matter, custom extensions, and other unsupported syntax remain
rendered preserved atoms in Mint. The **Source** action exposes their exact
Markdown for editing. GeoJSON, TopoJSON, and ASCII STL fences receive bounded
local SVG previews with escaped labels and no network or map-tile requests;
invalid or oversized input stays available as escaped source.

## 0.0.6 table picker and local table toolbar

The 0.0.6 table flow refines insertion and in-table editing. Clicking a cell in
the picker selects and previews the row-by-column size without inserting;
double-clicking inserts that size immediately. Numeric row and column fields
below the grid provide direct sizing. When the caret is inside a table, row,
column, and alignment actions are grouped in the local table toolbar.

The **Mint** and **Source** buttons retain their existing behavior, and the
dedicated preview remains available through the command palette's **Markdown
Mint: Open Dedicated Preview** command.

Initial 0.0.6 UI and unit validation is complete for the following checks:

- Hovering 3×3, 8×6, 1×1, and 4×5 picker sizes kept the grid's vertical origin
  unchanged at all tested widths; the previous 320px drift of −10.398px is
  eliminated. Numeric row and column fields stayed below the grid with no
  overflow. The dialog measured 435.35px high at 1100px and 500px widths, and
  472.79px at 320px.
- Keyboard picker navigation with ArrowRight, ArrowDown, and Space selected
  4×4; Tab moved focus to the Columns field. Eight same-cell pointer moves with
  a gap left the grid attributes unchanged and retained the 4×5 preview.
- A real grid click selected a size without editing. Double-clicking inserted a
  4-column × 5-row table in one edit, closed the dialog, and left the caret in
  the header. Adding a row to six, Undo to five, and Redo to six all passed.
- The local table toolbar kept all 10 controls visible without viewport
  overflow or selected-cell obscuration; at 320×650 it moved above the cell
  when needed.
- Five tested palettes kept enabled toolbar-control contrast at or above
  7.06:1 and table-modal contrast at or above 4.53:1; every measured surface
  was at least 4.5:1.
- The full unit suite passed 124 tests across 12 files, including 15 table UX
  cases. TypeScript compilation and the format check passed, and lint reported
  zero errors with the existing 16 `any` warnings.
- No host behavior changed in 0.0.6. The native integration run was not
  repeated; the 0.0.5 native result remains historical evidence.
- Final packaging passed: the 0.0.6 VSIX contains 12 files and is 1.99 MB;
  bundled-formatter verification passed. Zip inspection confirmed icon
  registration and PNG-byte equality, with `md/**` and `sample.md` absent.

The 0.0.5 and earlier evidence above remains historical.

## 0.0.9 long-table scroll verification

- The browser check kept an 80-row table freely scrollable at 1100px and
  500px: wheel scrolling reached the table's end and returned to the table,
  while the selection and Markdown source stayed unchanged. Resizing to 320px
  preserved `scrollTop` at 900. A 60-row table also accepted the row-below
  action from its last cell (row 61 to row 62), and typing at the end followed
  by Arrow Down entered writable body text after the table. The full validation
  passed 177 tests, TypeScript compilation, lint, format checks, and packaging.

## 0.0.10 toolbar, profile, and list verification

- The Mint button was removed; **Source** is the final toolbar action and stays
  at the right edge at 1200, 500, and 320 pixel widths without overflow.
- **CommonMark** is selectable alongside GitHub and GitLab. Profile changes
  retain synchronization and IME protections, and the native round trip keeps
  the Markdown source unchanged.
- Toolbar and menu controls use one accessible tooltip for hover, focus,
  SVG-child hover, and disabled actions. Escape, leave, blur, click, and scroll
  close the tooltip without leaving native duplicate titles.
- Bullet, ordered, and task-list commands toggle the active list on a second
  activation, support partial and nested selections plus `Cmd+A`, and expose
  state through `aria-pressed`.
- The main browser acceptance covered the three list toggles, Source at 1200,
  500, and 320 pixels, CommonMark switching, 20 tooltip targets in light and
  dark themes, and free scrolling through an 80-row table while preserving
  selection and Markdown.
- The native `npm run test:extension` check passed the CommonMark round trip and
  same-tab Source transition. The full unit suite passed 198/198 tests;
  TypeScript compilation and formatting passed. Lint reported zero errors with
  the existing 16 `any` warnings.

## 0.0.11 inline table toolbar and numbering

- Table row, column, alignment, numbering, and delete actions mount inside the
  main top toolbar. The contextual groups appear only for a cursor or
  `CellSelection` inside a table and stay out of the scrolling document stage.
- The compact table groups wrap within the toolbar at narrow widths without
  reserving document padding or changing the scroll position. Selection and
  action bookmarks remain available when the toolbar receives focus.
- The Numbering toggle adds a `#` header cell and sequential `1` through `n`
  body cells, preserves the selected table cells, and removes only that column
  when activated again. Its `aria-pressed` state and shared tooltip reflect the
  current table.
- Undo and redo remain keyboard/native history commands; their toolbar buttons
  are removed. CommonMark/read-only/IME gating continues to control contextual
  actions.

- Final verification passed with 213/213 tests, TypeScript compile, lint with zero errors (the existing 16 any warnings remain), formatting, and native npm run test:extension.
- Browser verification covered the conditional toolbar at 320/500/1200px, light/dark tooltips, stable 80-row scrolling with selection and source preservation, numbering and CellSelection behavior, reload, adjacent-table deletion, and all five Markdown fixtures rendering without source changes.

## 0.0.12 GitHub and GitLab feature toolbar

- Rich GitHub and GitLab modes expose a profile feature row with Alert, Details,
  Math, and Mermaid controls. GitLab additionally exposes TOC, description
  list, added diff, and removed diff controls.
- The row is hidden in CommonMark and dedicated preview, and moves below the
  contextual table row when a table is selected. Controls remain responsive at
  narrow widths and retain shared tooltips and accessible labels.
- TOC inserts immediately. Other features use guarded dialogs with selection
  defaults, cancel and Escape focus restoration, IME/read-only/conflict guards,
  and stale document/profile checks before insertion.

## 0.0.23 code-block UI and interaction verification

- Code blocks now share one card/header model across the rich editor, native
  preview, and dedicated preview. The shared metadata keeps the original
  info-string language and suffix while separating display labels, aliases,
  highlight state, and custom-language fallback behavior.
- The full unit suite passed 266 tests across 23 files. TypeScript compilation
  and the format check passed. Lint reported zero errors with 30 existing
  `any` warnings in the test suite.
- The local 0.0.23 VSIX was installed in real VS Code and
  `md/common-test.md` was opened in Markdown Mint without changing the source.
  Normal cards, the searchable language picker, an `acme-dsl` custom-language
  fallback, the three-dot menu, and Webview-internal expansion were exercised;
  screenshots were captured for the normal card, picker, custom-language
  fallback, menu, and expanded view.
- `npm run test:extension` was attempted after the build but terminated with
  `SIGABRT` before completing the native assertions, so no native automated
  pass is claimed for this version.
- The five required fixtures (`common-test.md`, `github-test.md`,
  `github-test-class-B.md`, `gitlab-test.md`, and `gitlab-test-class-B.md`)
  were opened in real VS Code through Markdown Mint without editing their
  source. Code-block controls were confirmed in the common, GitHub, and
  GitLab class-B fixtures; the common fixture was used for the interaction
  screenshots above. Real OS IME candidate UI and pixel measurements at
  100%, 150%, and 200% zoom remain manual checks.

## 0.0.25 code-block follow-up verification

- Explicit language identities remain distinct from shared highlight.js
  grammars: TSX/TypeScript, HTML/XML, TOML/INI, and JSX/JavaScript can be
  selected independently while same-language aliases preserve their spelling
  and info-string suffixes.
- Removing a language from an info string with additional metadata opens a
  cancellable warning. Cancel leaves the document untouched; confirmation
  removes the complete info string in one edit. Suffix-free removal remains
  immediate.
- Browser-harness verification covered the rich editor and dedicated preview.
  Computed metrics matched for line numbers, `pre`, and `code`: `12.88px`
  font size and `19.32px` line height. The searchable picker selected TSX and
  updated the rendered card without collapsing the language identity.
- Unit validation passed 291 tests across 23 files, TypeScript compilation,
  lint with zero errors (33 existing `any` warnings), formatting, and package
  verification. The native Extension Host check was attempted but terminated
  before assertions with `SIGABRT` under Node `v24.5.0` and VS Code `1.137.0`;
  A retry under Node `v18.0.0` produced the same result, so the failure is
  attributed to the VS Code host environment rather than the project test
  assertions; see the release/PR report for the exact runner location.

## 0.0.29 Mermaid flowchart label alignment verification

- Mermaid 11.17.2 flowcharts emit node-label `<text>` at `x=0` and rely on
  Mermaid's generated stylesheet for `text-anchor: middle`. The browser
  harness reproduced the strict-CSP failure: computed `text-anchor` was
  `start`, and the six reproduction nodes had viewport-coordinate center
  deltas from 9.27px to 34.64px.
- `media/document.css` restores `text-anchor: middle` only for
  `svg[aria-roledescription="flowchart-v2"] .node .label text:not([text-anchor])`. The real
  Mermaid browser check measured all six nodes at 0.00–0.30px center delta in
  the Rich Editor, Dedicated Preview, and native Markdown Preview. Yes/No
  edge labels and sequence messages remained `middle`.
- The browser fixture kept the production CSP and reported only the known
  Mermaid inline `style-src-elem` violations; no unexpected CSP violation,
  external URL, sanitizer regression, or Markdown source change was observed.
  The before/after screenshots are captured under
  `output/playwright/mermaid-labels/` during local verification.

## 0.0.31 block spacing verification

- Block rhythm is now measured on the actual display surfaces rather than on
  Markdown source combinations alone. Rich NodeView wrappers own their outer
  margins, generated display elements have their inner margins cleared, and
  ordinary native preview blocks retain the shared `1em` rhythm.
- Alert-to-code, paragraph, and table transitions now retain the intended
  gap; the rich Alert-to-code case changed from `0px` to `14px`. Consecutive
  Alerts preserve their existing compact `10.5px` rhythm, while a preserved
  empty comment between Alerts uses the ordinary `14px` gap.
- GitLab TOC and description-list blocks receive ordinary flow margins. The
  TOC no longer inherits the approximately `2.52px` native list offset as its
  outer document spacing.
- Document-edge resets target the rich wrapper or the adjacent visible block,
  including when a hidden empty rendered NodeView represents an edge comment.
  Details, Alert, blockquote, and list terminal-child margins are removed only
  at their container edge, preserving Details padding, the summary/body gap,
  and interior list density.
- `npm run test:browser:spacing` covers the Rich Editor, Dedicated Preview,
  and native-preview fixture with real browser geometry. It includes 37
  representative spacing cases per surface plus code controls, Mermaid and
  math fallback, preserved inline content, typography, themes, and narrow
  viewport checks. The native fixture uses the installed VS Code Markdown
  stylesheet and does not claim a real Extension Host/IME pass.
- The browser harness intentionally preserves source comments and empty
  rendered atoms without inserting empty paragraphs, `<br>`, or zero-width
  placeholders. Manual OS IME candidate-window and zoom checks remain real
  VS Code checks.

## 0.0.32 table toolbar lifecycle

- The Rich GitHub/GitLab table toolbar is hidden when an editor opens, even if
  the document already contains tables. The first user table focus from a
  mouse click, keyboard movement, or `CellSelection` reveals the existing
  toolbar element and plays one short reveal animation.
- After reveal, moving outside a table keeps the toolbar mounted and visible;
  all table-specific controls become disabled until the current selection is
  inside a table again. A different table updates the same toolbar's target,
  and deleting the final table leaves the revealed toolbar disabled.
- Preview, CommonMark, read-only, conflict, and other existing availability
  gates continue to hide or disable the table controls. The revealed flag is
  held only by the current editor instance and is not serialized or persisted.

## 0.0.32 Rich Editor color-literal authoring aid

- In the Mint Rich Editor, a standalone six-digit RGB literal matching
  `#[0-9A-Fa-f]{6}` is displayed with that exact value as its text color. The
  original spelling and case remain unchanged in the ProseMirror document and
  serialized Markdown.
- The authoring aid is a display-only `Decoration.inline` in the existing
  rendering plugin. It adds no schema mark or AST data, rebuilds with the
  existing document-change lifecycle, and maps its ranges without rescanning
  on selection-only transactions.
- ASCII letters, digits, and underscore are token characters, so embedded
  substrings such as `abc#ff0000` and `#ff0000abc` are not decorated. Japanese
  and other non-ASCII prose can directly surround a literal.
- Paragraphs, headings, blockquotes, lists, table cells, strong, emphasis, and
  strike text are supported consistently in CommonMark, GitHub, and GitLab
  profiles. Inline code, fenced code blocks, link text, and raw nodes are
  intentionally excluded.
- Dedicated Preview, native Markdown Preview, the Source editor, and Alert
  body textareas are unchanged. No contrast correction, background, badge,
  swatch, border, underline, or font-weight styling is added.
- Automated coverage verifies accepted and rejected literals, supported and
  excluded contexts, live add/remove/color updates, selection-only mapping,
  Undo/Redo, exact source round trips, all three profiles, strict style input,
  and coexistence with heading, footnote, and syntax-highlight decorations.
- Final automated validation passed TypeScript compilation and all 364 unit
  tests across 26 files. Formatting passed; lint reported zero errors and the
  existing 33 test-suite `any` warnings. The native Extension Development Host
  acceptance run exited successfully.
- The real browser regression suite passed 37 Rich Editor/Dedicated Preview
  cases and 37 native-preview fixture cases. All five required Markdown
  fixtures rendered visibly under their matching profile with their source
  unchanged and no unsolicited edit message.
- Light- and dark-theme browser inspection confirmed the exact computed colors
  for red, green, blue, mixed-case, numeric, and bold literals. Inline code,
  link text, and fenced code remained undecorated; the Dedicated Preview had no
  color-literal decoration, source text was byte-for-byte unchanged, and the
  color fixture produced no CSP violation. Screenshots were captured under
  ignored `output/playwright/` test output.
- A focused scan benchmark measured a 0.05 ms median for the 48,767-byte
  long-lines fixture and 5.23 ms for the 434,328-byte, 40,000-cell table
  fixture (20 runs each). Both fixtures remained editable and Undo restored
  their exact source in the real browser harness.
- Packaging produced the verified 0.0.32 VSIX with 96 files (4.73 MB), including
  the bundled formatter and updated Webview implementation.

## 0.0.33 Insert block menu and slash trigger

- The empty-paragraph `+` affordance opens one shared **Insert block** popup.
  Its visible labels are **Bullet list**, **Ordered list**, **Task**, **Quote**,
  **Code**, **Table**, **Image**, and **Horizontal rule**. Image reuses the
  existing image dialog and popup saved-selection path; popup items keep their
  accessible labels without per-item tooltips, while the existing icons,
  profile gating, mouse commands, and table dialog are preserved.
- The popup follows its two-column row-major layout for ArrowLeft/Right
  (`±1`) and ArrowUp/Down (`±2`) with modulo wrapping. Disabled profile items
  are skipped using the same delta; Home and End select the first and last
  enabled items.
- In Rich mode, an empty top-level paragraph accepts `/` through ProseMirror's
  text-input hook without inserting it first. The same popup and saved-selection
  guards are reused. A committed command consumes the transient trigger; Escape,
  Tab, and outside cancellation materialize one literal slash; stale document,
  profile, mode, IME, and destroy paths discard it.

## 0.0.40 historical top-level block boundary caret

- Plain, collapsed ArrowLeft/Right and visual-line ArrowUp/Down navigation
  between direct children of the document uses a virtual
  `BlockBoundarySelection`. The selection maps with document transactions,
  does not serialize, and is rendered by an absolute Decoration widget so
  block layout and source separators do not change while navigating.
- Boundary traversal preserves BodyNavigation's visual-row and desired-X
  state, keeps closed Details closed, treats Math/Mermaid and other rendered
  blocks as existing atomic stops, and leaves table cell arrows, list content,
  modifiers, and composition navigation to their established handlers. Top-
  level table edges use the same boundary before or after the table.
- Printable text, `/`, Enter, composition input, and paste materialize one
  ordinary paragraph at the selected boundary and then continue through the
  existing ProseMirror input path. Backspace/Delete (including modified forms)
  are no-ops at a boundary; materialized edits remain normal host-backed
  Undo/Redo operations.
- Unit and Chromium checks cover bidirectional Code/Alert/Details traversal,
  wrapped Alert rows, desired-X preservation, atomic and closed rendered
  blocks, table edges, modifiers, composition setup, source/host/dirty/history
  invariants, paragraph and slash insertion, and all five display fixtures.

## 0.0.42 toolbar block-context selection boundaries

- Block quote and Code block active state now uses the shared ancestor chain of
  the complete ProseMirror selection. A cursor keeps the existing behavior;
  ranges crossing a normal paragraph or a separate same-type block are
  inactive, while nested content sharing an outer blockquote remains active.
- Regression coverage includes same-block and cross-block blockquote ranges,
  blockquote-to-paragraph ranges, same-block and cross-block code ranges, and
  nested blockquotes with a shared outer ancestor.
- `npm run compile`, `npm test` (609 tests across 34 files), and `npm run lint`
  passed; lint retains the repository's existing 48 `any` warnings. The
  verified package is `markdown-mint-0.0.42.vsix` with 96 files.

## Unreleased Selection Toolbar focus refinement

- Selection Toolbar buttons retain their accessible `aria-label` values while
  omitting per-button `data-tooltip` attributes, so hover and focus do not
  obscure the selected text. Existing `:focus-visible` styling remains the
  focus indication.
- In Rich mode, when a non-empty `TextSelection` has a visible, eligible
  Selection Toolbar, Tab captures the existing selection state and focuses the
  first enabled button. Native button order supplies subsequent Tab and
  Shift+Tab movement; Enter/Space use the existing commands and Escape returns
  focus to the editor without a document edit.
- The Tab interception runs before the existing Table/List keymap path. A
  collapsed list cursor still indents, table selections still move between
  cells, and code-block selections remain outside the Selection Toolbar path.
- Automated writing-UX coverage verifies tooltip removal, accessible labels,
  Tab focus and selection preservation, Bold activation, Escape, CommonMark
  disabled-button skipping, list indentation, table navigation, and the
  removal of the former formatting-toolbar shortcut.

## 0.0.41 toolbar semantic active state

- The main toolbar derives persistent active state from one current
  EditorState/Selection context. Bold, italic, strikethrough, inline code, and
  link use the same `storedMarks`, `$from.marks()`, and `rangeHasMark()` helper
  as the Selection toolbar.
- Bullet, ordered, and task lists retain `activeListKind()` semantics and
  remain mutually exclusive. Blockquote and code block buttons activate only
  when the current cursor or selection remains inside that block.
- The main Table button activates for a text cursor, another table cell, or a
  rectangular `CellSelection` by reusing `tableContext(selection)`. It clears
  immediately after leaving the table. Image and horizontal rule activate only
  for an explicit `NodeSelection` of the corresponding node.
- Stateful controls synchronize both `aria-pressed` and `.is-active`; disabled
  CommonMark controls are forced inactive. Format, Emoji, and other insert-only
  actions do not receive persistent active state.
- Selection changes, document transactions, profile/document updates, and mode
  transitions all refresh the same semantic state. No toolbar layout, CSS
  colors, table contextual UX, or Markdown serialization behavior changes.
- Regression coverage exercises list exclusivity, Table cursor/cell changes and
  `CellSelection`, blockquote/code-block transitions, empty and non-empty mark
  selections, explicit image/rule `NodeSelection`, and CommonMark disabled
  controls. The full unit suite passed 606 tests across 34 files; TypeScript
  compilation and lint passed with the repository's existing 48 `any` warnings.
- The browser fixture check passed 37 Rich/Preview and 37 native cases, and the
  native Extension Development Host acceptance suite exited successfully. The
  verified package is `markdown-mint-0.0.41.vsix` with 96 files. The repository
  format check still reports the pre-existing warning in
  `tests/browser/block-editing.test.mjs`, which is outside this change.

## 0.0.41 historical native Code vertical movement

The editor owns only the transition out of a textblock. For a collapsed,
unmodified ArrowUp or ArrowDown, `EditorView.endOfTextblock()` remains the
boundary decision. When it reports an interior displayed row, the webview
returns `false` without calling `preventDefault()`, allowing the browser and
ProseMirror DOM selection to retain native visual-row, syntax-highlight span,
wrapping, and scroll behavior. At the first or last row, the existing
`BlockBoundarySelection` path runs and reuses the captured desired X column for
the adjacent block. Alert textareas and table keymaps keep their separate
native/navigation handlers.

The browser regression uses the JavaScript `greet` fixture from a 180–190px
viewport, measures each code-block selection offset and caret visibility while
the stage scrolls, walks through a blank line in both directions, verifies the
virtual boundary, and repeats the sequence 20 times at two viewport widths.
A second case enables Code line wrapping and verifies three visual rows remain
native interior movement. The focused run passed in Chromium; native VS Code
zoom, font loading, and operating-system IME candidate UI remain manual checks.

## 0.0.43 Math rendered-atom editing

- The shared `MATH_FENCE_LANGUAGES` set and `isMathFenceLanguage(info)` helper
  keep parser, renderer, and source-editor recognition aligned for `math`,
  `latex`, `tex`, and `asciimath`, including case-insensitive info strings and
  additional metadata. Existing fence marker, length, alias casing, metadata,
  indentation, line endings, closing spacing, and embedded-fence safety remain
  source-preserving.
- Inline `$...$`, display `$$...$$` (including compact, multiline, CRLF, CR,
  and up-to-three-space indented forms), and all four Math fence aliases use the
  existing Edit Math dialog. Inline Math remains an atomic `NodeSelection` with
  `tabIndex=-1`; Enter/Space on a selected atom and programmatic activation are
  available without adding every inline expression to normal Tab order.
- Single clicks only select Math, while double clicks on the Math atom open the
  dialog. Ordinary text double clicks remain native, interactive descendants are
  excluded, surrounding marks and links are retained, escaped dollars remain
  intact, and stale targets keep their draft without applying it to a different
  node. Mermaid, Code, Details, block-boundary navigation, synchronization, and
  recovery paths retain their existing behavior.
- Table-driven unit coverage checks alias/parser/editor alignment, mixed-case
  metadata, fence and display source matrices, inline marks/links/escaped
  dollars, multiple and identical expressions, keyboard activation, and stale
  drafts. Chromium coverage exercises one document containing inline Math,
  display Math, and all four fenced aliases through single click, double click,
  Cancel, Update, body checks, and wrapper checks.

## 0.0.44 linked inline Math mark preservation

- Generic inline serialization groups every contiguous range with the same
  link mark, including a range containing only one raw inline Math atom. Marks
  shared by the link range are serialized around the link when possible, while
  mixed surrounding link/mark shapes continue through the inner serializer.
  Strong, emphasis, strikethrough, their combined forms, link titles, and
  distinct destinations on identical Math sources are preserved by
  parse/serialize/parse checks.
- Math-only edits continue to use `preserveRawInlineSourceSlice()` so the
  original Markdown nesting and line bytes remain intact. A generic edit to
  neighboring paragraph text is tested separately and retains the Math source,
  link, and marks. Linked image and hard-break branches are also covered by a
  focused round-trip audit.
- A Chromium flow double-clicks linked inline Math, updates `$x$` to `$y$`,
  then edits surrounding text through the normal editor input path. The saved
  source and PM node state retain the Math atom, strong mark, and link.

## 0.0.48 Insert popup input modality

- The shared Insert block popup opened by the `+` affordance or `/` command
  keeps its real DOM focus navigation and `:focus-visible` indication while
  tracking `pointer` or `keyboard` modality on the popup itself.
- Arrow keys and Home/End switch the open popup to keyboard modality, so a
  pointer left over another item cannot add a second hover background. A real
  `pointermove` or `pointerdown` inside the popup returns it to pointer
  modality. Opening with a mouse click starts in pointer modality; ArrowDown
  and keyboard Enter/Space activation start in keyboard modality; slash also
  opens in keyboard modality. Closing removes the modality state before the
  next open.
- Writing-UX regression coverage verifies keyboard hover suppression state,
  pointer restoration, keyboard opening, Enter/Space activation, slash
  navigation, popup reopen reset, and the existing two-column navigation
  rules. The native operating-system pointer/IME visual behavior remains a
  manual check.

## 0.0.52 Link dialog relative destinations

- The Link dialog uses a plain text destination field with URL-oriented input
  hints, so relative paths such as `./docs/guide.md`, `../README.md`, and
  `/docs/guide.md`, fragments, HTTPS URLs, and mailto URLs can be submitted.
- Link dialog edits retain the entered destination in the ProseMirror link mark
  and Markdown serialization. Existing relative links are loaded back into the
  dialog unchanged, while the Core `safeUrl` rendering guard remains intact.
- Webview regression coverage exercises Apply for every supported destination,
  existing relative-link editing, and both platform primary-modifier Enter
  shortcuts.

## 0.0.50 table toolbar SVG assets

- The contextual table toolbar uses the shared `ToolbarIconName` and
  `appendToolbarIcon()` path for all row, column, alignment, numbering, and
  table actions. Each action maps to its dedicated repository SVG asset while
  retaining the existing group order, labels, tooltip text, commands,
  selection handling, disabled state, and `aria-pressed` state.
- Table toolbar icons keep the `.mm-table-toolbar-icon` class and 14px SVG
  width/height attributes. Repository-fixed `#111827` colors are normalized to
  `currentColor` before rendering so the assets follow the active VS Code
  theme, including the table/row/column delete variants.
- Normalized SVG templates are cached by icon name. Every render clones the
  template and applies call-specific class, size, `data-icon`, and accessibility
  attributes, so repeated table updates avoid reparsing while DOM nodes and
  attributes remain isolated between calls. Unit coverage checks all eleven
  table mappings, theme-color normalization, clone independence, and size
  isolation.

## 0.0.49 table clipboard text paste

`handlePaste()` classifies the clipboard payload before entering the table
matrix replacement path. An ordinary text paste from a `TextSelection` inside
a cell now returns `false`, so ProseMirror inserts at the caret or replaces
only the selected text. A `CellSelection` retains its whole-cell 1×1 fallback;
internal Markdown Mint table data, an HTML `<table>`, and recognized TSV still
use matrix replacement and table expansion. The generic `tableContext()`
meaning remains unchanged for navigation and toolbar state.

The focused webview regression covers caret insertion, partial text selection,
TSV expansion, and CellSelection replacement. The final unit suite passed 742
tests across 34 files; the browser fixture suite passed all five required
fixtures on Rich, dedicated Preview, and native-preview surfaces; and the
installed VS Code Extension Development Host exited successfully. Actual
Ctrl/Cmd clipboard gestures and operating-system IME behavior remain manual
checks rather than claims from the synthetic clipboard tests.

## Current Arrow navigation invariant

Plain collapsed ArrowLeft/Right/Up/Down navigation has one actual-target graph.
Flow content consists of paragraphs (including empty and image-containing
paragraphs unless the paragraph contains only an image), headings, blockquotes,
and list/task-list containers. Structural targets are code blocks, tables,
Alert/raw blocks, Details, horizontal rules, image-only paragraphs, and other
raw/protected atomic blocks. The shared `isStructuralNavigationTarget()` and
`shouldStopAtStructuralGap()` helpers classify the normalized actual targets;
they do not use the generic `node.isBlock` flag.

Flow-to-flow, flow-to-structural, and structural-to-flow transitions select the
next actual target in one key. Only adjacent structural-to-structural targets
expose one top-level `BlockBoundarySelection` stop. An arrow from that boundary
selects the next actual target in one key and never creates another boundary.
Collapsed Details and atomic blocks remain visible targets, while hidden content
is skipped. The position-based graph works at arbitrary list, blockquote,
Details, and table depth, but structural boundary stops are limited to direct
children of the document. Interior vertical text movement remains native and
keeps its visual row and goal X. At a document edge the arrow is handled with
no move, selection change, scroll escape, edit, or transient paragraph.

`BlockBoundarySelection` retains its insertion role for structural gaps and
explicit non-arrow insertion paths. Typing materializes an ordinary paragraph,
Enter materializes an empty paragraph, and `/` reuses the existing Insert block
popup. The hover `+` affordance remains a separate, source-omitted transient
insertion path.
This invariant is covered by the unit and Chromium block-navigation
regressions, including the five required Markdown fixtures on Rich, dedicated
Preview, and native-preview surfaces.

## Current top-level block-gap insertion invariant

Navigation and insertion remain separate. Hovering the visual gap between
adjacent direct children of the ProseMirror document reveals one reusable
`.mm-block-gap-insert` button. Its position is derived from the direct-child
document positions and `view.nodeDOM(position)` rectangles, not from inferred
Markdown or nested DOM structure. The button is an absolute overlay, so
showing or hiding it does not change block margins, paragraph positions, scroll
height, or document layout. Gaps inside list items, blockquotes, table cells,
and Details bodies remain outside this affordance's scope.

Clicking the gap button inserts one `meaningful: false` transient empty
paragraph at the boundary, places the caret there, and opens the existing
Insert block popup with its existing items. The transient paragraph is omitted
from the serialized source and does not create a host edit, dirty state,
autosave, or undo entry until typing or an Insert block command makes it
meaningful. Ordinary arrow keys continue to use the structural actual-target
graph and do not stop on this mouse-created transient paragraph. Slash input at
an existing boundary uses the same transient source-omission guard until the
popup command is chosen.

Profile block features use a separate direct insertion primitive. Alert,
Details, Math, Mermaid, and GitLab block features accept a valid
`BlockBoundarySelection` as their insertion target and insert at its exact
top-level position. The command selects the inserted block without adding an
implicit empty paragraph, so the existing dialog can be opened and committed
without pressing Enter first. Dialog generation/profile and stale-document
guards remain in force; Cancel leaves the boundary, ProseMirror document,
source, and host edit count unchanged.

## Explicit limits

Paste/drop image asset copying is optional follow-up work. Native IME and visual
geometry require a manual check in a real editor window. Project formatter-file
resolution targets local `file:` documents in the desktop Extension Host;
Remote and Web workspace URI schemes are outside this scaffold. The acceptance
runner uses a copied fixture under a temporary workspace and never mutates the
user's working files.

The publisher id is the local-development placeholder
`markdown-mint-local`; it is not a Marketplace ownership claim.
