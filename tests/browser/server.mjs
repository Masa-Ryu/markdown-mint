import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import katex from "katex";

const repository = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const vscodeMarkdownCss =
  process.env.VSCODE_MARKDOWN_CSS ??
  "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/markdown-language-features/media/markdown.css";
const port = Number(process.env.MM_BROWSER_PORT ?? "4173");
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};
const browserContentSecurityPolicy =
  "default-src 'none'; img-src 'self' https: data:; style-src 'self'; style-src-elem 'self'; style-src-attr 'unsafe-inline'; font-src 'self' data:; script-src 'self' 'nonce-mm-test-nonce'; connect-src 'none'";

const nativeMermaidSources = [
  [
    "flowchart LR",
    "    A[Markdown Source] --> B[Rich Editor]",
    "    B --> C[Preview]",
    "    C --> D{Looks identical?}",
    "    D -- Yes --> E[Save]",
    "    D -- No --> B",
    "    E --> F[GitHub / GitLab]",
  ].join("\n"),
  [
    "sequenceDiagram",
    "    participant U as User",
    "    participant E as Editor",
    "    participant M as Markdown",
    "    participant P as Preview",
    "    U->>E: Edit",
    "    E->>M: Update",
    "    M->>P: Render",
    "    P-->>U: Preview",
  ].join("\n"),
];

function escapeHtml(value) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
}

function nativeMermaidPlaceholder(source) {
  const escaped = escapeHtml(source);
  return `<div class="mm-diagram mm-mermaid" data-mm-mermaid="true" data-mermaid-source="${escaped}" data-mm-mermaid-state="pending"><p class="mm-diagram-status">Rendering Mermaid diagram...</p><pre class="mm-diagram-source">${escaped}</pre></div>`;
}

const nativeMermaidFixture = nativeMermaidSources
  .map(nativeMermaidPlaceholder)
  .join("\n");

function renderNativeMath(source, display) {
  const tag = display ? "div" : "span";
  const className = display
    ? "mm-math mm-math-block"
    : "mm-math mm-math-inline";
  const rendered = katex.renderToString(source, {
    displayMode: display,
    output: "htmlAndMathml",
    throwOnError: false,
    strict: "ignore",
    trust: false,
  });
  return `<${tag} class="${className}" data-mm-math-display="${display}">${rendered}</${tag}>`;
}

const nativeMathFixture = [
  '<section class="mm-native-math-fixture" data-testid="native-math">',
  "<h2>Math browser fixture</h2>",
  `<p>Inline: ${renderNativeMath("E = mc^2", false)}</p>`,
  `<p>${renderNativeMath(String.raw`\frac{-b \pm \sqrt{b^2 - 4ac}}{2a}`, false)}</p>`,
  renderNativeMath(
    String.raw`\sum_{n=1}^{100}
\frac{1}{n^2}
=
\frac{\pi^2}{6}`,
    true,
  ),
  renderNativeMath(
    String.raw`A =
\begin{bmatrix}
1 & 2 & 3 \\
4 & 5 & 6 \\
7 & 8 & 9
\end{bmatrix}`,
    true,
  ),
  "</section>",
].join("\n");

function fileFor(pathname) {
  if (pathname === "/")
    return resolve(repository, "tests/browser/harness.html");
  if (pathname === "/native.html")
    return resolve(repository, "tests/browser/native.html");
  if (pathname === "/__vscode__/markdown.css")
    return resolve(vscodeMarkdownCss);
  const candidate = resolve(repository, `.${pathname}`);
  if (!candidate.startsWith(`${repository}${sep}`)) return null;
  return candidate;
}

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    const pathname = decodeURIComponent(requestUrl.pathname);
    const filename = fileFor(pathname);
    if (!filename) {
      response.writeHead(400);
      response.end("Bad path");
      return;
    }
    const extension = extname(filename);
    let body = await readFile(filename);
    if (extension === ".html") {
      let html = body.toString("utf8");
      if (
        pathname === "/native.html" &&
        requestUrl.searchParams.get("fixture") === "math"
      )
        html = html.replace(
          "<!-- markdown-mint-math-fixture -->",
          nativeMathFixture,
        );
      if (
        pathname === "/native.html" &&
        requestUrl.searchParams.get("fixture") === "mermaid"
      )
        html = html.replace(
          "<!-- markdown-mint-mermaid-fixture -->",
          nativeMermaidFixture,
        );
      body = Buffer.from(html, "utf8");
    }
    response.writeHead(200, {
      "content-type": contentTypes[extension] ?? "application/octet-stream",
      "cache-control": "no-store",
      ...(extension === ".html"
        ? { "content-security-policy": browserContentSecurityPolicy }
        : {}),
    });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(
    `Markdown Mint browser harness: http://127.0.0.1:${port}/\n`,
  );
  process.stdout.write(`Native CSS: ${vscodeMarkdownCss}\n`);
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
