import mermaid from "mermaid";
import { enhanceRenderedContent, type MermaidRuntime } from "./mermaidEnhancer";

declare const __MERMAID_VERSION__: string;

function installRuntime(): void {
  if (typeof globalThis === "undefined") return;
  const runtime = mermaid as unknown as MermaidRuntime;
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.markdownMintMermaid = runtime;
  globals.markdownMintMermaidVersion = __MERMAID_VERSION__;
  const ownerDocument = typeof document === "undefined" ? undefined : document;
  if (!ownerDocument) return;
  if (!ownerDocument.body.dataset.markdownMintMode)
    enhanceRenderedContent(ownerDocument.body);
  ownerDocument.defaultView?.dispatchEvent(
    new CustomEvent("markdown-mint-mermaid-ready"),
  );
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", installRuntime, {
      once: true,
    });
  else installRuntime();
}
