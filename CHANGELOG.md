# Changelog

## Unreleased

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

- Added double-click Alert editing through the existing Profile Feature dialog.
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
