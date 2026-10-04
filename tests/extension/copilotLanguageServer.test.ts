import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import type { spawn as SpawnProcess } from "node:child_process";
import {
  CopilotLanguageServer,
  lspPositionToOffset,
  offsetToLspPosition,
  type CopilotLanguageServerOptions,
} from "../../src/extension/copilotLanguageServer";

vi.mock("vscode", () => ({
  version: "1.90.0",
  Uri: {
    parse: (value: string) => ({
      scheme: value.split(":", 1)[0],
      authority: new URL(value).host,
      fsPath: new URL(value).pathname,
    }),
  },
  env: { openExternal: vi.fn(async () => true) },
}));

const temporaryDirectories: string[] = [];

class FakeChild extends EventEmitter {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public exitCode: number | null = null;
  public killed = false;
  public readonly requests: Array<Record<string, any>> = [];
  private outgoing = Buffer.alloc(0);

  public constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => this.read(chunk));
  }
  public kill(): boolean {
    this.killed = true;
    this.exitCode = 0;
    this.emit("exit", 0, null);
    return true;
  }
  public respond(id: number, result: unknown): void {
    this.stdout.write(frame({ jsonrpc: "2.0", id, result }));
  }
  private read(chunk: Buffer): void {
    this.outgoing = Buffer.concat([this.outgoing, chunk]);
    while (true) {
      const end = this.outgoing.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = Number(
        this.outgoing
          .toString("ascii", 0, end)
          .match(/Content-Length: (\d+)/i)?.[1],
      );
      if (this.outgoing.length < end + 4 + length) return;
      const message = JSON.parse(
        this.outgoing.toString("utf8", end + 4, end + 4 + length),
      ) as Record<string, any>;
      this.requests.push(message);
      this.outgoing = this.outgoing.subarray(end + 4 + length);
      if (message.method === "shutdown")
        setTimeout(() => this.respond(message.id, null), 0);
      if (message.method === "exit")
        setTimeout(() => this.emit("exit", 0, null), 0);
    }
  }
}

function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),
    body,
  ]);
}

function cancellationToken() {
  let listener: (() => void) | undefined;
  let cancelled = false;
  return {
    token: {
      get isCancellationRequested() {
        return cancelled;
      },
      onCancellationRequested(callback: () => void) {
        listener = callback;
        return { dispose: vi.fn() };
      },
    } as unknown as vscode.CancellationToken,
    cancel() {
      cancelled = true;
      listener?.();
    },
  };
}

async function setup() {
  const child = new FakeChild();
  const spawnProcess = vi.fn(() => child);
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "copilot-language-server-test-"),
  );
  temporaryDirectories.push(temporaryDirectory);
  const binaryName =
    process.platform === "win32"
      ? "copilot-language-server.exe"
      : "copilot-language-server";
  const binaryPath = join(temporaryDirectory, binaryName);
  await writeFile(binaryPath, "fake native server");
  const options: CopilotLanguageServerOptions = {
    binaryPath,
    extensionVersion: "0.9.0",
    workspaceFolder: () => ({ name: "project", uri: "file:///workspace" }),
    proxy: () => ({ proxy: "", strictSSL: true }),
    onMessage: async (_type, _message, actions) => actions?.[0],
    spawnProcess: spawnProcess as unknown as typeof SpawnProcess,
  };
  const server = new CopilotLanguageServer(options);
  return { server, child, spawnProcess };
}

async function startServer(
  server: CopilotLanguageServer,
  child: FakeChild,
): Promise<void> {
  const starting = server.start();
  await vi.waitFor(() =>
    expect(
      child.requests.find((message) => message.method === "initialize"),
    ).toBeDefined(),
  );
  const initialize = child.requests.find(
    (message) => message.method === "initialize",
  )!;
  child.respond(initialize.id, { capabilities: {} });
  await starting;
}

describe("Copilot Language Server transport", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("initializes once, configures telemetry before synchronizing and focusing the active document", async () => {
    const { server, child, spawnProcess } = await setup();
    await Promise.all([startServer(server, child), server.start()]);
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    const initialize = child.requests.find(
      (message) => message.method === "initialize",
    )!;
    expect(initialize.params.capabilities.general.positionEncodings).toEqual([
      "utf-16",
    ]);
    const configured = child.requests.find(
      (message) => message.method === "workspace/didChangeConfiguration",
    )!;
    expect(configured.params.settings.telemetry.telemetryLevel).toBe("off");
    await server.synchronizeDocument(
      "file:///workspace/日本語.md",
      1,
      "日本語🌿\r\nfirst",
    );
    await server.focusDocument("file:///workspace/日本語.md");
    const methods = child.requests.map((message) => message.method);
    expect(methods.indexOf("initialized")).toBeLessThan(
      methods.indexOf("workspace/didChangeConfiguration"),
    );
    expect(methods.indexOf("workspace/didChangeConfiguration")).toBeLessThan(
      methods.indexOf("textDocument/didOpen"),
    );
    expect(methods.indexOf("textDocument/didOpen")).toBeLessThan(
      methods.indexOf("textDocument/didFocus"),
    );
    await server.disposeAsync();
  });

  it("sends a minimal incremental change and waits for completion responses", async () => {
    const { server, child } = await setup();
    await startServer(server, child);
    const uri = "file:///workspace/prose.md";
    await server.synchronizeDocument(uri, 1, "Hello🌿 world");
    await server.focusDocument(uri);
    await server.synchronizeDocument(uri, 2, "Hello🌿 brave world");
    const change = child.requests.find(
      (message) => message.method === "textDocument/didChange",
    )!;
    expect(change.params.textDocument.version).toBe(2);
    expect(change.params.contentChanges[0].text).toBe("brave ");

    const token = cancellationToken();
    const response = server.requestInlineCompletion(
      uri,
      2,
      { line: 0, character: 18 },
      "manual",
      token.token,
    );
    await vi.waitFor(() =>
      expect(
        child.requests.find(
          (message) => message.method === "textDocument/inlineCompletion",
        ),
      ).toBeDefined(),
    );
    const request = child.requests.find(
      (message) => message.method === "textDocument/inlineCompletion",
    )!;
    expect(request.params.textDocument.version).toBe(2);
    expect(request.params.position).toEqual({ line: 0, character: 18 });
    child.respond(request.id, {
      items: [
        { insertText: "Hello🌿 brave world!" },
        {
          insertText: "second",
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 4 },
          },
        },
      ],
    });
    await expect(response).resolves.toMatchObject({
      items: [{ insertText: "Hello🌿 brave world!" }, { insertText: "second" }],
    });
    await server.disposeAsync();
  });

  it("cancels an in-flight JSON-RPC request and settles it", async () => {
    const { server, child } = await setup();
    await startServer(server, child);
    const uri = "file:///workspace/prose.md";
    await server.synchronizeDocument(uri, 1, "Hello");
    await server.focusDocument(uri);
    const token = cancellationToken();
    const response = server.requestInlineCompletion(
      uri,
      1,
      { line: 0, character: 5 },
      "auto",
      token.token,
    );
    await vi.waitFor(() =>
      expect(
        child.requests.find(
          (message) => message.method === "textDocument/inlineCompletion",
        ),
      ).toBeDefined(),
    );
    token.cancel();
    await expect(response).rejects.toThrow("cancelled");
    expect(
      child.requests.some((message) => message.method === "$/cancelRequest"),
    ).toBe(true);
    await server.disposeAsync();
  });

  it("shows server account or billing actions and returns only a selected safe title", async () => {
    const { server, child } = await setup();
    await startServer(server, child);
    child.stdout.write(
      frame({
        jsonrpc: "2.0",
        id: 91,
        method: "window/showMessageRequest",
        params: {
          type: 3,
          message: "Copilot account notice",
          actions: [{ title: "Manage plan" }],
        },
      }),
    );
    await vi.waitFor(() =>
      expect(child.requests.find((message) => message.id === 91)).toBeDefined(),
    );
    expect(child.requests.find((message) => message.id === 91)).toEqual({
      jsonrpc: "2.0",
      id: 91,
      result: { title: "Manage plan" },
    });

    child.stdout.write(
      frame({
        jsonrpc: "2.0",
        id: 92,
        method: "workspace/executeCommand",
        params: { command: "arbitrary.command", arguments: ["unsafe"] },
      }),
    );
    await vi.waitFor(() =>
      expect(child.requests.find((message) => message.id === 92)).toBeDefined(),
    );
    expect(child.requests.find((message) => message.id === 92)).toMatchObject({
      error: { code: -32601 },
    });
    await server.disposeAsync();
  });

  it("executes the official device-flow command only after the user confirms", async () => {
    const { server, child } = await setup();
    await startServer(server, child);
    const signIn = server.signInFromUserAction(async (code) => {
      expect(code).toBe("ABCD-EFGH");
      return true;
    });
    await vi.waitFor(() =>
      expect(
        child.requests.find((message) => message.method === "signIn"),
      ).toBeDefined(),
    );
    const signInRequest = child.requests.find(
      (message) => message.method === "signIn",
    )!;
    child.respond(signInRequest.id, {
      userCode: "ABCD-EFGH",
      command: { command: "github.copilot.finishDeviceFlow", arguments: [] },
    });
    await vi.waitFor(() =>
      expect(
        child.requests.find(
          (message) => message.method === "workspace/executeCommand",
        ),
      ).toBeDefined(),
    );
    const action = child.requests.find(
      (message) => message.method === "workspace/executeCommand",
    )!;
    expect(action.params).toEqual({
      command: "github.copilot.finishDeviceFlow",
      arguments: [],
    });
    child.respond(action.id, null);
    await expect(signIn).resolves.toBe(true);
    await server.disposeAsync();
  });

  it("releases the pending request when the server disconnects", async () => {
    const { server, child } = await setup();
    await startServer(server, child);
    const uri = "file:///workspace/prose.md";
    await server.synchronizeDocument(uri, 1, "Hello");
    await server.focusDocument(uri);
    const response = server.requestInlineCompletion(
      uri,
      1,
      { line: 0, character: 5 },
      "manual",
      cancellationToken().token,
    );
    await vi.waitFor(() =>
      expect(
        child.requests.find(
          (message) => message.method === "textDocument/inlineCompletion",
        ),
      ).toBeDefined(),
    );
    child.emit("exit", 1, null);
    await expect(response).rejects.toThrow("exited");
    expect(server.isRunning).toBe(false);
  });

  it("converts CRLF and astral Unicode positions as UTF-16", () => {
    const text = "A🌿\r\nB";
    expect(offsetToLspPosition(text, 3)).toEqual({ line: 0, character: 3 });
    expect(offsetToLspPosition(text, 5)).toEqual({ line: 1, character: 0 });
    expect(
      lspPositionToOffset(text, { line: 0, character: 2 }),
    ).toBeUndefined();
    expect(lspPositionToOffset(text, { line: 1, character: 1 })).toBe(6);
  });
});
