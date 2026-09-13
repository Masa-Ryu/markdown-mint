# Requirements and implementation status

This page keeps the original R01–R08 identifiers unchanged. Status is based on
the unit suite, the installed VS Code Extension Development Host acceptance
run (`npm run test:extension`), and the completed browser parity pass. Browser
evidence and native API evidence are recorded separately; browser-level
composition events are covered by regression tests, while the real operating
system IME candidate UI remains unverified.

| Requirement | Intended behavior                                | Implementation and current evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R01         | Rich Markdown editing in VS Code                 | The dedicated editor uses the shared ProseMirror schema, Markdown parser, serializer, and commands. The host treats the VS Code `TextDocument` as the only source of truth. The 0.0.3 browser pass exercised toolbar word selection, list editing, code-language mouse editing, image loading, and source preservation after DOM observation and an edit. Rich IME behavior remains a manual check.                                                                                                                                                                                                                                                                                                                                              |
| R02         | Buttons, toolbar, and menu actions               | The Mint toolbar keeps heading, B/I/S, inline code, link, image, list, table, format, undo, and redo actions as direct buttons. The **Source** button returns to VS Code's standard raw Markdown editor, and dedicated preview remains a command-palette command; the 0.0.3 native acceptance suite verified command registration and format execution.                                                                                                                                                                                                                                                                                                                                                                                          |
| R03         | Direct mouse manipulation                        | ProseMirror selection, drag, image, and table interactions are wired in the webview editor. The 0.0.3 browser pass verified toolbar word selection, code-language mouse editing, image loading, and preservation of the raw relative image path after DOM observation and an edit.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| R04         | Rectangular table selection and matrix clipboard | ProseMirror tables use a rectangular selection and matrix clipboard path, with Markdown round trips in the core tests. In the 0.0.3 evidence, a real 2×3 rectangle copy/paste preserved its dimensions and one Undo request restored the prior table in the browser harness; native VS Code resource Undo/Redo was verified independently.                                                                                                                                                                                                                                                                                                                                                                                                       |
| R05         | Keyboard operations                              | Webview keymaps cover formatting, lists, tables, undo, redo, and navigation. Within a table, Enter moves to the next row in the same column and adds one row at the bottom when needed; Shift+Enter remains an in-cell hard break, and Tab/Shift+Tab retain cell navigation. Plain ArrowUp at the first visual row of a code block uses EditorView.endOfTextblock and moves to the previous editable textblock without changing the document; wrapped continuation rows, controls, modifiers, IME, and expanded-code focus remain guarded. Regression tests cover composition guards, Markdown round trips, and host-backed undo/redo; real operating system IME candidate behavior remains a manual check.                                      |
| R06         | Identical editor and preview output              | The dedicated preview and native Markdown preview use the same profile-aware core rendering path and shared `media/document.css`; the package contributes that stylesheet and a MarkdownIt adapter to the built-in preview. In the 0.0.3 evidence, across two fixtures and three viewport/typography combinations covering widths 1100 and 500 with Arial 14 and Georgia 20 cases, actual bundled rich output, core HTML, and the installed VS Code `markdown.css`/shared CSS produced matching block and table-cell metrics. The dedicated preview switch was included. Native API checks separately verified headings, GitHub/CommonMark table behavior, and relative image resources. Typography values are copied from `markdown.preview.*`. |
| R07         | GitHub and GitLab profiles                       | `github`, `gitlab`, and `commonmark` are validated protocol/profile values. Profile settings reach the editor, dedicated preview, and native adapter. The 0.0.3 native acceptance suite verified GitHub versus CommonMark table output; GitLab-specific fixtures remain a follow-up compatibility check.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| R08         | Safe formatting and format-on-save               | Prettier runs with the bundled Markdown parser/plugin, after/before core validation, project `.prettierrc` JSON/YAML options, `.editorconfig` EOL settings, `.prettierignore`, and explicit extension option overrides. Save-time failures leave the source unchanged, write diagnostics to the Markdown Mint output channel, and use a standard VS Code error notification when user action is required. The VS Code auto-save setting is not changed by the extension.                                                                                                                                                                                                                                                                         |

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
Alert body. A final Alert receives a transient paragraph so moving out with an
arrow does not change Markdown until text is entered. Textarea composition
events, non-collapsed selections, and native host Undo/Redo commands keep their
native behavior.

The webview regression suite covers these flows, including CRLF and
save/reload round trips. Live VS Code and operating-system IME behavior remain
manual checks.

Double-clicking an Alert card in the Rich Editor opens the existing Profile
Feature dialog in Edit mode. The dialog initializes the Alert type and body
from the current source, uses **Update** to change the same raw Alert block,
and returns focus to the Alert body textarea. Toolbar insertion continues to
use the same dialog in Insert mode with its existing defaults. Type-only edits
replace only the `[!TYPE]` marker, preserving lazy continuation lines and
other source bytes; body edits use the existing Alert body writer. An Alert
edit is rejected if the document, profile, or editing state changed while the
dialog was open.

## Code block vertical boundary navigation

In the Rich Editor, plain `ArrowUp` leaves a code block only when
`EditorView.endOfTextblock("up")` reports that the caret is on the first visual
row. This keeps ordinary movement within later logical lines and wrapped rows.
The destination is found with a text-only ProseMirror selection search, so
paragraphs, headings, list items, blockquotes, and adjacent code blocks receive
an editable caret rather than a leaf-node selection. An adjacent Alert focuses
its existing body textarea. Shift/Ctrl/Cmd/Alt, composition, non-empty
selections, language/menu controls, and expanded-code modal focus are left to
their existing handlers.

The webview suite covers these guards, document immutability, nested containers,
and selection-only navigation. Visual first-row/wrap behavior and the real
operating-system IME candidate UI require confirmation in a live VS Code
Extension Development Host; the package/native checks below do not replace
that manual geometry check.

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
- **Arrow Down** at the end of the last table cell and **Escape** both move the
  caret into a writable paragraph after the table. That paragraph remains
  transient while empty, so cancelling or leaving it does not add blank lines
  to the Markdown source.
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
  automatically; `Alt+F10` moves keyboard focus into it.
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
single edit, opening the selection formatting popover with Alt+F10 and
committing it from the keyboard, paragraph-start heading/list markers
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

## Explicit limits

Paste/drop image asset copying is optional follow-up work. Native IME and visual
geometry require a manual check in a real editor window. Project formatter-file
resolution targets local `file:` documents in the desktop Extension Host;
Remote and Web workspace URI schemes are outside this scaffold. The acceptance
runner uses a copied fixture under a temporary workspace and never mutates the
user's working files.

The publisher id is the local-development placeholder
`markdown-mint-local`; it is not a Marketplace ownership claim.
