import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import katex from "katex";
import { build } from "esbuild";

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

const documentFixtures = new Map([
  ["common-test.md", "commonmark"],
  ["github-test.md", "github"],
  ["github-test-class-B.md", "github"],
  ["gitlab-test.md", "gitlab"],
  ["gitlab-test-class-B.md", "gitlab"],
]);
let nativeRenderer;

async function renderDocumentFixture(filename) {
  const profile = documentFixtures.get(filename);
  if (!profile) throw new Error("Unknown document fixture");
  // The native extension contribution uses this same safe core renderer.
  // Bundle lazily so existing static spacing fixtures retain their fast start.
  if (!nativeRenderer) {
    const outfile = resolve(repository, "output/playwright/native-core.cjs");
    nativeRenderer = build({
      entryPoints: [resolve(repository, "src/core/index.ts")],
      outfile,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node18",
      legalComments: "none",
      loader: { ".svg": "text" },
    }).then(() => import(pathToFileURL(outfile).href));
  }
  const core = await nativeRenderer;
  const source = await readFile(
    resolve(repository, "tests", "md", filename),
    "utf8",
  );
  return core.renderMarkdown(source, profile);
}

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

function nativeCodeBlock(source = "const value = 1;", language = "ts") {
  return `<div class="mm-code-block" data-mm-code-language="TypeScript"><div class="mm-code-block-header"><div class="mm-code-language-control" role="img" aria-label="Code language: TypeScript"><span class="mm-code-language-label">TypeScript</span></div><div class="mm-code-block-actions"></div></div><div class="mm-code-block-body"><pre class="mm-code-block-pre"><code class="language-${escapeHtml(language)}">${escapeHtml(source)}</code></pre></div></div>`;
}

const nativeTable =
  "<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>";

const nativeSpacingBlocks = {
  alert:
    '<div class="markdown-alert markdown-alert-note"><p class="markdown-alert-title">Note</p><p>Alert body.</p></div>',
  code: nativeCodeBlock(),
  paragraph: "<p>Paragraph body.</p>",
  "materialized-blank": "<p>one</p><p><br></p><p>two</p>",
  table: nativeTable,
  toc: '<nav class="table-of-contents" aria-label="Table of contents"><ul><li><a href="#heading">Heading</a></li></ul></nav>',
  description: "<dl><dt>Term</dt><dd>Definition</dd></dl><p>After</p>",
  math: renderNativeMath("x^2", true),
  visual:
    '<div class="mm-static-asset mm-static-geojson"><p class="mm-asset-status">Static GEOJSON preview (offline).</p><pre class="mm-diagram-source">{\n  "type": "Point",\n  "coordinates": [0, 0]\n}</pre></div>',
  fallback:
    '<pre data-markdown-raw="true" data-kind="directive">:::custom\nbody\n:::</pre>',
  fallbackAfter:
    '<pre data-markdown-raw="true" data-kind="directive">:::custom\nbody\n:::</pre><p>After fallback.</p>',
  image: '<p><img src="https://example.com/pixel.png" alt="pixel"></p>',
  list: "<ul><li><p>one</p></li><li><p>two</p></li></ul>",
  ordered: "<ol><li><p>one</p></li><li><p>two</p></li></ol>",
  task: '<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" disabled><p>one</p></li><li class="task-list-item"><input type="checkbox" checked disabled><p>two</p></li></ul>',
  quote: "<blockquote><p>Quoted body.</p></blockquote>",
  heading: '<h1 id="heading">Heading</h1>',
  inlineMath: `<p>Inline: ${renderNativeMath("E = mc^2", false)} text.</p>`,
  detailsParagraph:
    "<details open><summary>Details</summary><p>Body paragraph.</p></details>",
  detailsCode:
    "<details open><summary>Details</summary>" +
    nativeCodeBlock() +
    "</details>",
  detailsTable:
    "<details open><summary>Details</summary>" + nativeTable + "</details>",
  detailsNested:
    "<details open><summary>Outer</summary><p>Outer paragraph.</p><details open><summary>Inner</summary><p>Inner paragraph.</p></details></details>",
};

const nativeSpacingCases = {
  "alert-code": ["alert", "code"],
  "code-alert": ["code", "alert"],
  "alert-paragraph": ["alert", "paragraph"],
  "paragraph-alert": ["paragraph", "alert"],
  "alert-table": ["alert", "table"],
  "table-alert": ["table", "alert"],
  "alert-alert": ["alert", "alert"],
  "alert-comment-alert": ["alert", "comment", "alert"],
  "toc-code": ["heading", "toc", "code"],
  "code-toc": ["heading", "code", "toc"],
  "toc-paragraph": ["heading", "toc", "paragraph"],
  "paragraph-toc": ["heading", "paragraph", "toc"],
  "toc-table": ["heading", "toc", "table"],
  "table-toc": ["heading", "table", "toc"],
  "code-code": ["code", "code"],
  "details-code": ["detailsParagraph", "code"],
  "math-code": ["math", "code"],
  "visual-code": ["visual", "code"],
  "table-code": ["table", "code"],
  "fallback-paragraph": ["fallbackAfter"],
  "image-code": ["image", "code"],
  "details-paragraph": ["detailsParagraph"],
  "details-code-terminal": ["detailsCode"],
  "details-table-terminal": ["detailsTable"],
  "details-nested-terminal": ["detailsNested"],
  description: ["description"],
  math: ["math"],
  visual: ["visual"],
  fallback: ["fallback"],
  list: ["list"],
  ordered: ["ordered"],
  task: ["task"],
  quote: ["quote"],
  "inline-math": ["inlineMath"],
  "comment-first": ["comment", "paragraph"],
  "comment-last": ["paragraph", "comment"],
  "empty-toc": ["comment"],
  "materialized-blank": ["materialized-blank"],
};

function nativeSpacingFixture(name) {
  const names = nativeSpacingCases[name] ?? [name];
  return names
    .map((blockName) =>
      blockName === "comment"
        ? "<!-- markdown-mint-spacing-comment -->"
        : (nativeSpacingBlocks[blockName] ?? ""),
    )
    .filter(Boolean)
    .join("\n");
}

function fileFor(pathname) {
  if (pathname === "/")
    return resolve(repository, "tests/browser/harness.html");
  if (
    pathname === "/dist/webview.js" &&
    process.env.MM_EDITOR_PERFORMANCE_BENCHMARK === "1"
  )
    return resolve(repository, "output/benchmark/webview.js");
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
        pathname === "/" &&
        requestUrl.searchParams.get("experimentalFixedLayout") === "1"
      )
        html = html.replace(
          "</head>",
          '  <link rel="stylesheet" href="/tests/browser/fixtures/fixed-table-layout.css">\n</head>',
        );
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
      if (
        pathname === "/native.html" &&
        requestUrl.searchParams.get("fixture") === "spacing"
      ) {
        const spacing = nativeSpacingFixture(
          requestUrl.searchParams.get("case") ?? "alert-code",
        );
        html = html.replace(
          /<main class="markdown-body" data-testid="native-content">[\s\S]*?<\/main>/,
          `<main class="markdown-body" data-testid="native-content">${spacing}</main>`,
        );
      }
      if (
        pathname === "/native.html" &&
        requestUrl.searchParams.get("fixture") === "document"
      ) {
        const rendered = await renderDocumentFixture(
          requestUrl.searchParams.get("file"),
        );
        html = html.replace(
          /<main class="markdown-body" data-testid="native-content">[\s\S]*?<\/main>/,
          () =>
            `<main class="markdown-body" data-testid="native-content">${rendered}</main>`,
        );
      }
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
