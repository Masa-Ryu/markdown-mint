**English** | [简体中文](docs/i18n/README.zh-CN.md) | [繁體中文](docs/i18n/README.zh-TW.md) | [Español](docs/i18n/README.es.md) | [Français](docs/i18n/README.fr.md) | [Português (Brasil)](docs/i18n/README.pt-BR.md) | [Русский](docs/i18n/README.ru.md) | [Deutsch](docs/i18n/README.de.md) | [日本語](docs/i18n/README.ja.md) | [Türkçe](docs/i18n/README.tr.md) | [한국어](docs/i18n/README.ko.md) | [Italiano](docs/i18n/README.it.md) | [Polski](docs/i18n/README.pl.md) | [Čeština](docs/i18n/README.cs.md)

# Markdown Mint

## **Write visually. Stay in Markdown.**

A visual WYSIWYG Markdown editor for VS Code.

Edit text, tables, checklists, and technical documentation directly in a visual editor—then switch to the Markdown source whenever you need precise control.

No migration required. Just open the Markdown files you already have and start writing.

![Markdown Mint promo demo](docs/media/overview.gif)

### Markdown Mint for VS Code

**Paste table data. Reorder columns visually. Keep ordinary Markdown.**

[Install Markdown Mint from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=masa-ryu.markdown-mint)

This short demo runs in a browser harness. Its fixed TSV preview feeds Markdown Mint's production paste handler; the Source textarea is a harness fallback. In VS Code, **Source** opens the standard Markdown editor.

## Focus on writing

Markdown Mint is designed to keep formatting out of your way so you can focus on the content.

Use **slash commands** `/` to quickly insert blocks and elements without reaching for Markdown syntax\.

Select text to bring up a contextual toolbar with the formatting options you need, right where you need them.

Keyboard navigation is built in too. Use the **Tab key** to move through selectable elements and keep your hands on the keyboard.

Working with tables is just as simple. Copy and paste table content directly without manually editing Markdown syntax.

![focus-on-writing-demo](https://raw.githubusercontent.com/Masa-Ryu/markdown-mint/main/docs/media/focus-on-writing-demo.gif)

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

![platform-specific-demo](https://raw.githubusercontent.com/Masa-Ryu/markdown-mint/main/docs/media/platform-specific-demo.gif)

## More built-in features

Markdown Mint includes additional tools for working with real-world Markdown documents:

✅Add automatic numbering to tables\.

✅Copy cells from Excel or Google Sheets and paste them directly into a Markdown table\.

✅Drag and drop images from outside VS Code to insert them into your document\.

✅Quickly create image references, URLs, and internal links with automatic suggestions and search\.

✅Export Markdown as standalone HTML or A4 PDF from the current document\.

## Markdown stays Markdown

Markdown Mint does not introduce a proprietary document format.

Your `.md` file remains the single source of truth.

Edit visually when it is convenient, then switch to **Source** whenever you want to inspect or edit the underlying Markdown directly.

Everything you create in the visual editor is still Markdown.

![markdown-stays-markdown-demo](https://raw.githubusercontent.com/Masa-Ryu/markdown-mint/main/docs/media/markdown-stays-markdown-demo.md.gif)

## Easy to set up

You can start using Markdown Mint with any existing Markdown file.

When a Markdown file is open in the standard VS Code editor, click the **Markdown Mint** button to open it in the visual editor.

If you prefer, you can also set Markdown Mint as the default editor for Markdown files so they automatically open in Mint.

![easy-to-set-up-demo](https://raw.githubusercontent.com/Masa-Ryu/markdown-mint/main/docs/media/easy-to-set-up-demo.gif)
