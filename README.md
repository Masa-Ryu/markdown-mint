# Markdown Mint

Markdown Mint is a development VS Code extension for editing Markdown as a
structured document while keeping the Markdown text document authoritative. It
provides a ProseMirror-based editor surface, a dedicated preview, and a shared
typography/media stylesheet contribution for the built-in VS Code Markdown
preview.

The extension is currently a development build. `markdown-mint-local` is a
placeholder publisher id for local packaging; it does not claim a Marketplace
listing.

## Development

Use Node.js 20 or newer, then run:

```sh
npm install
npm run build
npm test
```

Open this folder in VS Code and press `F5` to launch an Extension Development
Host. The custom editor is offered through **Reopen With**, so installing a
development build does not silently take over every Markdown file. The command
palette includes commands for opening the dedicated preview, opening the text
source, and formatting the active Markdown document.

When a Markdown file is open in the normal Text Editor, the **🌿 Open in
Markdown Mint** CodeLens appears above the first line. Selecting it reuses the
current tab for the Markdown Mint editor and leaves the source document
untouched.

To install a locally built VSIX, run `npm run package`, then use **Extensions:
Install from VSIX...** in VS Code and choose the generated
`markdown-mint-0.0.13.vsix`. Reopen a Markdown file with **Markdown Mint**
when you want the rich editor.

The profile dropdown selects **GitHub** (the default), **GitLab**, or
**CommonMark** through `markdownMint.profile`. `markdownMint.formatOnSave`
enables the safe formatter for Markdown documents; a formatted result is parsed
and validated before it is offered as a save edit.

The 0.0.13 package keeps the Markdown Mint extension identity introduced in
0.0.4 and adds profile-specific GitHub and GitLab feature insertion alongside
contextual table editing. Existing Markdown Mint
0.0.4 and later installations can update in place. When migrating from an
older Markdown Weaver development build, uninstall that older package first,
choose **Markdown Mint** with **Reopen With**, and migrate the Markdown Mint
settings as needed.

The table picker now lets a grid click select and preview a size before insertion;
double-clicking inserts that size immediately, while numeric row and column
fields below the grid support direct sizing. When a table is active, its row,
column, alignment, numbering, and delete actions appear as compact groups in
the main top toolbar; they are hidden outside a table. The **Source** button
returns to the raw Markdown editor and stays at the right edge of the normal
writing controls. The dedicated preview remains available through the
**Markdown Mint: Open Dedicated Preview** command. At the end of the last cell,
**Arrow Down** or **Escape** opens a writable paragraph after the table; that
empty paragraph is omitted until text is entered. Clicking below the document
places the caret at that height with temporary blank paragraphs, which are
discarded when unused and committed when typing begins. The toolbar's **Emoji**
button opens a searchable common emoji picker and inserts at the saved
selection. Image and table insertion use distinct SVG icons.

GitHub and GitLab editing modes show a second feature row below the main
controls; it moves below the table row while a table is active and is hidden
for CommonMark and dedicated preview. GitHub offers Alert, Details, Math, and
Mermaid insertion. GitLab also offers a generated table of contents,
description lists, and added or removed diff text. Dialogs use the current
selection as a starting value, preserve focus on cancel, and discard stale
submissions safely.

Fenced GeoJSON, TopoJSON, and ASCII STL blocks receive bounded local SVG
previews with point labels or projected triangles. The previews do not load map
tiles or network resources; invalid or oversized data remains available as
escaped source.

## Design

The extension host owns each `TextDocument` version and serializes requests per
document. Webview edits carry the base document version and an operation id.
Stale or invalid edits are rejected with the submitted draft preserved for
explicit recovery, so a concurrent external edit is never silently replaced.
Undo and redo are sent to VS Code's native resource history; the webview does
not maintain a second undo stack.

The built-in Markdown preview receives `media/document.css` through VS Code's
`markdown.previewStyles` contribution. The dedicated preview uses the same
stylesheet and the same profile-aware rendering pipeline when both surfaces are
available.

The writing flow opens directly in the structured editor; **Source** returns
to VS Code's standard raw Markdown text editor and stays at the toolbar's right
edge. The profile dropdown selects **GitHub** (the default), **GitLab**, or
**CommonMark**. The toolbar keeps heading, **B**, **I**, **S**, inline code,
link, image, list, and table controls directly visible alongside the other
editing actions. Table numbering adds a `#` header and sequential body
numbers, and a second activation removes that column. Undo and redo remain
available through the standard keyboard/native history commands. It has no
**Preview** button; use the
command palette's **Markdown Mint: Open Dedicated Preview** command when you
need the separate preview. A blank document starts from an H1 `Title` starter
and keeps an untouched blank H1 out of the emitted Markdown; pressing Enter
moves into a normal paragraph. At a paragraph start, typing `#` through
`######`, `>`, `-`/`+`/`*`, or a positive `N.` followed by a space applies the
matching heading, quote, or list block. An empty paragraph shows a `+` button
that opens the **Insert** menu. A non-empty text selection shows the formatting
popover automatically; `Alt+F10` moves keyboard focus into it. The surface
follows the active VS Code theme and Markdown preview font settings.
Toolbar and menu controls expose one shared tooltip on hover or focus, including
disabled menu actions, and close it on leave, blur, Escape, click, or scroll.
Bullet, ordered, and task-list buttons act as toggles and expose their active
state through `aria-pressed`. Final interaction validation is tracked in
`docs/requirements.md`.

The initial editor schema supports headings, paragraphs, emphasis, strong and
strike marks, inline and fenced code, block quotes, ordered and unordered
lists, task checkboxes, links, images, hard breaks, and GitHub/GitLab tables.
Raw HTML, front matter, custom Markdown-it extensions, and syntax that cannot be
represented by that schema are preserved as rendered atoms in Mint. Use **Source**
to edit their exact Markdown; Mint keeps their source content intact while
showing the available rendered form.

Markdown source messages are limited to two million UTF-16 code units,
operation ids to 160 characters, and local resource URLs to 8,192 characters.

## Validation

`npm run compile` runs TypeScript in strict mode, `npm run lint` checks source
and tests, `npm test` runs unit tests, and `npm run package` builds a VSIX using
the local placeholder publisher id. `npm run test:extension` bundles and runs
the native acceptance suite against the installed VS Code executable when
available (or the test-electron download fallback), using an isolated
temporary workspace. Project `.prettierrc` JSON/YAML, `.editorconfig`, and
`.prettierignore` are read safely; executable formatter config is evaluated
only in a trusted workspace. Project-file resolution targets local `file:`
documents in the desktop Extension Host; Remote and Web workspace URI schemes
are outside this development scaffold.
