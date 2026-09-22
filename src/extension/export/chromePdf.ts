import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { launchBrowser } from "./browserProcess";
import { createCdpClient, type CdpClient } from "./cdpClient";

export const PDF_EXPORT_TIMEOUT_MS = 30_000;

export interface PdfExportOptions {
  readonly executablePath: string;
  readonly timeoutMs?: number;
}

function resourceReadinessExpression(timeoutMs: number): string {
  return `(() => {
    const timeout = ${Math.max(1, Math.floor(timeoutMs))};
    const withTimeout = (promise, label) => Promise.race([
      promise,
      new Promise((_resolve, reject) => window.setTimeout(() => reject(new Error("Timed out waiting for " + label + ".")), timeout)),
    ]);
    return (async () => {
      await withTimeout(new Promise((resolve) => {
        if (document.readyState === "complete") resolve();
        else window.addEventListener("load", resolve, { once: true });
      }), "document load");
      await withTimeout(document.fonts.ready, "KaTeX fonts");
      const images = Array.from(document.images).filter((image) => {
        const source = image.getAttribute("src") || "";
        return !/^https?:\\/\\//i.test(source);
      });
      await withTimeout(Promise.all(images.map(async (image) => {
        if (!image.complete) await new Promise((resolve, reject) => {
          image.addEventListener("load", () => resolve(), { once: true });
          image.addEventListener("error", () => reject(new Error("An embedded or local image failed to load.")), { once: true });
        });
        if (image.naturalWidth === 0) throw new Error("An embedded or local image failed to load.");
        if (typeof image.decode === "function") await image.decode();
      })), "local images");
    })();
  })()`;
}

function mermaidReadinessExpression(timeoutMs: number): string {
  return `(() => {
    const timeout = ${Math.max(1, Math.floor(timeoutMs))};
    const diagrams = () => Array.from(document.querySelectorAll('[data-mm-mermaid="true"]'));
    const ready = () => diagrams().every((diagram) => ["rendered", "failed"].includes(diagram.dataset.mmMermaidState || ""));
    return (async () => {
      if (!ready()) await new Promise((resolve, reject) => {
        const started = Date.now();
        const timer = window.setInterval(() => {
          if (ready()) { window.clearInterval(timer); resolve(); }
          else if (Date.now() - started >= timeout) { window.clearInterval(timer); reject(new Error("Timed out waiting for Mermaid diagrams to render.")); }
        }, 25);
      });
      return diagrams().filter((diagram) => diagram.dataset.mmMermaidState !== "rendered").length;
    })();
  })()`;
}

interface EvaluationResult<T> {
  readonly result?: { readonly value?: T };
  readonly exceptionDetails?: {
    readonly text?: string;
    readonly exception?: { readonly description?: string };
  };
}

async function evaluate<T>(
  client: CdpClient,
  expression: string,
  sessionId: string,
): Promise<T> {
  const response = await client.send<EvaluationResult<T>>(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (response.exceptionDetails)
    throw new Error(
      response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text ??
        "Browser evaluation failed.",
    );
  return response.result?.value as T;
}

function endpointFromOutput(output: string): string | undefined {
  return output.match(/DevTools listening on (ws:\/\/\S+)/)?.[1];
}

function waitForEndpoint(
  process: ChildProcess,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let output = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `Timed out waiting for Chrome DevTools within ${timeoutMs} ms.`,
        ),
      );
    }, timeoutMs);
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const onData = (chunk: Buffer | string): void => {
      output += chunk.toString();
      const endpoint = endpointFromOutput(output);
      if (endpoint) finish(() => resolve(endpoint));
    };
    process.stderr?.on("data", onData);
    process.stdout?.on("data", onData);
    process.once("error", (error) =>
      finish(() =>
        reject(
          error instanceof Error
            ? error
            : new Error("Could not launch browser."),
        ),
      ),
    );
    process.once("exit", (code, signal) =>
      finish(() =>
        reject(
          new Error(
            `Browser exited before DevTools was ready (${code ?? signal ?? "unknown"}).`,
          ),
        ),
      ),
    );
  });
}

async function cleanupProcess(
  process: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return;
  try {
    process.kill("SIGTERM");
  } catch {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(
      () => {
        if (process.exitCode === null && process.signalCode === null) {
          try {
            process.kill("SIGKILL");
          } catch {
            // The process may have exited between the state check and kill.
          }
        }
        resolve();
      },
      Math.min(timeoutMs, 2_000),
    );
    process.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function readPdfStream(
  client: CdpClient,
  handle: string,
  sessionId: string,
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  try {
    let eof = false;
    while (!eof) {
      const response = await client.send<{
        data?: string;
        base64Encoded?: boolean;
        eof?: boolean;
      }>("IO.read", { handle }, sessionId);
      if (response.data)
        chunks.push(
          response.base64Encoded
            ? Buffer.from(response.data, "base64")
            : Buffer.from(response.data),
        );
      eof = response.eof === true;
    }
    return new Uint8Array(Buffer.concat(chunks));
  } finally {
    try {
      await client.send("IO.close", { handle }, sessionId);
    } catch {
      // Closing an already-consumed stream is harmless during cleanup.
    }
  }
}

/** Render standalone HTML with an installed Chrome-family browser over CDP. */
export async function renderPdfWithChrome(
  html: string,
  options: PdfExportOptions,
): Promise<Uint8Array> {
  const timeoutMs = options.timeoutMs ?? PDF_EXPORT_TIMEOUT_MS;
  const profileDirectory = await mkdtemp(
    path.join(os.tmpdir(), "markdown-mint-pdf-"),
  );
  let browserProcess: ChildProcess | undefined;
  let client: CdpClient | undefined;
  let targetId: string | undefined;
  try {
    browserProcess = launchBrowser(
      options.executablePath,
      [
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${profileDirectory}`,
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const endpoint = await waitForEndpoint(browserProcess, timeoutMs);
    client = await createCdpClient(endpoint, { timeoutMs });
    const target = await client.send<{ targetId: string }>(
      "Target.createTarget",
      {
        url: "about:blank",
      },
    );
    targetId = target.targetId;
    const attached = await client.send<{ sessionId: string }>(
      "Target.attachToTarget",
      { targetId, flatten: true },
    );
    const sessionId = attached.sessionId;
    await client.send("Page.enable", {}, sessionId);
    await client.send("Runtime.enable", {}, sessionId);
    const frameTree = await client.send<{
      frameTree: { frame: { id: string } };
    }>("Page.getFrameTree", {}, sessionId);
    await client.send(
      "Page.setDocumentContent",
      { frameId: frameTree.frameTree.frame.id, html },
      sessionId,
    );
    await evaluate<void>(
      client,
      resourceReadinessExpression(timeoutMs),
      sessionId,
    );
    const failedMermaidCount = await evaluate<number>(
      client,
      mermaidReadinessExpression(timeoutMs),
      sessionId,
    );
    if (failedMermaidCount > 0)
      throw new Error(
        `${failedMermaidCount} Mermaid ${failedMermaidCount === 1 ? "diagram" : "diagrams"} could not be rendered for PDF export.`,
      );
    await client.send(
      "Emulation.setEmulatedMedia",
      { media: "print" },
      sessionId,
    );
    const printed = await client.send<{
      stream?: string;
      data?: string;
      base64Encoded?: boolean;
    }>(
      "Page.printToPDF",
      {
        printBackground: true,
        preferCSSPageSize: true,
        transferMode: "ReturnAsStream",
      },
      sessionId,
    );
    if (printed.stream)
      return await readPdfStream(client, printed.stream, sessionId);
    if (printed.data)
      return new Uint8Array(
        Buffer.from(printed.data, printed.base64Encoded ? "base64" : "utf8"),
      );
    throw new Error("Chrome did not return a PDF stream.");
  } finally {
    if (client) {
      if (targetId) {
        try {
          await client.send("Target.closeTarget", { targetId });
        } catch {
          // The browser may already be exiting.
        }
      }
      await client.close().catch(() => undefined);
    }
    if (browserProcess) await cleanupProcess(browserProcess, timeoutMs);
    await rm(profileDirectory, { recursive: true, force: true });
  }
}

export const renderPdf = renderPdfWithChrome;
