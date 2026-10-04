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

In GitHub and GitLab modes, choose from 13 Mermaid templates by their finished
diagram, then select **Next: Edit code** to edit the candidate beside a live
preview. A new diagram without selected code opens the template picker first;
**← Templates** returns from the code editor to the picker. Existing diagrams
and selected code open directly in the code editor. Replacing the current code
requires confirmation; only **Insert diagram** or **Update diagram** changes
your Markdown.

Pressing **Escape** follows the dialog's Cancel behavior: a clean draft closes,
while an edited draft asks before discarding it. During IME composition, Escape
cancels the composition first.

![platform-specific-demo](./docs/media/platform-specific-demo.gif)

## More built-in features

Markdown Mint includes additional tools for working with real-world Markdown documents:

✅Add automatic numbering to tables\.

✅Copy cells from Excel or Google Sheets and paste them directly into a Markdown table\.

✅Drag and drop images from outside VS Code to insert them into your document\.

✅Quickly create image references, URLs, and internal links with automatic suggestions and search\.

✅Export Markdown as standalone HTML or A4 PDF from the current document\.

## Copilot prose suggestions

Markdown Mint uses VS Code's public Language Model API to request short prose
continuations from an available GitHub Copilot model. It selects a model for
editor use from the models VS Code exposes, preferring an available `mini`
family and otherwise using a stable model-ID order. The model name and ID are
shown in the suggestion status hover. The feature runs only in a trusted local
desktop Extension Host on macOS, Windows, or Linux; unsupported hosts keep
ordinary Markdown editing available.
The Language Model API became available in VS Code Stable in 1.91; on 1.90,
Mint's ordinary editing remains supported while AI suggestions report the API
as unavailable.

Run **Markdown Mint: Suggest Continuation** from the Command Palette or the
Mint status item to make the first model request and complete any VS Code
consent flow. After that setup succeeds, type normally to see suggestions when
`markdownMint.aiSuggestions.autoTrigger` is enabled, or continue using the
manual command. The setting is user-scoped, initially **false**, and has no
toolbar toggle. Manual suggestions remain available while automatic
suggestions are off. After an Extension Host restart, Mint waits for a real
text edit and its normal 300 ms debounce before it uses the public model
selection API to reacquire a model. The saved setup marker is not permission:
Mint checks `canSendRequest(model)` before every request, and a denied or
unknown result stops automatic requests. No model is selected at activation or
because a setting changed. If a public access-change event later confirms the
cached model is permitted, the next real input starts a fresh request from the
current text; an old request or candidate is never revived. This restart path
is covered with fake-model tests but remains unverified in a real
VS Code/Copilot session. Requests may consume **Copilot usage**.

Suggestions can appear between existing words or at the end of ordinary prose,
headings, and list items, including a contextually empty paragraph. The host
sends only bounded context from the active unsaved Markdown snapshot: the
current paragraph around the cursor, its heading, and nearby prose where
available. It does not send other files, terminal output, clipboard contents,
or Git changes. Link destinations, inline-code contents, tables, code blocks,
Mermaid, math, raw HTML editor regions, selected text, Source, Preview, and
modal fields are not completion targets. Document text is sent to the selected
model through VS Code's Language Model API; Mint does not claim that Copilot's
content exclusions apply identically to arbitrary prompts or that cancellation
means no usage was consumed. Mint does not log or persist document text or
completion contents.

The candidate is transient until **Tab** accepts it; **Esc** dismisses it.
The insertion is shown only if Markdown source mapping confirms that existing
text and structure remain unchanged. Display alone does not change Markdown,
dirty/recovery state, clipboard, preview/export, or Undo history. Acceptance
uses the normal editor transaction and native Undo/Redo boundary.

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
