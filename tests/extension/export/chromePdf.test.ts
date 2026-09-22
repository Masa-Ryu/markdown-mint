import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";

const chromeMocks = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  class Emitter {
    private readonly listeners = new Map<string, Listener[]>();
    private readonly onceWrappers = new Map<Listener, Listener>();
    public on(event: string, listener: Listener): this {
      this.listeners.set(event, [
        ...(this.listeners.get(event) ?? []),
        listener,
      ]);
      return this;
    }
    public once(event: string, listener: Listener): this {
      const wrapper: Listener = (...args) => {
        this.removeListener(event, wrapper);
        this.onceWrappers.delete(listener);
        listener(...args);
      };
      this.onceWrappers.set(listener, wrapper);
      return this.on(event, wrapper);
    }
    public removeListener(event: string, listener: Listener): this {
      const wrapper = this.onceWrappers.get(listener);
      const target = wrapper ?? listener;
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter(
          (candidate) => candidate !== target,
        ),
      );
      if (wrapper) this.onceWrappers.delete(listener);
      return this;
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
    public sigtermExits = true;
    public sigkillExits = true;
    public sigtermKillResult = true;
    public sigkillKillResult = true;
    public kill = vi.fn((signal?: string) => {
      const actualSignal = signal ?? "SIGTERM";
      const killResult =
        actualSignal === "SIGKILL"
          ? this.sigkillKillResult
          : this.sigtermKillResult;
      if (!killResult) return false;
      const exits =
        actualSignal === "SIGKILL" ? this.sigkillExits : this.sigtermExits;
      if (exits)
        queueMicrotask(() => {
          this.signalCode = actualSignal;
          this.emit("exit", null, actualSignal);
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
  chromeMocks.process.sigtermExits = true;
  chromeMocks.process.sigkillExits = true;
  chromeMocks.process.sigtermKillResult = true;
  chromeMocks.process.sigkillKillResult = true;
  chromeMocks.process.kill.mockClear();
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
    const launchArgs = chromeMocks.spawn.mock.calls[0]?.[1] as string[];
    const profileArgument = launchArgs.find((argument) =>
      argument.startsWith("--user-data-dir="),
    );
    expect(profileArgument).toBeDefined();
    expect(
      existsSync(profileArgument?.slice("--user-data-dir=".length) ?? ""),
    ).toBe(false);
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
    expect(chromeMocks.process.kill).toHaveBeenCalledWith("SIGTERM");
    expect(chromeMocks.process.kill).not.toHaveBeenCalledWith("SIGKILL");
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

  it("decodes a direct base64 PDF response", async () => {
    chromeMocks.cdp.send.mockImplementation(async (method: string) => {
      if (method === "Page.printToPDF")
        return { data: Buffer.from("%PDF-1.7").toString("base64") };
      if (method === "Target.createTarget") return { targetId: "target-1" };
      if (method === "Target.attachToTarget") return { sessionId: "session-1" };
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "frame-1" } } };
      if (method === "Runtime.evaluate") return { result: { value: 0 } };
      return {};
    });

    const pdf = await renderPdfWithChrome("<html></html>", {
      executablePath: "/usr/bin/google-chrome",
      timeoutMs: 100,
    });

    expect(Buffer.from(pdf).toString("utf8")).toBe("%PDF-1.7");
    expect(
      chromeMocks.cdp.send.mock.calls.filter(
        ([method]) => method === "IO.read" || method === "IO.close",
      ),
    ).toHaveLength(0);
  });

  it("retries once without transferMode when the browser rejects it", async () => {
    let printAttempts = 0;
    chromeMocks.cdp.send.mockImplementation(
      async (method: string, params?: Record<string, unknown>) => {
        if (method === "Page.printToPDF") {
          printAttempts += 1;
          if (printAttempts === 1)
            throw new Error(
              "CDP -32602 Invalid parameters: transferMode is not supported",
            );
          expect(params).toEqual({
            printBackground: true,
            preferCSSPageSize: true,
          });
          return { data: Buffer.from("%PDF-1.7").toString("base64") };
        }
        if (method === "Target.createTarget") return { targetId: "target-1" };
        if (method === "Target.attachToTarget")
          return { sessionId: "session-1" };
        if (method === "Page.getFrameTree")
          return { frameTree: { frame: { id: "frame-1" } } };
        if (method === "Runtime.evaluate") return { result: { value: 0 } };
        return {};
      },
    );

    const pdf = await renderPdfWithChrome("<html></html>", {
      executablePath: "/usr/bin/google-chrome",
      timeoutMs: 100,
    });

    expect(Buffer.from(pdf).toString("utf8")).toBe("%PDF-1.7");
    expect(printAttempts).toBe(2);
    const printCalls = chromeMocks.cdp.send.mock.calls.filter(
      ([method]) => method === "Page.printToPDF",
    );
    expect(printCalls).toHaveLength(2);
    expect(printCalls[0]?.[1]).toMatchObject({
      transferMode: "ReturnAsStream",
    });
  });

  it("does not retry an unrelated print failure", async () => {
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
        executablePath: "/usr/bin/google-chrome",
        timeoutMs: 100,
      }),
    ).rejects.toThrow("print failed");
    expect(
      chromeMocks.cdp.send.mock.calls.filter(
        ([method]) => method === "Page.printToPDF",
      ),
    ).toHaveLength(1);
  });

  it("waits for SIGKILL exit before removing the profile", async () => {
    chromeMocks.process.sigtermExits = false;

    const pdf = await renderPdfWithChrome("<html></html>", {
      executablePath: "/usr/bin/google-chrome",
      timeoutMs: 10,
    });

    expect(Array.from(pdf)).toEqual([37, 80, 68, 70, 45]);
    expect(chromeMocks.process.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(chromeMocks.process.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    const launchArgs = chromeMocks.spawn.mock.calls[0]?.[1] as string[];
    const profileArgument = launchArgs.find((argument) =>
      argument.startsWith("--user-data-dir="),
    );
    expect(
      existsSync(profileArgument?.slice("--user-data-dir=".length) ?? ""),
    ).toBe(false);
  });

  it("reports a failed SIGKILL and keeps the profile while the process is alive", async () => {
    chromeMocks.process.sigtermExits = false;
    chromeMocks.process.sigkillKillResult = false;

    const renderPromise = renderPdfWithChrome("<html></html>", {
      executablePath: "/usr/bin/google-chrome",
      timeoutMs: 10,
    });
    const renderFailure = expect(renderPromise).rejects.toThrow(
      "Could not send SIGKILL",
    );
    const launchArgsPromise = vi.waitFor(() => {
      expect(chromeMocks.spawn).toHaveBeenCalled();
    });
    await launchArgsPromise;
    const launchArgs = chromeMocks.spawn.mock.calls[0]?.[1] as string[];
    const profilePath =
      launchArgs
        .find((argument) => argument.startsWith("--user-data-dir="))
        ?.slice("--user-data-dir=".length) ?? "";

    await renderFailure;
    expect(existsSync(profilePath)).toBe(true);
    expect(chromeMocks.process.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(chromeMocks.process.kill).toHaveBeenNthCalledWith(2, "SIGKILL");

    chromeMocks.process.signalCode = "SIGKILL";
    chromeMocks.process.emit("exit", null, "SIGKILL");
    await rm(profilePath, { recursive: true, force: true });
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
    const launchArgs = chromeMocks.spawn.mock.calls[0]?.[1] as string[];
    const profileArgument = launchArgs.find((argument) =>
      argument.startsWith("--user-data-dir="),
    );
    expect(
      existsSync(profileArgument?.slice("--user-data-dir=".length) ?? ""),
    ).toBe(false);
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
    chromeMocks.process.exitCode = null;
    chromeMocks.process.signalCode = null;
    chromeMocks.process.kill.mockClear();
    chromeMocks.cdp.close.mockClear();
    chromeMocks.cdp.send.mockImplementation(async (method: string) => {
      if (method === "Page.printToPDF") throw new Error("print failed");
      if (method === "Target.createTarget") return { targetId: "target-1" };
      if (method === "Target.attachToTarget") return { sessionId: "session-1" };
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "frame-1" } } };
      if (method === "Runtime.evaluate") return { result: { value: 0 } };
      return {};
    });
    const renderPromise = renderPdfWithChrome("<html></html>", {
      executablePath: "/chrome",
      timeoutMs: 50,
    });
    const renderFailure = expect(renderPromise).rejects.toThrow("print failed");
    const launchArgsPromise = vi.waitFor(() => {
      expect(chromeMocks.spawn).toHaveBeenCalled();
    });
    await launchArgsPromise;
    const launchArgs = chromeMocks.spawn.mock.calls[0]?.[1] as string[];
    const profilePath =
      launchArgs
        .find((argument) => argument.startsWith("--user-data-dir="))
        ?.slice("--user-data-dir=".length) ?? "";
    await renderFailure;
    expect(chromeMocks.cdp.close).toHaveBeenCalledOnce();
    expect(existsSync(profilePath)).toBe(false);
    expect(createCdpClient).toHaveBeenCalled();
    expect(PDF_EXPORT_TIMEOUT_MS).toBe(30_000);
  });
});
