# Markdown Weaver

Markdown Weaver is a development VS Code extension for editing Markdown as a
structured document while keeping the Markdown text document authoritative. It
provides a ProseMirror-based editor surface, a dedicated preview, and a shared
typography/media stylesheet contribution for the built-in VS Code Markdown
preview.

The extension is currently a development build. `markdown-weaver-local` is a
placeholder publisher id for local packaging; it does not claim a Marketplace
listing. The working name is also provisional because another public project
uses the same name.

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

To install a locally built VSIX, run `npm run package`, then use **Extensions:
Install from VSIX...** in VS Code and choose the generated
`markdown-weaver-0.0.1.vsix`. Reopen a Markdown file with **Markdown Weaver**
when you want the rich editor.

`markdownWeaver.profile` selects `commonmark`, `github` (the default), or
`gitlab`. `markdownWeaver.formatOnSave` enables the safe formatter for Markdown
documents; a formatted result is parsed and validated before it is offered as a
save edit.

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

The initial editor schema supports headings, paragraphs, emphasis, strong and
strike marks, inline and fenced code, block quotes, ordered and unordered
lists, task checkboxes, links, images, hard breaks, and GitHub/GitLab tables.
Raw HTML, front matter, custom Markdown-it extensions, and syntax that cannot be
represented by that schema are preserved for source editing and rendered by the
native preview, while the rich editor keeps such documents read-only until a
compatible representation is available.

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
