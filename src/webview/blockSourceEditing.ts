import type { Node as PMNode } from "prosemirror-model";
import { isMathFenceLanguage } from "../core/math";

export interface BlockSourceEditor {
  kind: "math" | "mermaid";
  body: string;
  replace(body: string): string;
}

/** Keep rendered Math/Mermaid wrappers and terminal whitespace outside the draft. */
export function blockSourceEditor(node: PMNode): BlockSourceEditor | null {
  const source = String(node.attrs.source ?? "");
  if (node.type.name === "raw_inline") {
    if (String(node.attrs.kind ?? "").toLowerCase() !== "math_inline")
      return null;
    const dollars = source.match(/^\$(?!\$)([\s\S]*?)\$(?!\$)$/);
    if (!dollars) return null;
    return {
      kind: "math",
      body: dollars[1]!,
      replace: (body) => `$${body}$`,
    };
  }
  if (node.type.name !== "raw_block") return null;
  const fence = source.match(/^( {0,3})(`{3,}|~{3,})([^\r\n]*)(\r\n|\n|\r)/);
  if (fence) {
    const info = fence[3]!;
    const language = info.trim().split(/\s/)[0]!.toLowerCase();
    const kind = isMathFenceLanguage(info)
      ? "math"
      : language === "mermaid"
        ? "mermaid"
        : null;
    if (!kind) return null;
    const marker = fence[2]!;
    const closing = new RegExp(
      "(?:\\r\\n|\\n|\\r)( {0,3}" +
        marker[0] +
        "{" +
        marker.length +
        ",}[ \\t]*)([\\r\\n]*)$",
    ).exec(source);
    if (!closing || closing.index < fence[0].length - fence[4]!.length)
      return null;
    return {
      kind,
      body: source
        .slice(fence[0].length, Math.max(fence[0].length, closing.index))
        .replace(/\r\n|\r/g, "\n"),
      replace: (body) => {
        const longest = Math.max(
          0,
          ...Array.from(
            body.matchAll(new RegExp(marker[0] + "+", "g")),
            (match) => match[0].length,
          ),
        );
        const safeMarker = marker[0]!.repeat(
          Math.max(marker.length, closing[1]!.trim().length, longest + 1),
        );
        return (
          fence[1] +
          safeMarker +
          fence[3] +
          fence[4] +
          body.replace(/\r\n|\r|\n/g, fence[4]!) +
          fence[4] +
          closing[1]!.replace(new RegExp(marker[0] + "+"), safeMarker) +
          closing[2]
        );
      },
    };
  }
  if (String(node.attrs.kind) !== "math-block") return null;
  const dollars = source.match(
    /^([ \t]{0,3}\$\$[ \t]*(?:\r\n|\n|\r)?)([\s\S]*?)((?:\r\n|\n|\r)?[ \t]*\$\$[\s]*)$/,
  );
  if (!dollars) return null;
  return {
    kind: "math",
    body: dollars[2]!.replace(/\r\n|\r/g, "\n"),
    replace: (body) =>
      dollars[1] +
      body.replace(/\r\n|\r|\n/g, source.match(/\r\n|\n|\r/)?.[0] ?? "\n") +
      dollars[3],
  };
}
