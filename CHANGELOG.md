# Changelog

## Unreleased

- Improved inline Alert editing without changing its visual design. Lazy
  blockquote continuation lines, quoted blank lines, separators, and line
  endings round-trip correctly; input keeps the existing textarea and focus;
  ArrowLeft/ArrowRight move between consecutive Alert bodies and adjacent
  paragraphs at their boundaries; native textarea composition and host history
  commands remain protected.

## 0.0.12

- Added GitHub and GitLab feature controls for alerts, details, math, Mermaid,
  and GitLab-only TOC, description-list, and inline diff insertion.
- Added guarded feature dialogs with selection defaults, accessible tooltips,
  responsive toolbar rows, and stale-edit protection.
