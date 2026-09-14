import { afterEach, describe, expect, it, vi } from "vitest";
import type { Node as PMNode } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { parseMarkdown, schema } from "../../src/core";
import * as visualRendering from "../../src/core/visualRendering";
import {
  enhanceMixedTaskCheckboxes,
  enhanceRenderedContent,
  type MermaidRuntime,
} from "../../src/webview/mermaidEnhancer";
import {
  enhanceCodeBlockControls,
  syncCodeLineNumberHeights,
} from "../../src/webview/codeBlockControls";
import { renderCodeBlock } from "../../src/core/visualRendering";
import { createRenderingPlugin } from "../../src/webview/rendering";

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
  it("wires copy and expand actions for a rendered code card", async () => {
    const source = "const value = 1;\nreturn value;";
    const root = document.createElement("div");
    root.innerHTML = renderCodeBlock(source, "ts");
    document.body.append(root);
    const originalClipboard = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard",
    );
    let copied = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (value: string) => Promise.resolve((copied = value)),
      },
    });
    const binding = enhanceCodeBlockControls(root);
    try {
      root
        .querySelector<HTMLButtonElement>('[data-mm-code-action="copy"]')
        ?.click();
      expect(copied).toBe(source);
      await flush();
      expect(
        root.querySelector<HTMLButtonElement>('[data-mm-code-action="copy"]')
          ?.dataset.mmCopyState,
      ).toBe("success");
      const expand = root.querySelector<HTMLButtonElement>(
        '[data-mm-code-action="expand"]',
      )!;
      const card = root.querySelector<HTMLElement>(".mm-code-block")!;
      expand.click();
      expect(card.classList.contains("mm-code-block-expanded")).toBe(true);
      expect(card.getAttribute("aria-modal")).toBe("true");
      expand.click();
      expect(card.classList.contains("mm-code-block-expanded")).toBe(false);
      expect(card.hasAttribute("aria-modal")).toBe(false);
    } finally {
      binding.dispose();
      if (originalClipboard)
        Object.defineProperty(navigator, "clipboard", originalClipboard);
      else
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: undefined,
        });
    }
  });

  it("provides per-block display settings and copies valid Markdown", async () => {
    const source = "line with ```\nlast";
    const root = document.createElement("div");
    root.innerHTML = renderCodeBlock(source, 'ts title="example.ts"');
    document.body.append(root);
    let copied = "";
    const originalClipboard = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard",
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (value: string) => Promise.resolve((copied = value)),
      },
    });
    const binding = enhanceCodeBlockControls(root);
    try {
      const card = root.querySelector<HTMLElement>(".mm-code-block")!;
      const more = root.querySelector<HTMLButtonElement>(
        '[data-mm-code-action="more"]',
      )!;
      more.click();
      const menu = card.querySelector<HTMLElement>(".mm-code-menu")!;
      expect(menu.hidden).toBe(false);
      const wrap = card.querySelector<HTMLButtonElement>(
        '[data-mm-code-menu-option="wrap"]',
      )!;
      wrap.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "ArrowDown",
        }),
      );
      expect(document.activeElement).toBe(
        card.querySelector('[data-mm-code-menu-option="line-numbers"]'),
      );
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Escape",
        }),
      );
      expect(menu.hidden).toBe(true);
      expect(document.activeElement).toBe(more);
      more.click();
      wrap.click();
      expect(card.classList.contains("mm-code-wrap-lines")).toBe(true);
      expect(wrap.getAttribute("aria-checked")).toBe("true");
      const lineNumbers = card.querySelector<HTMLButtonElement>(
        '[data-mm-code-menu-option="line-numbers"]',
      )!;
      lineNumbers.click();
      expect(card.classList.contains("mm-code-hide-line-numbers")).toBe(true);
      expect(lineNumbers.getAttribute("aria-checked")).toBe("false");
      card
        .querySelector<HTMLButtonElement>(
          '[data-mm-code-menu-option="markdown"]',
        )!
        .click();
      await flush();
      expect(copied).toBe(
        '````ts title="example.ts"\nline with ```\nlast\n````',
      );
    } finally {
      binding.dispose();
      if (originalClipboard)
        Object.defineProperty(navigator, "clipboard", originalClipboard);
      else
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: undefined,
        });
    }
  });

  it("reports asynchronous copy failure and allows a retry", async () => {
    const root = document.createElement("div");
    root.innerHTML = renderCodeBlock("value", "ts");
    document.body.append(root);
    let shouldSucceed = false;
    const originalClipboard = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard",
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () =>
          shouldSucceed
            ? Promise.resolve()
            : Promise.reject(new Error("denied")),
      },
    });
    const binding = enhanceCodeBlockControls(root);
    try {
      const copy = root.querySelector<HTMLButtonElement>(
        '[data-mm-code-action="copy"]',
      )!;
      copy.click();
      await flush();
      expect(copy.dataset.mmCopyState).toBe("failure");
      expect(root.querySelector(".mm-code-status")?.textContent).toContain(
        "Copy failed",
      );
      shouldSucceed = true;
      copy.click();
      await flush();
      expect(copy.dataset.mmCopyState).toBe("success");
    } finally {
      binding.dispose();
      if (originalClipboard)
        Object.defineProperty(navigator, "clipboard", originalClipboard);
      else
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: undefined,
        });
    }
  });

  it("controls a card passed as the root and cleans up expanded state", () => {
    const root = document.createElement("div");
    root.innerHTML = renderCodeBlock("value", "ts");
    document.body.append(root);
    const card = root.firstElementChild as HTMLElement;
    const binding = enhanceCodeBlockControls(card);
    const more = card.querySelector<HTMLButtonElement>(
      '[data-mm-code-action="more"]',
    )!;
    more.click();
    const menu = card.querySelector<HTMLElement>(".mm-code-menu")!;
    expect(menu.hidden).toBe(false);
    document.body.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true }),
    );
    expect(menu.hidden).toBe(true);

    card
      .querySelector<HTMLButtonElement>('[data-mm-code-action="expand"]')
      ?.click();
    expect(card.classList.contains("mm-code-block-expanded")).toBe(true);
    binding.dispose();
    expect(card.classList.contains("mm-code-block-expanded")).toBe(false);
    expect(document.querySelector(".mm-code-focus-backdrop")).toBeNull();
  });

  it("keeps one line number per logical line when wrapped code is measured", () => {
    const source = Array.from(
      { length: 20 },
      (_, index) => `line ${index + 1} with a long source value`,
    ).join("\n");
    const root = document.createElement("div");
    root.innerHTML = renderCodeBlock(source, "ts");
    document.body.append(root);
    const block = root.firstElementChild as HTMLElement;
    block.classList.add("mm-code-wrap-lines");

    syncCodeLineNumberHeights(block);

    const numbers = Array.from(
      block.querySelectorAll<HTMLElement>(".mm-code-line-numbers span"),
    );
    expect(numbers).toHaveLength(20);
    expect(numbers.map((number) => number.textContent)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "11",
      "12",
      "13",
      "14",
      "15",
      "16",
      "17",
      "18",
      "19",
      "20",
    ]);
    expect(numbers.every((number) => number.style.minHeight)).toBe(true);
  });

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
    expect(element.querySelector<SVGPathElement>("svg path")?.style.fill).toBe(
      "none",
    );
    enhancer.dispose();
  });

  it("passes the shared normalized source to Mermaid rendering", async () => {
    const sources: string[] = [];
    const runtime: MermaidRuntime = {
      render: (_id, source) => {
        sources.push(source);
        return "<svg />";
      },
    };
    (globalThis as Record<string, unknown>).markdownMintMermaid = runtime;
    const element = diagram(
      "\0 %%{init: { theme: dark }}%%\nflowchart TD\n A-->B",
    );
    const enhancer = enhanceRenderedContent(document.body);
    await flush();

    expect(sources).toEqual(["flowchart TD\n A-->B"]);
    expect(element.dataset.mmMermaidState).toBe("rendered");
    enhancer.dispose();
  });

  it("removes SVG fallback fills from connectors and edge label backgrounds", async () => {
    const runtime: MermaidRuntime = {
      render: () =>
        '<svg><rect class="background" width="100" height="50" />' +
        '<g class="edgePaths"><path class="flowchart-link" /></g>' +
        '<g class="edgeLabel"><rect class="labelBkg" /></g></svg>',
    };
    (globalThis as Record<string, unknown>).markdownMintMermaid = runtime;
    const element = diagram();
    const enhancer = enhanceRenderedContent(document.body);
    await flush();

    const svg = element.querySelector("svg");
    expect(svg?.style.getPropertyValue("background")).toBe("transparent");
    expect(svg?.querySelector<SVGElement>("rect.background")?.style.fill).toBe(
      "transparent",
    );
    expect(svg?.querySelector<SVGElement>(".flowchart-link")?.style.fill).toBe(
      "none",
    );
    expect(
      svg?.querySelector<SVGElement>(".edgeLabel .labelBkg")?.style.fill,
    ).toBe("var(--mm-mermaid-background)");
    enhancer.dispose();
  });

  it("keeps flowchart node alignment scoped away from explicit edge alignment", async () => {
    const runtime: MermaidRuntime = {
      render: () =>
        '<svg aria-roledescription="flowchart-v2">' +
        '<g class="node"><rect class="label-container" />' +
        '<g class="label"><text x="0">Node</text></g></g>' +
        '<g class="edgeLabel"><text text-anchor="middle">Yes</text></g>' +
        "</svg>",
    };
    (globalThis as Record<string, unknown>).markdownMintMermaid = runtime;
    const element = diagram();
    const enhancer = enhanceRenderedContent(document.body);
    await flush();

    const svg = element.querySelector("svg");
    const nodeText = svg?.querySelector<SVGTextElement>(".node .label text");
    const edgeText = svg?.querySelector<SVGTextElement>(".edgeLabel text");
    expect(svg?.getAttribute("aria-roledescription")).toBe("flowchart-v2");
    expect(nodeText?.hasAttribute("text-anchor")).toBe(false);
    expect(edgeText?.getAttribute("text-anchor")).toBe("middle");
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

function firstCodeBlock(doc: PMNode): { node: PMNode; position: number } {
  let result: { node: PMNode; position: number } | undefined;
  doc.descendants((node, position) => {
    if (node.type.name !== "code_block") return true;
    result = { node, position };
    return false;
  });
  if (!result) throw new Error("test document has no code block");
  return result;
}

function syntaxRanges(
  plugin: ReturnType<typeof createRenderingPlugin>,
  state: EditorState,
): Array<{ from: number; to: number }> {
  return (
    plugin
      .getState(state)
      ?.decorations.find()
      .filter(
        (decoration) =>
          (decoration.spec as Record<string, unknown>)["data-mm-syntax"] ===
          "true",
      )
      .map(({ from, to }) => ({ from, to })) ?? []
  );
}

function codeRenderingState(): {
  plugin: ReturnType<typeof createRenderingPlugin>;
  state: EditorState;
} {
  const plugin = createRenderingPlugin(() => "github");
  const state = EditorState.create({
    schema,
    doc: parseMarkdown("before\n\n```ts\nconst value = 1;\n```", "github").doc,
    plugins: [plugin],
  });
  return { plugin, state };
}

describe("code highlighting decoration reuse", () => {
  it("reuses an unchanged code block after an ordinary paragraph edit", () => {
    const highlight = vi.spyOn(visualRendering, "highlightCodeSpans");
    try {
      const { plugin, state } = codeRenderingState();
      expect(syntaxRanges(plugin, state).length).toBeGreaterThan(0);
      highlight.mockClear();

      const nextState = state.apply(state.tr.insertText(" edited", 1));

      expect(highlight).not.toHaveBeenCalled();
      expect(syntaxRanges(plugin, nextState).length).toBeGreaterThan(0);
    } finally {
      highlight.mockRestore();
    }
  });

  it("maps syntax decorations when a paragraph is inserted before the code", () => {
    const highlight = vi.spyOn(visualRendering, "highlightCodeSpans");
    try {
      const { plugin, state } = codeRenderingState();
      const previousBlock = firstCodeBlock(state.doc);
      const previousRanges = syntaxRanges(plugin, state);
      const paragraph = schema.nodes.paragraph!.create(
        null,
        schema.text("inserted"),
      );
      highlight.mockClear();

      const nextState = state.apply(
        state.tr.insert(state.doc.child(0).nodeSize, paragraph),
      );

      const nextBlock = firstCodeBlock(nextState.doc);
      const offset = nextBlock.position - previousBlock.position;
      expect(nextBlock.position).toBe(
        previousBlock.position + paragraph.nodeSize,
      );
      expect(highlight).not.toHaveBeenCalled();
      expect(syntaxRanges(plugin, nextState)).toEqual(
        previousRanges.map(({ from, to }) => ({
          from: from + offset,
          to: to + offset,
        })),
      );
    } finally {
      highlight.mockRestore();
    }
  });

  it("re-highlights when the code text or language changes", () => {
    const highlight = vi.spyOn(visualRendering, "highlightCodeSpans");
    try {
      const first = codeRenderingState();
      const block = firstCodeBlock(first.state.doc);
      highlight.mockClear();

      first.state.apply(first.state.tr.insertText("let ", block.position + 1));
      expect(highlight).toHaveBeenCalledTimes(1);

      highlight.mockClear();
      first.state.apply(
        first.state.tr.setNodeMarkup(block.position, undefined, {
          ...block.node.attrs,
          params: "javascript",
        }),
      );
      expect(highlight).toHaveBeenCalledTimes(1);
    } finally {
      highlight.mockRestore();
    }
  });
});
