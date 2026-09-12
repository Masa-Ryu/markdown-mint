# Markdown Mint

**Write visually. Stay in Markdown.**

Markdown Mint is a visual Markdown editor for VS Code. Format text with a toolbar, edit tables directly, and work with GitHub and GitLab Markdown features without switching to a separate writing app.

Select a rectangle of table cells, copy it, and paste it into another part of the table. Your document stays a Markdown file, with the source editor always one click away.

## Features

| Feature | What you can do |
| --- | --- |
| Visual editing | Edit headings, paragraphs, bold, italic, strikethrough, inline code, quotes, lists, and task checkboxes. Available features follow the selected Markdown profile. |
| Table editing | Select multiple cells, copy and paste cell ranges, add or remove rows and columns, change alignment, and toggle a numbered column. |
| Links and images | Insert links and images, including images referenced by relative paths in local documents. |
| Code and diagrams | Work with fenced code blocks, choose a code language, and insert and preview Mermaid diagrams. |
| Platform-specific content | Insert alerts, collapsible sections, and math. GitLab mode also offers a table of contents, description lists, and inline diff markers. |
| Markdown formatting | Format on demand or enable format-on-save, with validation before formatted text is applied. |

## Get started

Requires **VS Code 1.90.0 or later**. The current release targets local files in desktop VS Code.

1. Install **Markdown Mint** by **masa-ryu** from the Extensions view. The extension ID is `masa-ryu.markdown-mint`.
2. Open a Markdown file.
3. Run **Markdown Mint: Open in Markdown Mint** from the Command Palette.
4. Edit with the toolbar, mouse, or keyboard. Select **Source** to return to VS Code's text editor.

You can also click **Open in Markdown Mint** above the first line of a Markdown file in the text editor, or choose Markdown Mint from the tab's **Reopen Editor With** menu.

Markdown Mint is an optional editor: installing it does not automatically make it the default editor for every Markdown file. Its custom editor is available for `.md`, `.markdown`, and `.mdown` files.

## Edit tables directly

Choose a table size with the grid picker or enter the row and column counts. Table controls appear when you are editing a table.

Drag across cells to select a rectangular range. Use **Ctrl+C / Cmd+C**, select a destination cell, and use **Ctrl+V / Cmd+V** to paste. The destination cell is the top-left corner of the pasted range; the table expands when more rows or columns are needed.

You can also paste tab-separated data into a table. This is useful for transferring rows from spreadsheet tools; it does not reproduce a spreadsheet's merged cells or arbitrary formatting.

Use **Tab** and **Shift+Tab** to move between cells. Press **Escape** while editing a table to move to a paragraph after it.

## Choose a Markdown profile

Select a profile from the editor's dropdown or set `markdownMint.profile` in VS Code settings.

| Profile | Intended use |
| --- | --- |
| **GitHub** — default | GitHub-oriented Markdown, including GFM tables and task lists, alerts, collapsible sections, Mermaid, and math. |
| **GitLab** | GitLab-oriented Markdown, with additional insertion controls for a generated table of contents, description lists, and inline diff markers. |
| **CommonMark** | Core Markdown features without the GitHub/GitLab feature toolbar. |

Profiles support selected platform syntax locally. They are not complete replicas of GitHub or GitLab, and they do not guarantee pixel-identical rendering on those websites.

Some content, including raw HTML and front matter, is represented as source-backed blocks rather than fully editable rich text. Use **Source** when you need to edit its exact syntax.

## Preview and source

Run **Markdown Mint: Open Dedicated Preview** to open Mint's separate preview.

The dedicated preview and Mint's integration with VS Code's built-in Markdown preview use a shared profile-aware rendering pipeline. The rich editor shares document styles and follows VS Code's Markdown preview font settings.

Markdown Mint also contributes styles and rendering support to the built-in Markdown preview. Other preview extensions, custom styles, and differences in viewport size can affect the result.

Your Markdown text document remains the source of truth. Undo and redo use VS Code's document history. When an edit conflicts with a newer document version, Mint offers draft recovery rather than silently replacing the newer content.

## Formatting

Select the **Format** toolbar button or run **Markdown Mint: Format Document** to format the current document.

Format-on-save is **off by default**. To enable it for a workspace, add this to its VS Code settings:

```json
{
  "markdownMint.profile": "github",
  "markdownMint.formatOnSave": true
}
```

The formatter uses Prettier, reads supported project configuration such as `.prettierrc`, `.editorconfig`, and `.prettierignore`, and validates the result before applying it. Executable formatter configuration is only evaluated in a trusted workspace. A rejected formatting result leaves the document unchanged.

Document formatting may update source layout outside the text you just edited. It is a separate operation from normal visual editing.

| Setting | Default | Purpose |
| --- | --- | --- |
| `markdownMint.profile` | `"github"` | Select `github`, `gitlab`, or `commonmark`. |
| `markdownMint.formatOnSave` | `false` | Enable Markdown Mint's format-on-save behavior. |
| `markdownMint.prettierOptions` | `{ "printWidth": 80, "proseWrap": "preserve" }` | Supply additional options to the Markdown formatter. |

## Keyboard shortcuts

These shortcuts apply while the rich editing surface is focused. Use **Ctrl** on Windows/Linux and **Cmd** on macOS where shown.

| Action | Shortcut |
| --- | --- |
| Bold | Ctrl/Cmd+B |
| Italic | Ctrl/Cmd+I |
| Strikethrough in GitHub/GitLab mode | Ctrl/Cmd+Shift+X |
| Save | Ctrl/Cmd+S |
| Undo | Ctrl/Cmd+Z |
| Redo | Ctrl/Cmd+Shift+Z |
| Next / previous table cell | Tab / Shift+Tab |
| Indent / outdent a list item | Tab / Shift+Tab |
| Focus the formatting popover after selecting text | Alt+F10 |

To find extension commands, open the Command Palette and search for **Markdown Mint**.

## Current limitations

Markdown Mint is in early development. Keep important documents under version control, especially when trying new syntax or formatting options.

Not every GitHub or GitLab feature has a rich editing control. Some content requires source editing. Local GeoJSON, TopoJSON, and ASCII STL previews are simplified static representations, not the interactive viewers hosted by GitHub.

Remote and Web workspaces are outside the currently supported scope. Real operating-system IME candidate-window behavior also remains a manual validation area.

## Feedback

Use the **Q & A** tab on the Markdown Mint Marketplace page for questions and feedback. For a reproducible problem, include the extension version, VS Code version, operating system, selected Markdown profile, a small Markdown example, and the steps that triggered it. Remove sensitive content before sharing an example.

## License

MIT. See the `LICENSE` file included with the extension.
