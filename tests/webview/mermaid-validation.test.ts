import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureMermaidRuntimeLoader,
  ensureMermaidRuntime,
  humanizeMermaidDiagramType,
  MAX_MERMAID_SOURCE_LENGTH,
  MERMAID_RUNTIME_READY_EVENT,
  MermaidValidationController,
  mermaidRuntimeVersionFromGlobal,
  normalizeMermaidSource,
  validateMermaidSource,
  type MermaidRuntime,
} from "../../src/webview/mermaidValidation";

function setRuntime(runtime: MermaidRuntime): void {
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.markdownMintMermaid = runtime;
  globals.markdownMintMermaidVersion = "11.17.2";
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  const globals = globalThis as unknown as Record<string, unknown>;
  delete globals.markdownMintMermaid;
  delete globals.markdownMintMermaidVersion;
  for (const script of document.querySelectorAll(
    "script[data-markdown-mint-mermaid-runtime]",
  ))
    script.remove();
  configureMermaidRuntimeLoader();
  vi.useRealTimers();
});

describe("Mermaid validation helpers", () => {
  it("normalizes the same unsafe directives removed before rendering", () => {
    expect(
      normalizeMermaidSource(
        "\0 %%{init: { theme: dark }}%% \n flowchart TD \n A-->B ",
      ),
    ).toBe("flowchart TD \n A-->B");
  });

  it("humanizes Mermaid detector IDs and preserves safe unknown fallbacks", () => {
    expect(humanizeMermaidDiagramType("flowchart-v2")).toBe("Flowchart");
    expect(humanizeMermaidDiagramType("classDiagram-v2")).toBe("Class diagram");
    expect(humanizeMermaidDiagramType("stateDiagram-v2")).toBe("State diagram");
    expect(humanizeMermaidDiagramType("xychart-beta")).toBe("XY chart");
    expect(humanizeMermaidDiagramType("future-diagram")).toBe("future-diagram");
  });

  it("uses parse, rejects empty/oversized input, and returns the detector type", async () => {
    const parse = vi.fn(async (source: string) => ({
      diagramType: source.startsWith("flowchart") ? "flowchart-v2" : "sequence",
    }));
    const runtime: MermaidRuntime = { parse, render: () => "<svg />" };
    expect(
      await validateMermaidSource(
        " %%{init: { theme: dark }}%% flowchart TD\nA-->B ",
        runtime,
      ),
    ).toEqual({ valid: true, diagramType: "flowchart-v2" });
    expect(parse).toHaveBeenCalledWith("flowchart TD\nA-->B");

    expect(await validateMermaidSource("   ", runtime)).toMatchObject({
      valid: false,
      error: "Mermaid source is empty.",
    });
    expect(
      await validateMermaidSource(
        "x".repeat(MAX_MERMAID_SOURCE_LENGTH + 1),
        runtime,
      ),
    ).toMatchObject({ valid: false });
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("exposes the build-injected runtime version instead of a package range", () => {
    expect(mermaidRuntimeVersionFromGlobal()).toBe("unknown");
    (
      globalThis as unknown as Record<string, unknown>
    ).markdownMintMermaidVersion = "11.17.2";
    expect(mermaidRuntimeVersionFromGlobal()).toBe("11.17.2");
  });
});

describe("Mermaid runtime loader", () => {
  it("shares one nonce-bearing local script across concurrent requests", async () => {
    configureMermaidRuntimeLoader({
      src: "/dist/mermaid.js",
      nonce: "test-nonce",
      ownerDocument: document,
    });
    const first = ensureMermaidRuntime();
    const second = ensureMermaidRuntime();
    expect(first).toBe(second);

    const scripts = Array.from(
      document.querySelectorAll<HTMLScriptElement>(
        "script[data-markdown-mint-mermaid-runtime]",
      ),
    );
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.getAttribute("src")).toBe("/dist/mermaid.js");
    expect(scripts[0]?.getAttribute("nonce")).toBe("test-nonce");

    let settled = false;
    void first.then(() => {
      settled = true;
    });
    document.dispatchEvent(new Event("DOMContentLoaded"));
    await flush();
    expect(settled).toBe(false);

    const runtime: MermaidRuntime = {
      parse: () => ({ diagramType: "flowchart-v2" }),
      render: () => "<svg />",
    };
    (globalThis as unknown as Record<string, unknown>).markdownMintMermaid =
      runtime;
    window.dispatchEvent(new Event(MERMAID_RUNTIME_READY_EVENT));
    await expect(first).resolves.toBe(runtime);
  });

  it("uses the shared request for first Mermaid validation", async () => {
    configureMermaidRuntimeLoader({
      src: "/dist/mermaid.js",
      nonce: "test-nonce",
      ownerDocument: document,
    });
    const validation = validateMermaidSource("flowchart TD\nA-->B");
    const runtime: MermaidRuntime = {
      parse: vi.fn(() => ({ diagramType: "flowchart-v2" })),
      render: () => "<svg />",
    };
    (globalThis as unknown as Record<string, unknown>).markdownMintMermaid =
      runtime;
    window.dispatchEvent(new Event(MERMAID_RUNTIME_READY_EVENT));
    await expect(validation).resolves.toEqual({
      valid: true,
      diagramType: "flowchart-v2",
    });
    expect(runtime.parse).toHaveBeenCalledWith("flowchart TD\nA-->B");
  });

  it("keeps a failed local load non-fatal and does not duplicate it", async () => {
    configureMermaidRuntimeLoader({
      src: "/dist/missing-mermaid.js",
      ownerDocument: document,
    });
    const first = ensureMermaidRuntime();
    const script = document.querySelector<HTMLScriptElement>(
      "script[data-markdown-mint-mermaid-runtime]",
    );
    expect(script).not.toBeNull();
    script?.dispatchEvent(new Event("error"));
    await expect(first).resolves.toBeUndefined();
    await expect(ensureMermaidRuntime()).resolves.toBeUndefined();
    expect(
      document.querySelectorAll("script[data-markdown-mint-mermaid-runtime]"),
    ).toHaveLength(1);
  });
});

describe("MermaidValidationController", () => {
  it("debounces parse and disables the editor while checking", async () => {
    vi.useFakeTimers();
    const snapshots: Array<{ status: string; source: string }> = [];
    const parse = vi.fn(async () => ({ diagramType: "flowchart-v2" }));
    setRuntime({ parse, render: () => "<svg />" });
    const controller = new MermaidValidationController(
      (snapshot) => snapshots.push(snapshot),
      300,
    );

    controller.schedule("flowchart TD\nA-->B");
    expect(snapshots.at(-1)?.status).toBe("checking");
    expect(parse).not.toHaveBeenCalled();
    vi.advanceTimersByTime(299);
    expect(parse).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await flush();
    expect(parse).toHaveBeenCalledTimes(1);
    expect(snapshots.at(-1)).toMatchObject({ status: "valid" });
    controller.dispose();
  });

  it("ignores stale asynchronous results and disposed dialogs", async () => {
    vi.useFakeTimers();
    const resolvers: Array<(value: { diagramType: string }) => void> = [];
    const snapshots: Array<{ status: string; source: string }> = [];
    setRuntime({
      parse: () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
      render: () => "<svg />",
    });
    const controller = new MermaidValidationController(
      (snapshot) => snapshots.push(snapshot),
      0,
    );

    controller.schedule("old");
    vi.advanceTimersByTime(0);
    await flush();
    controller.schedule("new");
    vi.advanceTimersByTime(0);
    await flush();
    expect(resolvers).toHaveLength(2);
    resolvers[0]?.({ diagramType: "flowchart-v2" });
    resolvers[1]?.({ diagramType: "sequence" });
    await flush();
    expect(snapshots.at(-1)).toMatchObject({
      status: "valid",
      source: "new",
      diagramType: "sequence",
    });

    controller.schedule("disposed");
    vi.advanceTimersByTime(0);
    await flush();
    const snapshotCountBeforeDispose = snapshots.length;
    controller.dispose();
    resolvers[2]?.({ diagramType: "flowchart-v2" });
    await flush();
    expect(snapshots).toHaveLength(snapshotCountBeforeDispose);
  });
});
