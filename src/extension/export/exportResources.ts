import * as path from "node:path";
import * as vscode from "vscode";

const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  ".apng": "image/apng",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".webp": "image/webp",
};

const FONT_MIME_TYPES: Readonly<Record<string, string>> = {
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const IMAGE_TAG = /<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const SRC_ATTRIBUTE = /(\s+src\s*=\s*)("([^"]*)"|'([^']*)'|[^\s"'=<>`]+)/i;

function decodeHtmlAttribute(value: string): string {
  return value.replace(
    /&(#(?:x[\da-f]+|\d+)|amp|quot|apos|lt|gt);/gi,
    (entity, name: string) => {
      if (name[0] === "#") {
        const hexadecimal = name[1]?.toLowerCase() === "x";
        const codePoint = Number.parseInt(
          name.slice(hexadecimal ? 2 : 1),
          hexadecimal ? 16 : 10,
        );
        return Number.isFinite(codePoint) &&
          codePoint >= 0 &&
          codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : entity;
      }
      switch (name.toLowerCase()) {
        case "amp":
          return "&";
        case "quot":
          return '"';
        case "apos":
          return "'";
        case "lt":
          return "<";
        case "gt":
          return ">";
        default:
          return entity;
      }
    },
  );
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function mimeTypeForImage(uri: vscode.Uri): string | undefined {
  return IMAGE_MIME_TYPES[path.posix.extname(uri.path).toLowerCase()];
}

function isSafeDataImage(source: string): boolean {
  return /^data:image\/(?:apng|avif|bmp|gif|jpeg|png|svg\+xml|tiff?|webp|x-icon)(?:;[^,]*)?,/i.test(
    source,
  );
}

function isSafeHttpsImage(source: string): boolean {
  try {
    const parsed = new URL(source);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname.length > 0 &&
      parsed.username.length === 0 &&
      parsed.password.length === 0
    );
  } catch {
    return false;
  }
}

function imageSource(tag: string): string | undefined {
  const attribute = SRC_ATTRIBUTE.exec(tag);
  if (!attribute) return undefined;
  const value = attribute[3] ?? attribute[4] ?? attribute[5];
  return typeof value === "string" ? decodeHtmlAttribute(value) : undefined;
}

function replaceImageSource(tag: string, source: string | undefined): string {
  const attribute = SRC_ATTRIBUTE.exec(tag);
  if (!attribute) return tag;
  const valueStart = attribute.index;
  const valueEnd = valueStart + attribute[0].length;
  if (source === undefined)
    return tag.slice(0, valueStart) + tag.slice(valueEnd);
  return (
    tag.slice(0, valueStart) +
    attribute[1] +
    `"${escapeHtmlAttribute(source)}"` +
    tag.slice(valueEnd)
  );
}

async function readImageAsDataUri(
  uri: vscode.Uri,
): Promise<string | undefined> {
  const mimeType = mimeTypeForImage(uri);
  if (!mimeType) return undefined;
  const bytes = await vscode.workspace.fs.readFile(uri);
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

async function localImageUri(
  source: string,
  documentUri: vscode.Uri,
): Promise<vscode.Uri | undefined> {
  if (/^file:/i.test(source)) {
    try {
      const uri = vscode.Uri.parse(source);
      return uri.scheme === "file" && uri.path.startsWith("/")
        ? uri.with({ query: "", fragment: "" })
        : undefined;
    } catch {
      return undefined;
    }
  }

  if (
    !source ||
    source.startsWith("/") ||
    source.startsWith("\\") ||
    source.startsWith("//") ||
    /^[a-z][a-z\d+.-]*:/i.test(source)
  )
    return undefined;

  const pathAndSuffix = source.split(/[?#]/, 1)[0];
  if (!pathAndSuffix) return undefined;
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathAndSuffix);
  } catch {
    return undefined;
  }
  const directory = documentUri.with({
    path: path.posix.dirname(documentUri.path),
    query: "",
    fragment: "",
  });
  return vscode.Uri.joinPath(
    directory,
    ...decodedPath.replace(/\\/g, "/").split("/"),
  );
}

async function resolveImageSource(
  source: string,
  documentUri: vscode.Uri,
): Promise<string | undefined> {
  if (isSafeDataImage(source) || isSafeHttpsImage(source)) return source;
  const uri = await localImageUri(source, documentUri);
  if (!uri) return undefined;
  try {
    return (await readImageAsDataUri(uri)) ?? source;
  } catch {
    // Keep an unreadable local URL intact so the export can still be produced.
    return source;
  }
}

/** Embed Markdown image references without introducing Webview-only URLs. */
export async function embedMarkdownImages(
  html: string,
  documentUri: vscode.Uri,
): Promise<string> {
  const tags = Array.from(html.matchAll(IMAGE_TAG));
  if (tags.length === 0) return html;
  let result = "";
  let cursor = 0;
  for (const match of tags) {
    const tag = match[0];
    const start = match.index ?? cursor;
    result += html.slice(cursor, start);
    const source = imageSource(tag);
    if (source === undefined) {
      result += tag;
    } else {
      const resolved = await resolveImageSource(source, documentUri);
      result += replaceImageSource(tag, resolved);
    }
    cursor = start + tag.length;
  }
  return result + html.slice(cursor);
}

async function readText(uri: vscode.Uri): Promise<string> {
  return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

async function inlineKatexFonts(
  css: string,
  extensionUri: vscode.Uri,
): Promise<string> {
  const fontCache = new Map<string, PromiseLike<string>>();
  const urls = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^)'"\s]+))\s*\)/gi;
  const matches = Array.from(css.matchAll(urls));
  let result = "";
  let cursor = 0;
  for (const match of matches) {
    const reference = match[1] ?? match[2] ?? match[3] ?? "";
    result += css.slice(cursor, match.index ?? cursor);
    if (/^data:/i.test(reference)) {
      result += match[0];
    } else {
      const relative = reference.replace(/^\.\//, "");
      if (!relative.startsWith("fonts/") || relative.includes(".."))
        throw new Error(
          "The bundled KaTeX stylesheet contains an unsupported font URL.",
        );
      const filename = relative.slice("fonts/".length);
      const extension = path.posix.extname(filename).toLowerCase();
      const mimeType = FONT_MIME_TYPES[extension];
      if (!mimeType || filename.includes("/"))
        throw new Error(
          "The bundled KaTeX stylesheet references an unsupported font.",
        );
      let dataUri = fontCache.get(filename);
      if (!dataUri) {
        dataUri = vscode.workspace.fs
          .readFile(
            vscode.Uri.joinPath(
              extensionUri,
              "dist",
              "katex",
              "fonts",
              filename,
            ),
          )
          .then(
            (bytes) =>
              `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
          );
        fontCache.set(filename, dataUri);
      }
      result += `url("${await dataUri}")`;
    }
    cursor = (match.index ?? cursor) + match[0].length;
  }
  return result + css.slice(cursor);
}

/** Return all CSS needed by the standalone document, with KaTeX fonts inlined. */
export async function loadExportStylesheet(
  extensionUri: vscode.Uri,
): Promise<string> {
  const [documentCss, exportCss, katexCss] = await Promise.all([
    readText(vscode.Uri.joinPath(extensionUri, "media", "document.css")),
    readText(vscode.Uri.joinPath(extensionUri, "media", "export.css")),
    readText(vscode.Uri.joinPath(extensionUri, "dist", "katex", "katex.css")),
  ]);
  return [
    documentCss,
    await inlineKatexFonts(katexCss, extensionUri),
    exportCss,
  ]
    .join("\n")
    .replace(/<\/style/gi, "<\\/style");
}

/** Load the already-bundled Mermaid runtime and strip its optional source map. */
export async function loadExportMermaidRuntime(
  extensionUri: vscode.Uri,
): Promise<string> {
  return (
    await readText(vscode.Uri.joinPath(extensionUri, "dist", "mermaid.js"))
  )
    .replace(/^\s*\/\/[#@]\s*sourceMappingURL=.*$/gm, "")
    .replace(/<\/script/gi, "<\\/script")
    .trim();
}
