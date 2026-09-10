# Browser harness

Build the webview bundle, start the fixture server, and open
`http://127.0.0.1:4173/` in Playwright or Chrome:

```sh
npm run build:webview
node tests/browser/server.mjs
```

The fixture provides a guarded mock VS Code transport. It accepts only
protocol version `1`, validates operation ids and base versions, acknowledges
accepted edits with a `document` message, and returns `edit-rejected` with the
submitted draft for stale edits. `window.__markdownWeaverHarness` exposes
captured messages and a controlled external update for browser checks.

Open `http://127.0.0.1:4173/native.html` in another tab to inspect the native
VS Code CSS baseline for the same representative blocks. Its
`window.__markdownWeaverNative.metrics()` helper reports content, heading,
task, checkbox, and typography metrics for parity checks.

The server maps `/__vscode__/markdown.css` to the installed VS Code Markdown
stylesheet before `media/document.css` is loaded. Set `VSCODE_MARKDOWN_CSS` on
another machine to the matching installed stylesheet. This makes the rich and
dedicated preview layout checks exercise the same native cascade used by VS
Code.

The webview suite covers composition start/end and defers external snapshots
without dropping local input. The browser fixture can dispatch composition DOM
events but cannot create the native IME candidate window; Japanese IME behavior
still needs one manual check in VS Code.
