# Changelog

## 0.5.1

- Preserve zero-based and nine-digit ordered-list starts when editing and
  serializing lists, including nested lists, without emitting invalid
  ten-digit markers.
- Preserve backslashes and literal character-reference text in link and image
  titles across Rich edits, including table cells and repeated serialization.

## 0.5.0

- Preserve structured recovery drafts in a separate pending slot when the
  authoritative document, profile, or recovery source prevents automatic
  restoration, so later input, acknowledgements, saves, and external changes
  cannot overwrite the retained ProseMirror JSON and provenance.
- Add an explicit pending-draft review flow that keeps cancellation safe,
  opens a confirmed draft as a separate untitled document, and supports
  deliberate discard without applying stale content to the current document.

## 0.4.9

- Restore source-only Markdown metadata, including footnote and reference
  definitions, when recovering structured drafts after serializer failures;
  validate recovery provenance and keep unsafe legacy drafts pending instead of
  synchronizing incomplete Markdown.

## 0.4.8

- Add full README translations for 13 languages under `docs/i18n/`, preserving
  the English README content, structure, and demo images.
- Add language navigation to the root README and all translations, ordered
  by total speaker population with Simplified and Traditional Chinese grouped
  together.

## 0.4.7

- Bound three-way Markdown merge work and retained trace state so broad external
  changes cannot monopolize the Webview, falling back to the existing explicit
  conflict path when the safety budget is exhausted.
- Preserve recoverable local drafts and their original base provenance across
  stale edits, delayed acknowledgements, external changes, and Webview
  recreation.

## 0.4.6

- Complete edit, format, and save operation failure paths when VS Code rejects
  or throws during WorkspaceEdit application or document reopening, preserving
  the Webview draft and preventing stuck synchronization state.

## 0.4.5

- Prevent large code-block and inline-code serializations from overflowing
  function arguments while selecting a safe backtick fence.

## 0.4.3

- Preserve multiline and code-adjacent reference definitions when neighboring
  Markdown blocks are deleted or edited, including mixed line endings and
  first-valid duplicate resolution without rescuing fenced-code text.

## 0.4.2

- Preserve structured recovery snapshots after serializer failures, including
  when the saved ProseMirror document cannot be restored, without overwriting
  or synchronizing stale Markdown fallback.
- Keep the authoritative document displayed while retaining the pending
  structured recovery for a later or explicit recovery attempt.

## 0.4.1

- Preserve semantic backslash-and-pipe sequences in non-code raw inline math
  and HTML content when neighboring table cells are edited or serialized
  repeatedly, without double-escaping code-marked raw inline content.
- Keep the existing image alt/title, link title/destination, inline code, and
  table-cell pipe protection behavior intact.

## 0.4.0

- Add direct row and column table controls based on the visible cell grid,
  including structural selection, drag previews, boundary insertion, append
  controls, keyboard movement, numbering protection, source synchronization,
  and Undo/Redo-safe transactions.
- Keep drag previews bounded and readable by combining destination text with
  the preview, using horizontal row and vertical column excerpts, and
  supporting light, dark, and forced-color themes with visible move indicators
  and drop feedback.
- Integrate table movement actions into the existing Table Toolbar with
  separate arrow-only movement icons, while retaining the existing table/grid
  icons for row and column additions.

## 0.3.6

- Show the Rich Editor Selection Toolbar for non-empty text selections within
  a single table cell while keeping CellSelection, cross-cell selections,
  collapsed cursors, and table-boundary selections excluded.
- Preserve the existing table toolbar, Tab navigation, profile restrictions,
  and inline formatting actions.

## 0.3.5

- Enable VS Code's standard Webview Find Widget in the Markdown Mint Custom
  Editor without changing dedicated preview behavior or adding editor-side
  search logic.

## 0.3.4

- Make document containers responsive across the Rich Editor, Dedicated
  Preview, and native Markdown preview, using approximately 85% of the
  available width with a 640px minimum and 1800px maximum while preserving
  narrow viewport behavior.

## 0.3.3

- Fix modal keyboard activation so synthesized button clicks continue to run
  their intended actions instead of being mistaken for backdrop cancellation.
- Keep dirty-dialog discard confirmation and focus restoration intact while
  closing the clean Emoji picker and code-language removal confirmation from a
  safe backdrop click without adding dirty confirmation.

## 0.3.2

- Improve the table deletion toolbar by disabling Row and Column deletion for
  full-axis cell selections while keeping Table deletion available.
- Preview only the deleted logical row or column across rowspan and colspan
  cells without changing the ProseMirror document, selection, or table layout.

## 0.3.1

- Collapse a Rich Editor Selection Toolbar text selection to its ProseMirror
  head on Escape without changing Markdown, dirty state, or edit history.
- Keep the shared `+` and `/` Insert popup's Arrow/Home/End navigation as one
  continuous two-column grid across standard commands and profile features,
  while retaining circular Tab and Shift+Tab navigation through enabled items.
- Prevent Profile Feature dialogs opened from the Insert popup from restoring
  focus to hidden menu items; Escape and Cancel return focus to the editor.

## 0.3.0

- Redesign Link and Image file autocomplete with responsive dialogs, a
  selection-aware Link picker, single active-candidate keyboard and pointer
  behavior, and workspace-file search exclusions for `.git` and
  `node_modules`.
- Improve autocomplete responsiveness with index-complete warm-up, prepared
  metadata ranking, bounded top-ten results, explicit loading/empty states,
  stale-result protection, and incremental active-row DOM updates.
- Preserve raw Markdown destinations, percent-encoded filenames, external
  link handling, query and fragment behavior, and remote/virtual workspace URI
  scheme and authority values.

## 0.20.0

- Interpret multi-cell TSV, HTML-table, and Markdown Mint internal clipboard
  payloads pasted outside the Rich Editor's existing tables as a header-first
  Markdown table, while keeping ordinary multiline text, one-cell pastes,
  CommonMark, code, raw, and native text-oriented surfaces on their normal
  paste paths.
- Preserve displayed cell strings and internal rich content where safe, use
  the internal → TSV → HTML priority lazily, reject malformed or oversized
  matrices as a whole at the shared 10,000-cell limit, and keep the existing
  table paste, expansion, copy, cut, and selection behavior. Table HTML with
  no safe fallback never reaches the native HTML parser, and spreadsheet paste
  checks the final serialized Markdown against the shared two-million UTF-16
  code-unit source limit before committing the ProseMirror transaction.

## 0.2.0

- Add local PNG, JPEG/JPG, GIF, WebP, and SVG image import to the Rich Editor
  via Shift + drag-and-drop from files or workspace resources. Imported images
  are stored in a sibling `images/` directory and inserted with portable,
  URL-safe relative Markdown paths.
- Make image import safe under concurrent drops and filename collisions without
  overwriting existing files, while keeping filenames with URL-special
  characters usable in Markdown.
- Preserve the intended drop position across asynchronous imports and document
  edits, reject invalid insertion locations before saving, and cleanly handle
  failed imports without modifying the Markdown document.

## 0.1.0

- Improve Mermaid Insert and Edit dialogs with a large, viewport-bounded,
  editor-first layout and accessible source labeling.
- Use concise `Insert Mermaid` and `Edit Mermaid` titles without changing the
  shared Profile Feature labels or other feature dialog titles.
- Show the installed Mermaid runtime version, humanized diagram type, and
  debounced live syntax status while keeping the existing strict renderer
  security settings and source normalization.
- Block empty, checking, invalid, stale, and out-of-date Mermaid submissions,
  including Ctrl/Cmd+Enter, and protect asynchronous validation from races and
  dialog closure.

## 0.0.53

- Improve Marketplace metadata and README searchability for visual WYSIWYG
  Markdown editing, tables, GitHub/GitLab Markdown, Mermaid, math, and source
  editing.

## 0.0.52

- Update the Link dialog destination field to accept relative paths, root paths,
  fragments, HTTPS URLs, and mailto URLs without converting or normalizing the
  Markdown href. Preserve the existing safe URL rendering controls for unsafe
  schemes.

## 0.0.50

- Move every contextual table-toolbar icon to the shared SVG asset pipeline,
  preserving the existing groups, labels, commands, accessibility state, and
  14px icon attributes while using the dedicated table/row/column delete
  artwork.
- Normalize each imported SVG once and clone its cached template for later
  renders, avoiding repeated DOMParser work without sharing DOM nodes or
  leaking per-call class, size, or accessibility attributes.

## 0.0.49

- Delegate ordinary text pasted into a table cell from a `TextSelection` to
  ProseMirror's standard paste pipeline, preserving the surrounding text and
  replacing only the selected range. Keep rectangular TSV, HTML table,
  Markdown Mint internal clipboard, and `CellSelection` table paste behavior.

## 0.0.48

- Prevent Insert popup items from showing simultaneous keyboard-focus and
  stale-pointer hover backgrounds. Track popup input modality so `+` and `/`
  keyboard opening and Arrow/Home/End navigation use keyboard styling, while
  actual pointer movement restores normal hover feedback.

- Keep the Code language picker idle on open: the search input receives focus,
  no candidate is active, and only the configured language is selected.
- Track keyboard and pointer modality separately so Arrow/search navigation
  exposes one active candidate while pointer movement restores hover feedback.
  Empty Enter no longer removes a language implicitly.

## 0.0.47

- Apply authoritative terminal whitespace changes to the Rich document instead
  of retaining stale empty paragraphs. Keep source-authored blank-line shape
  visible with a bounded, source-preserving spacer for oversized blank runs,
  and align empty-paragraph preview geometry across Rich and native surfaces.

## 0.0.46

- Materialize source-authored surplus top-level blank lines as editable Rich
  empty paragraphs while preserving their original LF/CRLF source slices.
  Round-trip Rich-created blank paragraphs, explicit Format Markdown cleanup,
  and transient trailing caret paragraphs without leaking generated spacing.

## 0.0.45

- Commit only the paragraph typed after clicking below the final Rich editor
  block. Generated transient spacing is removed in the same edit, preserving
  LF/CRLF block separators and host undo behavior.

- Add a hover-only top-level block-gap `+` affordance that reuses the existing
  Insert block popup without changing layout or Markdown until a block is
  committed. Keep flow-to-flow and flow-to-structural arrow navigation direct,
  and expose a boundary stop only between adjacent structural top-level
  blocks. An active boundary decoration temporarily reserves one visual line
  without changing the ProseMirror document, and first/last structural blocks
  expose corresponding document-edge insertion boundaries; flow edges remain
  handled no-ops. Profile block features now accept that
  `BlockBoundarySelection` directly, so Alert, Details, Math, Mermaid, and
  GitLab block features insert at the exact gap without a temporary paragraph.

## 0.0.44

- Preserve strong, emphasis, strikethrough, combined marks, link destinations,
  and link titles when generic serialization edits a paragraph containing a
  linked inline Math atom, including single-child and identical Math links.
  Keep source-slice preservation for Math-only edits and avoid nested link
  markup when a rendered Math NodeView is wrapped by a ProseMirror link mark.

## 0.0.43

- Make every supported Math form consistently editable from its rendered atom:
  inline `$...$`, display `$$...$$`, and fenced `math`, `latex`, `tex`, and
  `asciimath` sources now share the existing Edit Math dialog. Preserve Math
  wrappers, aliases, metadata, fence style, indentation, line endings, marks,
  links, and stale drafts while keeping ordinary text double clicks native.

## 0.0.42

- Restrict Block quote and Code block toolbar active state to selections that
  share the target block ancestor. Ranges across separate same-type blocks or
  a normal paragraph are inactive, while nested selections sharing an outer
  blockquote remain active.

## 0.0.41

- Unify the main and selection toolbar's semantic active state from the current
  ProseMirror selection. Bold, italic, strikethrough, inline code, and link
  now share one mark helper, while list, blockquote, code block, and table
  state is reflected through synchronized `aria-pressed` and active styling.
- Keep Table active for text cursors, cross-cell selections, and `CellSelection`
  through the existing table context rules. Image and horizontal rule expose
  active state only for an explicit `NodeSelection`; insert-only commands keep
  no persistent state, and CommonMark-disabled controls remain inactive.

- Delegate ordinary ArrowUp and ArrowDown movement inside ProseMirror
  textblocks, including syntax-highlighted and wrapped Code blocks, to the
  browser's native caret and scrolling behavior. Markdown Mint still uses
  `endOfTextblock()` to place a virtual boundary only at the first or last
  displayed row, preserving the desired horizontal column when crossing
  blocks.
- Add a repeated Chromium regression fixture for multiline JavaScript, blank
  rows, viewport scrolling, wrapped lines, reverse movement, and unchanged
  Markdown/history state. Expanded Code, Alert textarea navigation, table
  navigation, and atomic block boundaries remain on their existing paths.

## 0.0.40

- Add a virtual, keyboard-only caret between top-level blocks. Plain horizontal
  and visual-line vertical navigation now crosses Code, Alert, Details,
  rendered blocks, tables, and paragraphs through an intermediate boundary
  without changing Markdown, dirty state, or undo history.
- Materialize one real paragraph only when text, Enter, composition input, or
  paste begins at a boundary. Existing direct editing, atomic block selection,
  table navigation, slash insertion, and source-preserving serialization remain
  intact.

## 0.0.39

- Remove the persistent Math/Mermaid source labels. Rendered Math and Mermaid
  blocks now open the existing edit dialog on double click or Enter/Space,
  while interactive descendants keep their own controls.
- Select Details and Code nodes from their non-editing padding, headers, or
  line numbers without adding history or dirty state. Body text and existing
  controls retain direct editing, and standard Delete/Backspace removes the
  selected node for host-backed Undo/Redo restoration.

## 0.0.38

- Keep physical Alert header mouse clicks inert while making the accessible
  `role="button"` activation work for synthetic clicks, Enter, and Space.
- Ignore duplicate synthetic activation after keyboard opening so one dialog
  and one source flush are performed.

## 0.0.37

- Keep Alert bodies directly editable on a single click while opening the
  existing Alert editor dialog from a body or header double click.
- Remove the single-click Alert type picker and suppress the block selection
  outline while the native body editor or its dialog is active. Flush the
  latest textarea value before opening the dialog and restore body focus after
  it closes. Preserve physical mouse single-click inertness while supporting
  keyboard and assistive-technology activation of the accessible header.

## 0.0.36

- Use markdown-it inline tokens when finding Details tags. Details-like text in
  general HTML attributes, link destinations/titles, image alt text, comments,
  code spans, and escaped text no longer changes Details ranges or nesting.
- Keep real `html_inline` Details wrappers, nested Details, source attributes,
  inline HTML, summary markup, and profile-aware serialization intact.

## 0.0.35

- Detect Details within markdown-it block contexts so unmatched backticks cannot
  consume later blocks and raw HTML, including script, style, pre and textarea,
  cannot supply false closing or nested Details tags.
- Reuse profile-aware Details ranges during rendering and direct edits. Retain
  original attributes, raw HTML, nesting, LF/CRLF/CR and adjacent source
  separators when changing a summary or body.
- Integrate the latest synchronization/recovery changes from main while retaining
  accepted Alert input during rejected edits and deferred composition rebases.

## 0.0.34

- Keep Details directly editable when surrounding Markdown contains escaped
  backticks, HTML comment openers, or Details tags. Respect backslash parity,
  remaining backticks after an escape, and paragraph boundaries while retaining
  literal code/comment content and exact Markdown source.

## 0.0.33

- Make focused Alert bodies read-only immediately after a synchronization
  conflict, retaining accepted text and delayed composition input in recovery.
- Preserve movement between displayed rows inside expanded code blocks while
  preventing vertical movement into the background document at their edges.
- Recognize Details around literal HTML comment markers in inline and fenced
  code, while excluding real comments in source order.
- Allocate heading anchors by document position so cached identical Details
  bodies have unique HTML, rich-editor, and TOC targets; refresh TOCs after edits.

## 0.0.32

- Keep code and Alert bodies directly editable; use single-click language/type
  labels and preserve source whitespace, fences, metadata, and body selections.
- Edit Details headings inline with independent disclosure controls and a
  structured, directly editable body. Preserve original tags, attributes,
  nested source, local expansion state, IME input, and conflicting drafts.
- Edit existing Math/Mermaid source from their header labels without inserting
  duplicate blocks or losing focus after an update.
- Move in both directions between editable bodies with plain arrows, including
  wrapped Alert rows, persistent horizontal caret positions, closed/rendered
  block stops, and document-end caret targets that do not dirty Markdown.

## Earlier unreleased changes

- Improved Selection Toolbar keyboard access: its five selection buttons keep
  accessible aria-labels without overlapping per-button tooltips, and Tab from
  an eligible text selection moves focus to the first enabled button while
  preserving the selection. Native Tab/Shift+Tab navigation, keyboard command
  activation, Escape, and existing Table/List Tab behavior are unchanged.

- Improved the Rich Editor's empty-line Insert block menu with explicit Bullet
  list and Ordered list labels, two-dimensional keyboard navigation that skips
  profile-disabled items, and a transient `/` trigger for the same popup.
  Canceling the slash menu restores and materializes one literal slash, while
  committed commands consume it without adding a slash-only edit. The popup
  also includes Image through the existing image dialog and saved-selection
  path, with accessible item labels and no redundant item tooltips.

- Improved TextDocument-authoritative synchronization and save handling. Exact
  edit bases now survive queued input, delayed or duplicate acknowledgements,
  and bounded stale retries; safe independent external changes are merged
  automatically while overlapping changes preserve both sources. Save results
  distinguish the requested version from later unsaved input, and real save
  failures remain visible through VS Code and the Markdown Mint output channel.
- Recovery data now records document identity, base source, version, and
  profile. Matching drafts, including an empty draft, restore automatically
  without a Recover control; parser and serializer failures preserve raw or
  structured input. Removed the dedicated bottom synchronization/recovery
  status UI and its empty layout space.

- Improved the Rich editor table toolbar lifecycle: it stays hidden until the
  first table focus, then remains mounted and visible while table actions are
  disabled outside the current table. The initial reveal uses one short,
  reduced-motion-aware animation; table selection, targeting, serialization,
  and existing profile/mode restrictions are unchanged.

- Added a Rich Editor authoring aid that displays validated six-digit
  hexadecimal RGB literals in their own color. The display-only decoration
  updates while editing without changing Markdown source, previews, links,
  inline code, fenced code blocks, or raw nodes.

- Fixed block spacing across the rich editor, dedicated preview, and native
  Markdown preview. Rich NodeView wrappers now own outer margins while their
  inner display blocks stay margin-free; GitLab TOC and description lists use
  the ordinary block rhythm; terminal details, alert, quote, and list content
  no longer adds an extra bottom gap; and empty rendered nodes stay hidden
  without changing preserved Markdown comments or source structure.

- Fixed plain `ArrowUp` at the first visual row of a code block so it moves to
  the previous editable block, including wrapped lines and nested containers,
  while preserving normal in-code movement, controls, modifiers, IME, and
  expanded-code focus trapping.

- Fixed Mermaid flowchart node labels that drifted right when Mermaid's inline
  stylesheet was blocked by the strict Webview CSP. Shared external CSS now
  restores centering only for `flowchart-v2` node labels; edge labels, other
  diagram types, CSP, sanitization, and Markdown source preservation remain
  unchanged.

- Simplified the code-language picker to show language labels only while
  retaining searchable identifiers, aliases, and highlighting metadata.

- Fixed modal submit shortcuts to use the platform primary modifier: Command+Enter
  on macOS and Ctrl+Enter on Windows/Linux. Link, image, profile-feature, and
  table insertion/editing modals capture the shortcut at the document boundary
  before nested controls can stop propagation. Submission preserves IME
  composition, excludes destructive confirmations, and lets modal-local key
  handlers update their state before the form is submitted.

- Fixed image insertion to accept relative paths while preserving the original
  Markdown source and existing absolute URL support.

- Fixed Block quote toolbar toggling to unwrap blockquotes with ProseMirror's
  lift transform while preserving Markdown, block structure, and cursor
  position.
- Fixed explicit code-language switching for languages that share a
  highlight.js grammar, aligned code-block gutter/body typography across
  preview surfaces, and added confirmation before removing info-string
  metadata.

- Reduced unnecessary edit-time serialization, hidden preview rendering, and
  re-highlighting of unchanged code while preserving synchronization, safety,
  and display quality.

- Improved inline Alert editing without changing its visual design. Lazy
  blockquote continuation lines, quoted blank lines, separators, and line
  endings round-trip correctly; input keeps the existing textarea and focus;
  ArrowLeft/ArrowRight move between consecutive Alert bodies and adjacent
  paragraphs at their boundaries; native textarea composition and host history
  commands remain protected.

- Added Alert source editing through the existing Profile Feature dialog.
  Insert and Edit modes now share the dialog, preserve the existing Alert body,
  update the same raw Alert block, and keep lazy continuation source unchanged
  when only the Alert type changes.

## 0.0.23

- Reworked code-block headers across the rich editor, dedicated preview, and
  native Markdown preview with searchable language selection, preserved
  info-string metadata, reliable copy feedback, in-Webview expansion, and
  working display actions for wrapping, line numbers, and Markdown copying.

## 0.0.12

- Added GitHub and GitLab feature controls for alerts, details, math, Mermaid,
  and GitLab-only TOC, description-list, and inline diff insertion.
- Added guarded feature dialogs with selection defaults, accessible tooltips,
  responsive toolbar rows, and stale-edit protection.
