import { enhanceRenderedContent } from "./mermaidEnhancer";
import { configureMermaidRuntimeLoader } from "./mermaidValidation";

const loaderScript =
  typeof document === "undefined"
    ? undefined
    : (document.currentScript as HTMLScriptElement | null);

function runtimeSource(): string | undefined {
  const source = loaderScript?.src;
  if (!source) return undefined;
  try {
    return new URL("./mermaid.js", source).toString();
  } catch {
    return undefined;
  }
}

function scriptNonce(): string | undefined {
  const current = loaderScript?.nonce || loaderScript?.getAttribute("nonce");
  if (current) return current;
  return document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce;
}

function installNativeEnhancer(): void {
  if (typeof document === "undefined" || !document.body) return;
  const globals = globalThis as unknown as Record<string, unknown>;
  if (globals.markdownMintMermaidNativeLoader === true) return;
  globals.markdownMintMermaidNativeLoader = true;
  const src = runtimeSource();
  const nonce = scriptNonce();
  if (src)
    configureMermaidRuntimeLoader({
      src,
      ownerDocument: document,
      ...(nonce ? { nonce } : {}),
    });
  enhanceRenderedContent(document.body);
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", installNativeEnhancer, {
      once: true,
    });
  else installNativeEnhancer();
}
