import * as vscode from "vscode";
import { MAX_RESOURCE_URL_LENGTH } from "../shared/protocol";

const EXTERNAL_LINK_SCHEMES = new Set(["http", "https", "mailto", "tel"]);
const LINK_SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):/i;

export interface LinkReferenceParts {
  readonly path: string;
  readonly query: string;
  readonly fragment: string | undefined;
}

export type LinkNavigation =
  | { readonly kind: "external"; readonly uri: vscode.Uri }
  | { readonly kind: "internal"; readonly uri: vscode.Uri }
  | { readonly kind: "fragment" }
  | {
      readonly kind: "invalid";
      readonly reason:
        | "empty"
        | "too-large"
        | "control-character"
        | "unsupported-scheme"
        | "network-path"
        | "workspace-required"
        | "path-required"
        | "malformed";
    };

/** Split a Markdown link destination without resolving it against a Webview URL. */
export function splitLinkReference(href: string): LinkReferenceParts {
  const hash = href.indexOf("#");
  const beforeFragment = hash < 0 ? href : href.slice(0, hash);
  const fragment = hash < 0 ? undefined : href.slice(hash + 1);
  const query = beforeFragment.indexOf("?");
  return {
    path: query < 0 ? beforeFragment : beforeFragment.slice(0, query),
    query: query < 0 ? "" : beforeFragment.slice(query + 1),
    fragment,
  };
}

/**
 * Classify a raw Rich Editor href before any VS Code side effect is attempted.
 * Relative paths are resolved with Uri APIs so remote and virtual workspaces
 * retain their original URI authority and scheme.
 */
export function classifyLinkNavigation(
  href: string,
  documentUri: vscode.Uri,
  workspaceFolder: vscode.WorkspaceFolder | undefined,
): LinkNavigation {
  if (href.length === 0) return { kind: "invalid", reason: "empty" };
  if (href.length > MAX_RESOURCE_URL_LENGTH)
    return { kind: "invalid", reason: "too-large" };
  if (hasControlCharacter(href))
    return { kind: "invalid", reason: "control-character" };

  const scheme = href.match(LINK_SCHEME_PATTERN)?.[1]?.toLowerCase();
  if (scheme) {
    if (!EXTERNAL_LINK_SCHEMES.has(scheme))
      return { kind: "invalid", reason: "unsupported-scheme" };
    try {
      const uri = vscode.Uri.parse(href);
      return EXTERNAL_LINK_SCHEMES.has(uri.scheme.toLowerCase())
        ? { kind: "external", uri }
        : { kind: "invalid", reason: "unsupported-scheme" };
    } catch {
      return { kind: "invalid", reason: "malformed" };
    }
  }

  // A protocol-relative destination would otherwise become a local path while
  // looking like a network URL. Only the four explicit external schemes above
  // are allowed to leave VS Code.
  if (href.startsWith("//")) return { kind: "invalid", reason: "network-path" };

  const reference = splitLinkReference(href);
  if (!reference.path)
    return reference.fragment !== undefined
      ? { kind: "fragment" }
      : { kind: "invalid", reason: "path-required" };

  const base = reference.path.startsWith("/")
    ? workspaceFolder?.uri
    : documentDirectoryUri(documentUri);
  if (!base) return { kind: "invalid", reason: "workspace-required" };

  try {
    const pathSegments = reference.path.split("/").filter(Boolean);
    if (pathSegments.length === 0)
      return { kind: "invalid", reason: "path-required" };
    const uri = vscode.Uri.joinPath(base, ...pathSegments).with({
      query: reference.query,
      fragment: "",
    });
    return { kind: "internal", uri };
  } catch {
    return { kind: "invalid", reason: "malformed" };
  }
}

function documentDirectoryUri(documentUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(
    documentUri.with({ query: "", fragment: "" }),
    "..",
  );
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
