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

  it("leaves the shared dialog size as the compact default", () => {
    expect(webviewCss).toContain(".mm-input-dialog {\n  width: min(380px");
  });
});

describe("table delete styles", () => {
  it("shares destructive styling across row, column, and table actions", () => {
    const destructiveGroup =
      '.mm-table-toolbar-button[data-action="row-delete"],\n' +
      '.mm-table-toolbar-button[data-action="col-delete"],\n' +
      '.mm-table-toolbar-button[data-action="table-delete"]';
    expect(webviewCss).toContain(destructiveGroup);
    expect(webviewCss).toContain(
      ".mm-document-content .mm-table-delete-preview",
    );
    expect(webviewCss).toContain(".mm-table-delete-preview-overlay");
    expect(webviewCss).toContain(".mm-table-delete-preview-rect");
    expect(webviewCss).toContain("--vscode-inputValidation-errorBorder");
  });
});
