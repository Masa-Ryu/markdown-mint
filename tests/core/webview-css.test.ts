import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const webviewCss = readFileSync(
  resolve(process.cwd(), "media/webview.css"),
  "utf8",
);

describe("Mermaid dialog styles", () => {
  it("scopes the large editor-first layout to Mermaid only", () => {
    expect(webviewCss).toContain(
      '.mm-input-dialog.mm-profile-feature-dialog[data-profile-feature="mermaid"]',
    );
    expect(webviewCss).toContain("width: min(960px, calc(100vw - 32px));");
    expect(webviewCss).toContain("height: min(760px, calc(100dvh - 32px));");
    expect(webviewCss).toContain(
      "grid-template-rows: auto minmax(0, 1fr) auto;",
    );
    expect(webviewCss).toContain("flex: 1 1 auto;");
    expect(webviewCss).toContain(
      "font-family: var(--vscode-editor-font-family, monospace);",
    );
    expect(webviewCss).toContain('[data-feature-field-container="body"]');
    expect(webviewCss).toContain("> span {\n  display: none;");
  });

  it("gives shared link and image dialogs room for file candidates", () => {
    expect(webviewCss).toContain(
      ".mm-input-dialog.mm-link-dialog,\n.mm-input-dialog.mm-image-dialog {\n  width: min(700px, calc(100vw - 48px));",
    );
    expect(webviewCss).toContain("max-width: calc(100vw - 48px);");
    expect(webviewCss).toContain("max-height: calc(100dvh - 24px);");
    expect(webviewCss).toContain(".mm-link-picker {\n  position: fixed;");
    expect(webviewCss).toContain("width: min(560px, calc(100vw - 32px));");
    expect(webviewCss).toContain("position: static;");
    expect(webviewCss).toContain("height: clamp(96px, 42vh, 320px);");
    expect(webviewCss).toContain("max-height: min(48vh, 320px);");
    expect(webviewCss).toContain("overflow-y: auto;");
    expect(webviewCss).toContain(
      ".mm-file-autocomplete {\n  position: static;",
    );
    expect(webviewCss).toContain("  border: 0;\n  border-radius: 0;");
    expect(webviewCss).toContain("  background: transparent;\n}");
    expect(webviewCss).toContain("  box-shadow: inset 2px 0 0");
    expect(webviewCss).not.toContain(".mm-file-autocomplete-option:hover");
    expect(webviewCss).not.toContain(
      ".mm-file-autocomplete-option:not(.is-active):hover",
    );
  });
});
