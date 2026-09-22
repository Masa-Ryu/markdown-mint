import { beforeEach, describe, expect, it, vi } from "vitest";

const chromeMocks = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  class Emitter {
    private readonly listeners = new Map<string, Listener[]>();
    public on(event: string, listener: Listener): this {
      this.listeners.set(event, [
        ...(this.listeners.get(event) ?? []),
        listener,
      ]);
      return this;
    }
    public once(event: string, listener: Listener): this {
      const wrapper: Listener = (...args) => {
        this.listeners.set(
          event,
          (this.listeners.get(event) ?? []).filter(
            (candidate) => candidate !== wrapper,
          ),
        );
        listener(...args);
      };
      return this.on(event, wrapper);
    }
    public emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])])
        listener(...args);
    }
  }
  class FakeProcess extends Emitter {
    public readonly stderr = new Emitter();
    public readonly stdout = new Emitter();
    public exitCode: number | null = null;
    public signalCode: string | null = null;
    public kill = vi.fn((_signal?: string) => {
      setImmediate(() => {
        this.signalCode = "SIGTERM";
        this.emit("exit", null, "SIGTERM");
      });
      return true;
    });
  }
  const process = new FakeProcess();
  const cdp = {
    send: vi.fn(),
    close: vi.fn(async () => undefined),
  };
  return { Emitter, FakeProcess, process, cdp, spawn: vi.fn() };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    mkdtemp: vi.fn(async () => "/tmp/markdown-mint-pdf-test"),
    rm: vi.fn(async () => undefined),
  };
});
vi.mock("../../../src/extension/export/browserProcess", () => ({
  launchBrowser: chromeMocks.spawn,
}));
vi.mock("../../../src/extension/export/cdpClient", () => ({
  createCdpClient: vi.fn(async () => chromeMocks.cdp),
}));

import { createCdpClient } from "../../../src/extension/export/cdpClient";
import {
  PDF_EXPORT_TIMEOUT_MS,
  renderPdfWithChrome,
} from "../../../src/extension/export/chromePdf";

function configureBrowser(): void {
  chromeMocks.spawn.mockImplementation(() => {
    queueMicrotask(() =>
      chromeMocks.process.stderr.emit(
        "data",
        Buffer.from(
          "DevTools listening on ws://127.0.0.1:1234/devtools/browser/test\n",
        ),
      ),
    );
    return chromeMocks.process;
  });
}

function configureCdp(): void {
  chromeMocks.cdp.send.mockImplementation(async (method: string) => {
    switch (method) {
      case "Target.createTarget":
        return { targetId: "target-1" };
      case "Target.attachToTarget":
        return { sessionId: "session-1" };
      case "Page.getFrameTree":
        return { frameTree: { frame: { id: "frame-1" } } };
      case "Runtime.evaluate":
        return { result: { value: 0 } };
      case "Page.printToPDF":
        return { stream: "stream-1" };
      case "IO.read":
        return {
          data: Buffer.from("%PDF-").toString("base64"),
          base64Encoded: true,
          eof: true,
        };
      default:
        return {};
    }
  });
}

beforeEach(() => {
  chromeMocks.spawn.mockReset();
  chromeMocks.cdp.send.mockReset();
  chromeMocks.cdp.close.mockClear();
  chromeMocks.process.exitCode = null;
  chromeMocks.process.signalCode = null;
  configureBrowser();
  configureCdp();
});

describe("Chrome CDP PDF backend", () => {
  it("launches an isolated profile, reads the PDF stream, and cleans up", async () => {
    const pdf = await renderPdfWithChrome("<html></html>", {
      executablePath: "/usr/bin/google-chrome",
      timeoutMs: 100,
    });
    expect(Array.from(pdf)).toEqual([37, 80, 68, 70, 45]);
    expect(chromeMocks.spawn).toHaveBeenCalledWith(
      "/usr/bin/google-chrome",
      expect.arrayContaining([
        "--headless=new",
        "--remote-debugging-port=0",
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ]),
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(chromeMocks.cdp.send).toHaveBeenCalledWith(
      "Page.printToPDF",
      {
        printBackground: true,
        preferCSSPageSize: true,
        transferMode: "ReturnAsStream",
      },
      "session-1",
    );
    expect(chromeMocks.cdp.send).toHaveBeenCalledWith(
      "IO.close",
      { handle: "stream-1" },
      "session-1",
    );
    const browserExpressions = chromeMocks.cdp.send.mock.calls
      .filter(([method]) => method === "Runtime.evaluate")
      .map(([, params]) => (params as { expression: string }).expression);
    expect(browserExpressions).toHaveLength(2);
    expect(
      browserExpressions.every((expression) => typeof expression === "string"),
    ).toBe(true);
    expect(browserExpressions.join("\n")).not.toMatch(/\b__name\b/);
    expect(chromeMocks.cdp.close).toHaveBeenCalledOnce();
  });

  it("reports an endpoint timeout and still cleans the temporary profile", async () => {
    chromeMocks.spawn.mockReset();
    chromeMocks.spawn.mockReturnValue(new chromeMocks.FakeProcess());
    await expect(
      renderPdfWithChrome("<html></html>", {
        executablePath: "/missing/chrome",
        timeoutMs: 5,
      }),
    ).rejects.toThrow("Timed out waiting for Chrome DevTools");
  });

  it("reports launch, resource, Mermaid, and print failures with cleanup", async () => {
    chromeMocks.spawn.mockReset();
    const failedProcess = new chromeMocks.FakeProcess();
    chromeMocks.spawn.mockImplementation(() => {
      queueMicrotask(() =>
        failedProcess.emit("error", new Error("launch failed")),
      );
      return failedProcess;
    });
    await expect(
      renderPdfWithChrome("<html></html>", {
        executablePath: "/bad/chrome",
        timeoutMs: 50,
      }),
    ).rejects.toThrow("launch failed");

    chromeMocks.spawn.mockReset();
    configureBrowser();
    chromeMocks.cdp.send.mockImplementation(async (method: string) => {
      if (method === "Runtime.evaluate") throw new Error("resource timeout");
      if (method === "Target.createTarget") return { targetId: "target-1" };
      if (method === "Target.attachToTarget") return { sessionId: "session-1" };
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "frame-1" } } };
      return {};
    });
    await expect(
      renderPdfWithChrome("<html></html>", {
        executablePath: "/chrome",
        timeoutMs: 50,
      }),
    ).rejects.toThrow("resource timeout");

    chromeMocks.spawn.mockReset();
    configureBrowser();
    configureCdp();
    chromeMocks.cdp.send.mockImplementation(async (method: string) => {
      if (method === "Runtime.evaluate") return { result: { value: 1 } };
      if (method === "Target.createTarget") return { targetId: "target-1" };
      if (method === "Target.attachToTarget") return { sessionId: "session-1" };
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "frame-1" } } };
      return {};
    });
    await expect(
      renderPdfWithChrome("<html></html>", {
        executablePath: "/chrome",
        timeoutMs: 50,
      }),
    ).rejects.toThrow("Mermaid");

    chromeMocks.spawn.mockReset();
    configureBrowser();
    configureCdp();
    chromeMocks.cdp.send.mockImplementation(async (method: string) => {
      if (method === "Page.printToPDF") throw new Error("print failed");
      if (method === "Target.createTarget") return { targetId: "target-1" };
      if (method === "Target.attachToTarget") return { sessionId: "session-1" };
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "frame-1" } } };
      if (method === "Runtime.evaluate") return { result: { value: 0 } };
      return {};
    });
    await expect(
      renderPdfWithChrome("<html></html>", {
        executablePath: "/chrome",
        timeoutMs: 50,
      }),
    ).rejects.toThrow("print failed");
    expect(createCdpClient).toHaveBeenCalled();
    expect(PDF_EXPORT_TIMEOUT_MS).toBe(30_000);
  });
});
