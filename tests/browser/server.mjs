import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const vscodeMarkdownCss = process.env.VSCODE_MARKDOWN_CSS ?? "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/markdown-language-features/media/markdown.css";
const port = Number(process.env.MW_BROWSER_PORT ?? "4173");
const contentTypes = { ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".map": "application/json" };

function fileFor(pathname) {
  if (pathname === "/") return resolve(repository, "tests/browser/harness.html");
  if (pathname === "/native.html") return resolve(repository, "tests/browser/native.html");
  if (pathname === "/__vscode__/markdown.css") return resolve(vscodeMarkdownCss);
  const candidate = resolve(repository, `.${pathname}`);
  if (!candidate.startsWith(`${repository}${sep}`)) return null;
  return candidate;
}

const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    const filename = fileFor(pathname);
    if (!filename) {
      response.writeHead(400);
      response.end("Bad path");
      return;
    }
    const body = await readFile(filename);
    response.writeHead(200, { "content-type": contentTypes[extname(filename)] ?? "application/octet-stream", "cache-control": "no-store" });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Markdown Weaver browser harness: http://127.0.0.1:${port}/\n`);
  process.stdout.write(`Native CSS: ${vscodeMarkdownCss}\n`);
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
