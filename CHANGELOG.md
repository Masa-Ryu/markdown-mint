# Changelog

## Unreleased

- Added Ctrl+Enter submission for link, image, profile-feature, and table
  insertion/editing modals while preserving IME composition and excluding
  destructive confirmation dialogs.

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
