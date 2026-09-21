# Link integrity

This document records the shared heading-anchor contract used by Markdown Mint.
The contract is intentionally separate from source ranges: heading occurrence
identity and exact source indexing are different responsibilities.

## Heading anchors

`collectHeadingAnchors(snapshot, profile)` in
`src/core/links/anchors.ts` is the single anchor calculation used by the core
renderer, the Rich Editor decorations, the dedicated preview, the native VS
Code Markdown preview adapter, and GitLab table-of-contents links.

Each returned occurrence contains:

- the display text used for the anchor, heading level, generated `id`, and
  profile verification state;
- a `renderRoot` and `nodePath` based occurrence identity. The immutable
  ProseMirror node object is not an identity because structured Details bodies
  can be reused at multiple document positions;
- a ProseMirror position when the occurrence belongs to the editable document.
  Headings parsed inside a source-backed Alert or unsupported Details fragment
  are identified by their fragment root and path instead.

The collector walks the rendered order and allocates final IDs against the
whole document. A heading whose base already ends in `-1` therefore cannot
collide with an earlier duplicate. For example, `A`, `A`, and `A-1` become
`a`, `a-1`, and `a-1-1`.

Footnote bodies are rendered after the main document under a distinct
`footnote:<label>` render root, while still participating in the same
document-wide collision allocation. GitLab table-of-contents output retains
its existing policy and excludes footnote-body headings.

## Profile rules

- GitHub lowercases letters, retains Unicode letters/numbers/marks, hyphens,
  underscores, and literal spaces, then changes spaces to hyphens. Other
  punctuation and whitespace are removed. Inline markup is removed by using
  rendered text; image alt text is retained and emoji shortcodes contribute
  their shortcode name.
- GitLab lowercases text, removes characters other than Unicode
  letters/numbers/marks, spaces, hyphens, and underscores, and changes each
  whitespace character to one hyphen. Repeated spaces and existing hyphens are
  therefore retained, as in `A  B` → `a--b` and `A---B` → `a---b`.
- CommonMark has no standard automatic heading-fragment rule. Markdown Mint
  keeps its historical display-only slug shape for compatibility, marks the
  result as not verifiable against a CommonMark standard, and does not invent
  a portable CommonMark fragment contract.

No profile performs NFKD decomposition, accent removal, or ASCII
transliteration. URI fragment percent-decoding belongs to the URI layer and is
not performed again while creating a slug.

The final ID is an implementation-visible rendering compatibility detail. A
collision fix can change the IDs of later duplicate headings; existing Markdown
source and existing href strings are not rewritten automatically.

GitLab snippet filename prefixes are outside this repository-file contract.
