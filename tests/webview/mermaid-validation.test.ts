import { afterEach, describe, expect, it, vi } from "vitest";
import {
  humanizeMermaidDiagramType,
  MAX_MERMAID_SOURCE_LENGTH,
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
