import { afterEach, describe, expect, it } from "vitest";
import {
  parseMarkdown,
  renderMarkdown,
  schema,
  serializeMarkdown,
} from "../../src/core/index";
import {
  createEditorApp,
  type MarkdownEditorApp,
} from "../../src/webview/editor";

const apps: MarkdownEditorApp[] = [];

afterEach(() => {
  apps.splice(0).forEach((app) => app.destroy());
  document.body.replaceChildren();
});

function details(summary: string, body: string): string {
  return `<details open>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`;
}

function fixture(markdown: string): MarkdownEditorApp {
  const root = document.createElement("div");
  document.body.append(root);
  const app = createEditorApp({
    root,
    core: { schema, parseMarkdown, serializeMarkdown, renderMarkdown },
    initialDocument: { markdown, version: 1, profile: "gitlab" },
  });
  apps.push(app);
  return app;
}

function expectAnchors(app: MarkdownEditorApp, expected: string[]): void {
  const headings = Array.from(app.view.dom.querySelectorAll("h1,h2"));
  expect(headings.map((heading) => heading.id)).toEqual(expected);
  expect(
    headings.map((heading) => heading.getAttribute("data-mm-heading-id")),
  ).toEqual(expected);
  const links = Array.from(
    app.view.dom.querySelectorAll<HTMLAnchorElement>(".table-of-contents a"),
  );
  expect(links.map((link) => link.getAttribute("href"))).toEqual(
    expected.map((id) => `#${id}`),
  );
  for (const link of links) {
    const id = link.getAttribute("href")!.slice(1);
    expect(headings.filter((heading) => heading.id === id)).toHaveLength(1);
  }
}

describe("rich heading decorations for reused Details bodies", () => {
  it("assigns separate heading attributes and TOC targets to identical bodies", () => {
    const app = fixture(
      ["[[_TOC_]]", details("A", "# Shared"), details("B", "# Shared")].join(
        "\n\n",
      ),
    );
    expect(app.view.state.doc.child(1).firstChild).toBe(
      app.view.state.doc.child(2).firstChild,
    );
    expectAnchors(app, ["shared", "shared-1"]);
  });

  it("matches nested reused headings with an unrelated surrounding heading", () => {
    const body = `# Shared\n\n${details("Inner", "## Shared")}`;
    const app = fixture(
      [
        "[[_TOC_]]",
        "# Outside",
        details("A", body),
        details("B", body),
        "# Shared",
      ].join("\n\n"),
    );
    expectAnchors(app, [
      "outside",
      "shared",
      "shared-1",
      "shared-2",
      "shared-3",
      "shared-4",
    ]);
  });

  it("updates heading attributes and TOC targets when an earlier heading is inserted", () => {
    const app = fixture(
      ["[[_TOC_]]", details("A", "# Shared"), details("B", "# Shared")].join(
        "\n\n",
      ),
    );
    app.view.dispatch(
      app.view.state.tr.insert(
        0,
        schema.nodes.heading!.create({ level: 1 }, schema.text("Shared")),
      ),
    );
    expectAnchors(app, ["shared", "shared-1", "shared-2"]);
  });
});
