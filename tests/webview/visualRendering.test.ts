import { afterEach, describe, expect, it } from "vitest";
import {
  enhanceMixedTaskCheckboxes,
  enhanceRenderedContent,
  type MermaidRuntime,
} from "../../src/webview/mermaidEnhancer";

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

function diagram(source = "flowchart TD\\n A-->B"): HTMLElement {
  const element = document.createElement("div");
  element.dataset.mmMermaid = "true";
  element.dataset.mermaidSource = source;
  element.dataset.mmMermaidState = "pending";
  element.innerHTML =
    '<p class="mm-diagram-status">Rendering Mermaid diagram...</p>' +
    '<pre class="mm-diagram-source">' +
    source +
    "</pre>";
  document.body.append(element);
  return element;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).markdownMintMermaid;
  document.documentElement.className = "";
  document.body.className = "";
  for (const name of [
    "--vscode-editor-foreground",
    "--vscode-foreground",
    "--vscode-editor-background",
    "--vscode-background",
    "--vscode-textCodeBlock-background",
    "--vscode-editorWidget-background",
    "--vscode-sideBar-background",
    "--vscode-descriptionForeground",
    "--vscode-textSeparator-foreground",
    "--vscode-panel-border",
    "--vscode-textLink-foreground",
    "--vscode-focusBorder",
  ])
    document.documentElement.style.removeProperty(name);
  document.body.replaceChildren();
});

describe("local Mermaid rendering lifecycle", () => {
  it("sets the native indeterminate property from the safe task state", () => {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.taskState = "mixed";
    document.body.append(checkbox);
    enhanceMixedTaskCheckboxes(document.body);
    expect(checkbox.indeterminate).toBe(true);
    expect(checkbox.getAttribute("aria-checked")).toBe("mixed");
  });
  it("passes the active host palette to Mermaid for readable diagram colors", async () => {
    document.body.classList.add("vscode-dark");
    document.documentElement.style.setProperty(
      "--vscode-editor-foreground",
      "#f1f1f1",
    );
    document.documentElement.style.setProperty(
      "--vscode-editor-background",
      "#181818",
    );
    document.documentElement.style.setProperty(
      "--vscode-textCodeBlock-background",
      "#252526",
    );
    document.documentElement.style.setProperty(
      "--vscode-descriptionForeground",
      "#a8b1c2",
    );
    const calls: Array<Record<string, unknown>> = [];
    const runtime: MermaidRuntime = {
      initialize: (options) => calls.push(options),
      render: () => '<svg><path class="flowchart-link" /></svg>',
    };
    (globalThis as Record<string, unknown>).markdownMintMermaid = runtime;
    const element = diagram();
    const enhancer = enhanceRenderedContent(document.body);
    await flush();

    expect(calls[0]).toMatchObject({
      theme: "base",
      themeVariables: {
        primaryTextColor: "#f1f1f1",
        lineColor: "#a8b1c2",
        background: "#181818",
        primaryColor: "#252526",
      },
    });
    expect(element.dataset.mmMermaidState).toBe("rendered");
    enhancer.dispose();
  });

  it("uses strict local rendering and rejects active or external SVG payloads", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const runtime: MermaidRuntime = {
      initialize: (options) => calls.push(options),
      render: async (id) =>
        '<svg id="' +
        id +
        '" onload="alert(1)" href="https://example.invalid">' +
        "<style>.edge{marker-end:url(#arrowhead)} .remote{background:url(https://example.invalid/x)} @import url(https://example.invalid/theme.css);</style>" +
        '<script>alert(1)</script><g class="edge">A</g></svg>',
    };
    (globalThis as Record<string, unknown>).markdownMintMermaid = runtime;
    const element = diagram();
    const enhancer = enhanceRenderedContent(document.body);
    await flush();

    const svg = element.querySelector("svg");
    expect(element.dataset.mmMermaidState).toBe("rendered");
    expect(svg).not.toBeNull();
    expect(svg?.hasAttribute("onload")).toBe(false);
    expect(svg?.hasAttribute("href")).toBe(false);
    expect(svg?.querySelector("script")).toBeNull();
    expect(svg?.querySelector("style")?.textContent).toContain(
      "url(#arrowhead)",
    );
    expect(svg?.querySelector("style")?.textContent).not.toContain(
      "example.invalid",
    );
    expect(calls[0]).toMatchObject({
      startOnLoad: false,
      securityLevel: "strict",
    });
    expect(
      element.querySelector<HTMLElement>(".mm-diagram-source")?.hidden,
    ).toBe(true);
    enhancer.dispose();
  });

  it("ignores stale asynchronous results after an invalidation", async () => {
    const resolvers: Array<(value: string) => void> = [];
    const runtime: MermaidRuntime = {
      render: (id) =>
        new Promise<string>((resolve) => {
          resolvers.push((value) => resolve(value.replace("PLACEHOLDER", id)));
        }),
    };
    (globalThis as Record<string, unknown>).markdownMintMermaid = runtime;
    const element = diagram("flowchart TD\\n A-->B");
    const enhancer = enhanceRenderedContent(document.body);
    await flush();
    element.dataset.mermaidSource = "flowchart TD\\n A-->C";
    enhancer.invalidate();
    await flush();
    expect(resolvers).toHaveLength(2);
    resolvers[0]?.('<svg id="PLACEHOLDER"><g>old</g></svg>');
    resolvers[1]?.('<svg id="PLACEHOLDER"><g>new</g></svg>');
    await flush();
    expect(element.querySelector("svg")?.textContent).toBe("new");
    enhancer.dispose();
  });

  it("does not retry failed output on every mutation", async () => {
    let calls = 0;
    const runtime: MermaidRuntime = {
      render: () => {
        calls += 1;
        return "<div>invalid</div>";
      },
    };
    (globalThis as Record<string, unknown>).markdownMintMermaid = runtime;
    const element = diagram();
    const enhancer = enhanceRenderedContent(document.body);
    await flush();
    await flush();
    expect(calls).toBe(1);
    expect(element.dataset.mmMermaidState).toBe("failed");
    expect(element.querySelector(".mm-diagram-source")?.textContent).toContain(
      "flowchart",
    );
    enhancer.dispose();
  });
});
