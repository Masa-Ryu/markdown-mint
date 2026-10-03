**English** | [简体中文](docs/i18n/README.zh-CN.md) | [繁體中文](docs/i18n/README.zh-TW.md) | [Español](docs/i18n/README.es.md) | [Français](docs/i18n/README.fr.md) | [Português (Brasil)](docs/i18n/README.pt-BR.md) | [Русский](docs/i18n/README.ru.md) | [Deutsch](docs/i18n/README.de.md) | [日本語](docs/i18n/README.ja.md) | [Türkçe](docs/i18n/README.tr.md) | [한국어](docs/i18n/README.ko.md) | [Italiano](docs/i18n/README.it.md) | [Polski](docs/i18n/README.pl.md) | [Čeština](docs/i18n/README.cs.md)

# Markdown Mint

## **Write visually. Stay in Markdown.**

A visual WYSIWYG Markdown editor for VS Code.

Edit text, tables, checklists, and technical documentation directly in a visual editor—then switch to the Markdown source whenever you need precise control.

No migration required. Just open the Markdown files you already have and start writing.

![overview](./docs/media/overview.gif)

## Focus on writing

Markdown Mint is designed to keep formatting out of your way so you can focus on the content.

Use **slash commands** `/` to quickly insert blocks and elements without reaching for Markdown syntax\.

Select text to bring up a contextual toolbar with the formatting options you need, right where you need them.

Keyboard navigation is built in too. Use the **Tab key** to move through selectable elements and keep your hands on the keyboard.

Working with tables is just as simple. Copy and paste table content directly without manually editing Markdown syntax.

![focus-on-writing-demo](./docs/media/focus-on-writing-demo.gif)

## Platform-specific Markdown support

Markdown Mint supports Markdown features provided by platforms such as GitHub and GitLab.

With **GitHub Mode**, you can use GitHub-specific features such as **Alerts** and **Mermaid diagrams** directly in the visual editor.

![platform-specific-demo](./docs/media/platform-specific-demo.gif)

## More built-in features

Markdown Mint includes additional tools for working with real-world Markdown documents:

✅Add automatic numbering to tables\.

✅Copy cells from Excel or Google Sheets and paste them directly into a Markdown table\.

✅Drag and drop images from outside VS Code to insert them into your document\.

✅Quickly create image references, URLs, and internal links with automatic suggestions and search\.

✅Export Markdown as standalone HTML or A4 PDF from the current document\.

## Copilot prose suggestions

With a Markdown Mint Rich Editor active, run **Markdown Mint: Suggest
Continuation** from the Command Palette. On first use, Mint explains the
bounded text it sends and lets you select an available Copilot chat model and
authorize access. Use **Markdown Mint: Select Suggestion Model** to change it.
You can assign a shortcut to either command; Mint adds no default shortcut.

A short continuation appears in faint text at the end of a paragraph, heading,
or list item. Press **Tab** to insert it or **Esc** to dismiss it. It remains a
display-only suggestion until accepted, so it is excluded from your file,
clipboard, previews, exports, and recovery draft. Ordinary Undo/Redo applies
after acceptance. Tables, code, links, inline code, Details/Alerts, Source,
Preview, and selected text are excluded.

Automatic suggestions are initially **off**. Enable
`markdownMint.aiSuggestions.autoTrigger` in VS Code's **User Settings** to
request a continuation about one second after typing pauses. Turning it off
keeps the manual command available. The selected ID is stored in
`markdownMint.aiSuggestions.model` (initially empty). Both settings have
application scope; workspace settings cannot enable sending or select a model.
There is no automatic-suggestion toggle in the Mint toolbar.

Mint uses VS Code's public Language Model API in the extension host, with no
Mint API key, server, or required Copilot dependency. Regular editing works
when that API or a Copilot model is unavailable. Automatic requests require
confirmed model access and a trusted workspace. After a restart, access
revocation, or model-list change, run the manual command to resume; Mint never
silently chooses a replacement model.

Only bounded prose around the current document's cursor is sent: up to 4,000
UTF-16 units before, 1,000 after, and 512 for a nearby heading, reduced further
to fit the model's token budget. Mint does not collect other files, paths,
images, Git changes, or clipboard content for AI, and does not log or persist
prompts or suggestions. Requests can consume **Copilot usage** and differ
from standard Copilot inline completion. Cancellation does not guarantee zero
provider usage. Content exclusion, repository context, and custom instructions
from standard Copilot features are not guaranteed for these separate chat
requests; follow your organization's policy for sending document text.

## Markdown stays Markdown

Markdown Mint does not introduce a proprietary document format.

Your `.md` file remains the single source of truth.

Edit visually when it is convenient, then switch to **Source** whenever you want to inspect or edit the underlying Markdown directly.

Everything you create in the visual editor is still Markdown.

![markdown-stays-markdown-demo](./docs/media/markdown-stays-markdown-demo.md.gif)

## Easy to set up

You can start using Markdown Mint with any existing Markdown file.

When a Markdown file is open in the standard VS Code editor, click the **Markdown Mint** button to open it in the visual editor.

If you prefer, you can also set Markdown Mint as the default editor for Markdown files so they automatically open in Mint.

![easy-to-set-up-demo](./docs/media/easy-to-set-up-demo.gif)
