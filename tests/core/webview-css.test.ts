import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const webviewCss = readFileSync(
  resolve(process.cwd(), "media/webview.css"),
  "utf8",
);
const documentCss = readFileSync(
  resolve(process.cwd(), "media/document.css"),
  "utf8",
);

describe("Mermaid dialog styles", () => {
  it("scopes the large navigation-first editor layout to Mermaid only", () => {
    expect(webviewCss).toContain(
      '.mm-input-dialog.mm-profile-feature-dialog[data-profile-feature="mermaid"]',
    );
    expect(webviewCss).toContain("width: min(960px, calc(100vw - 32px));");
    expect(webviewCss).toContain("height: min(760px, calc(100dvh - 32px));");
    expect(webviewCss).toContain(
      "grid-template-rows: auto auto minmax(0, 1fr) auto;",
    );
    expect(webviewCss).toContain('"nav nav"');
    expect(webviewCss).toContain(".mm-mermaid-back-to-templates");
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

describe("native Mermaid role-scoped rendering styles", () => {
  it("scopes Mindmap and Gantt fixes to both document hosts and their SVG roles", () => {
    const compactCss = documentCss.replace(/\s+/g, " ");
    expect(compactCss).toContain(
      ':is(.markdown-body, .mm-document-content) .mm-mermaid svg[aria-roledescription="mindmap"]',
    );
    expect(compactCss).toContain(
      ':is(.markdown-body, .mm-document-content) .mm-mermaid svg[aria-roledescription="gantt"]',
    );
    expect(documentCss).toContain(".mindmap-node.section-root.section--1");
    expect(documentCss).toMatch(
      /svg\[aria-roledescription="mindmap"\][\s\S]*?\.mindmap-node\.section-root\s+text[\s\S]*?text-anchor:\s*middle\s*!important/,
    );
    expect(documentCss).toContain(".section-edge-0");
    expect(documentCss).toContain(".edge-depth-5");
    expect(documentCss).toContain(".taskTextOutsideRight");
    expect(documentCss).toContain(".activeCrit0");
    expect(documentCss).toContain(".doneCrit0");
    expect(documentCss).toContain(".milestone");
    expect(documentCss).toContain('svg[aria-roledescription="classDiagram"]');
    expect(documentCss).toContain('marker[id*="classDiagram-extension"]');
    expect(documentCss).toContain('marker[id*="classDiagram-aggregation"]');
    expect(documentCss).not.toMatch(
      /(?:^|,)\s*\.mm-mermaid\s+svg\s+\.section(?:[,{\s])/m,
    );
  });

  it("keeps Mindmap surfaces opaque and ER cardinality paint role-scoped", () => {
    const compactCss = documentCss.replace(/\s+/g, " ");
    expect(compactCss).toContain("--mm-mermaid-surface-opaque:");
    expect(compactCss).toMatch(
      /svg\[aria-roledescription="mindmap"\][\s\S]*?\.mindmap-node:not\(\.section-root\)[\s\S]*?fill-opacity:\s*1\s*!important[\s\S]*?opacity:\s*1\s*!important/,
    );
    expect(compactCss).toMatch(
      /svg\[aria-roledescription="mindmap"\][\s\S]*?\.mindmap-node\.section-root\.section--1[\s\S]*?fill-opacity:\s*1\s*!important[\s\S]*?opacity:\s*1\s*!important/,
    );
    expect(compactCss).toMatch(
      /svg\[aria-roledescription="er"\][\s\S]*?\.marker\.er\s+path\s*\{\s*fill:\s*none\s*!important/,
    );
    const erCircleRule = compactCss.slice(
      compactCss.indexOf(".marker.er circle"),
      compactCss.indexOf(".marker.er circle") + 400,
    );
    expect(erCircleRule).toContain("fill:");
    expect(erCircleRule).toContain("--mm-mermaid-surface-opaque");
    expect(compactCss).toContain('svg[aria-roledescription="classDiagram"]');
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
