# Changelog

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
