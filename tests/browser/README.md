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
submitted draft for stale edits. `window.__markdownMintHarness` exposes
captured messages and a controlled external update for browser checks.

Open `http://127.0.0.1:4173/native.html` in another tab to inspect the native
VS Code CSS baseline for the same representative blocks. Its
`window.__markdownMintNative.metrics()` helper reports content, heading,
task, checkbox, and typography metrics for parity checks.

Use `http://127.0.0.1:4173/?fixture=math` for the multiline display and matrix
fixture. Both browser pages are served with a nonce-protected script policy and
the same `style-src-attr` allowance as the production Webview so KaTeX's
generated layout attributes are exercised under CSP.

Use `http://127.0.0.1:4173/?fixture=math&mode=preview` to show the dedicated
preview panel instead of the editable surface.

Open `http://127.0.0.1:4173/native.html?fixture=math` to run the same equations
through the native preview cascade. The server generates the KaTeX markup with
`trust: false`, so the rich editor, dedicated preview, and native preview can
be compared at the same viewport and font settings.
The native fixture supplies a small dark-theme variable sheet because a standalone
browser tab does not receive VS Code's injected `--vscode-*` theme variables.

The server maps `/__vscode__/markdown.css` to the installed VS Code Markdown
stylesheet before `media/document.css` is loaded. Set `VSCODE_MARKDOWN_CSS` on
another machine to the matching installed stylesheet. This makes the rich and
dedicated preview layout checks exercise the same native cascade used by VS
Code.

The webview suite covers composition start/end and defers external snapshots
without dropping local input. The browser fixture can dispatch composition DOM
events but cannot create the native IME candidate window; Japanese IME behavior
still needs one manual check in VS Code.
