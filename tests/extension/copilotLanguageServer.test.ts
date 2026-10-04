import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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
  waitForChildExit,
  type CopilotWorkspaceFolder,
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

interface FakeServerMessage {
  readonly method?: string;
  readonly params?: {
    readonly textDocument?: {
      readonly uri?: string;
      readonly version?: number;
      readonly text?: string;
    };
    readonly contentChanges?: readonly {
      readonly range?: {
        readonly start: { readonly line: number; readonly character: number };
        readonly end: { readonly line: number; readonly character: number };
      };
      readonly text: string;
    }[];
  };
}

class FakeChild extends EventEmitter {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public exitCode: number | null = null;
  public signalCode: NodeJS.Signals | null = null;
  public pid: number | undefined = 123;
  public killed = false;
  public ignoreShutdownResponse = false;
  public ignoreExitNotification = false;
  public ignoreSigterm = false;
  public ignoreSigkill = false;
  public readonly killSignals: Array<NodeJS.Signals | undefined> = [];
  public readonly requests: Array<Record<string, any>> = [];
  public readonly documents = new Map<
    string,
    { version: number; text: string }
  >();
  private outgoing = Buffer.alloc(0);

  public constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => this.read(chunk));
  }
  public kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.killSignals.push(signal);
    if (
      (signal === "SIGTERM" && this.ignoreSigterm) ||
      (signal === "SIGKILL" && this.ignoreSigkill)
    )
      return true;
    this.completeExit(null, signal ?? "SIGTERM");
    return true;
  }
  public completeExit(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.pid = undefined;
    this.emit("exit", code, signal);
    queueMicrotask(() => this.emit("close", code, signal));
  }
  public hasExited(): boolean {
    return this.exitCode !== null || this.signalCode !== null;
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
      this.applyDocumentMessage(message);
      if (message.method === "shutdown" && !this.ignoreShutdownResponse)
        setTimeout(() => this.respond(message.id, null), 0);
      if (message.method === "exit" && !this.ignoreExitNotification)
        setTimeout(() => this.completeExit(0, null), 0);
    }
  }
  private applyDocumentMessage(message: Record<string, unknown>): void {
    const typed = message as unknown as FakeServerMessage;
    const params = typed.params;
    if (!params) return;
    const textDocument = params.textDocument;
    const uri = textDocument?.uri;
    if (typeof uri !== "string") return;
    if (typed.method === "textDocument/didOpen") {
      if (
        typeof textDocument?.version !== "number" ||
        typeof textDocument.text !== "string"
      )
        throw new Error("didOpen did not include a valid document snapshot.");
      this.documents.set(uri, {
        version: textDocument.version,
        text: textDocument.text,
      });
    } else if (typed.method === "textDocument/didChange") {
      const document = this.documents.get(uri);
      if (!document) throw new Error("didChange arrived before didOpen.");
      let text: string = document.text;
      for (const change of params.contentChanges ?? []) {
        if (!change.range) {
          text = change.text;
          continue;
        }
        const start = fakeServerOffset(text, change.range.start);
        const end = fakeServerOffset(text, change.range.end);
        if (start === undefined || end === undefined || end < start)
          throw new Error("Invalid LSP range in didChange.");
        text = text.slice(0, start) + change.text + text.slice(end);
      }
      const version = textDocument?.version;
      if (typeof version !== "number")
        throw new Error("didChange did not include a version.");
      this.documents.set(uri, { version, text });
    } else if (typed.method === "textDocument/didClose") {
      this.documents.delete(uri);
    }
  }
}

function fakeServerOffset(
  text: string,
  position: { line: number; character: number },
): number | undefined {
  let line = 0;
  let start = 0;
  while (line < position.line) {
    let next = start;
    while (next < text.length && text[next] !== "\r" && text[next] !== "\n")
      next += 1;
    if (next === text.length) return undefined;
    if (text[next] === "\r" && text[next + 1] === "\n") next += 2;
    else next += 1;
    start = next;
    line += 1;
  }
  let end = start;
  while (end < text.length && text[end] !== "\r" && text[end] !== "\n")
    end += 1;
  const offset = start + position.character;
  if (
    position.character > end - start ||
    (text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff)
  )
    return undefined;
  return offset;
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

async function setup(
  workspaceFolders: readonly CopilotWorkspaceFolder[] = [
    { name: "project", uri: "file:///workspace" },
  ],
) {
  const child = new FakeChild();
  const children = [child];
  let spawnCount = 0;
  const spawnProcess = vi.fn(() => {
    const next = children[spawnCount];
    if (!next) throw new Error("No fake child was queued for spawn.");
    spawnCount += 1;
    return next;
  });
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
    workspaceFolder: (documentUri) =>
      workspaceFolders.find((folder) =>
        documentUri?.startsWith(`${folder.uri}/`),
      ) ?? (workspaceFolders.length === 1 ? workspaceFolders[0] : undefined),
    workspaceFolders: () => workspaceFolders,
    proxy: () => ({ proxy: "", strictSSL: true }),
    onMessage: async (_type, _message, actions) => actions?.[0],
    spawnProcess: spawnProcess as unknown as typeof SpawnProcess,
  };
  const server = new CopilotLanguageServer(options);
  return {
    server,
    child,
    spawnProcess,
    createNextChild: () => {
      const next = new FakeChild();
      children.push(next);
      return next;
    },
  };
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

  it("makes concurrent start and document/sign-in operations wait for initialized", async () => {
    const { server, child } = await setup();
    const first = server.start();
    await vi.waitFor(() =>
      expect(
        child.requests.find((message) => message.method === "initialize"),
      ).toBeDefined(),
    );
    let secondSettled = false;
    const second = server.start().then(() => {
      secondSettled = true;
    });
    const documentOpen = server.synchronizeDocument(
      "file:///workspace/pending.md",
      1,
      "Pending",
    );
    const signIn = server.signInFromUserAction(async () => false);
    await Promise.resolve();
    await Promise.resolve();

    expect(secondSettled).toBe(false);
    expect(
      child.requests.some((message) =>
        ["textDocument/didOpen", "signIn"].includes(message.method),
      ),
    ).toBe(false);

    const initialize = child.requests.find(
      (message) => message.method === "initialize",
    )!;
    child.respond(initialize.id, {
      capabilities: { positionEncoding: "utf-16" },
    });
    await Promise.all([first, second, documentOpen]);
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
    await expect(signIn).resolves.toBe(false);

    const methods = child.requests.map((message) => message.method);
    expect(methods.indexOf("initialized")).toBeLessThan(
      methods.indexOf("textDocument/didOpen"),
    );
    expect(methods.indexOf("workspace/didChangeConfiguration")).toBeLessThan(
      methods.indexOf("textDocument/didOpen"),
    );
    await server.disposeAsync();
  });

  it("does not open a document when its synchronization becomes stale during startup", async () => {
    const { server, child } = await setup();
    let currentVersion = 1;
    const synchronizing = server.synchronizeAndFocusDocument(
      "file:///workspace/A.md",
      1,
      "A body",
      () => currentVersion === 1,
    );
    await vi.waitFor(() =>
      expect(
        child.requests.find((message) => message.method === "initialize"),
      ).toBeDefined(),
    );
    currentVersion = 2;
    const initialize = child.requests.find(
      (message) => message.method === "initialize",
    )!;
    child.respond(initialize.id, { capabilities: {} });

    await expect(synchronizing).resolves.toBe(false);
    expect(
      child.requests.some(
        (message) =>
          message.method === "textDocument/didOpen" &&
          message.params?.textDocument?.uri === "file:///workspace/A.md",
      ),
    ).toBe(false);
    expect(child.documents.size).toBe(0);
    await server.disposeAsync();
  });

  it("closes all old documents on a current-target switch and clears the last one", async () => {
    const { server, child } = await setup();
    await startServer(server, child);

    await expect(
      server.synchronizeAndFocusDocument(
        "file:///workspace/A.md",
        7,
        "A body",
        () => true,
      ),
    ).resolves.toBe(true);
    await expect(
      server.synchronizeAndFocusDocument(
        "file:///workspace/B.md",
        12,
        "B body",
        () => true,
      ),
    ).resolves.toBe(true);

    expect([...child.documents.entries()]).toEqual([
      ["file:///workspace/B.md", { version: 12, text: "B body" }],
    ]);
    const methods = child.requests.map((message) => message.method);
    expect(methods.indexOf("textDocument/didOpen")).toBeLessThan(
      methods.indexOf("textDocument/didFocus"),
    );
    expect(
      child.requests.some(
        (message) =>
          message.method === "textDocument/didClose" &&
          message.params?.textDocument?.uri === "file:///workspace/A.md",
      ),
    ).toBe(true);
    const focusB = child.requests.findIndex(
      (message) =>
        message.method === "textDocument/didFocus" &&
        message.params?.textDocument?.uri === "file:///workspace/B.md",
    );
    const closeA = child.requests.findIndex(
      (message) =>
        message.method === "textDocument/didClose" &&
        message.params?.textDocument?.uri === "file:///workspace/A.md",
    );
    expect(closeA).toBeLessThan(focusB);

    await server.focusDocument(undefined, () => true);
    expect(child.documents.size).toBe(0);
    expect(server.focusedDocumentUri).toBeUndefined();
    expect(
      child.requests.some(
        (message) =>
          message.method === "textDocument/didClose" &&
          message.params?.textDocument?.uri === "file:///workspace/B.md",
      ),
    ).toBe(true);
    await server.disposeAsync();
  });

  it("rejects stale cleanup for an old owner of a URI now owned by another panel", async () => {
    const { server, child } = await setup();
    await startServer(server, child);
    const uri = "file:///workspace/shared.md";
    await server.synchronizeAndFocusDocument(uri, 3, "Shared", () => true);

    let oldOwnerCurrent = true;
    const staleCleanup = server.focusDocument(undefined, () => oldOwnerCurrent);
    oldOwnerCurrent = false;
    await server.synchronizeAndFocusDocument(uri, 3, "Shared", () => true);
    await staleCleanup;

    expect([...child.documents.keys()]).toEqual([uri]);
    expect(
      child.requests.some(
        (message) =>
          message.method === "textDocument/didClose" &&
          message.params?.textDocument?.uri === uri,
      ),
    ).toBe(false);
    await server.disposeAsync();
  });

  it("rejects an initialize response that selects an unsupported position encoding", async () => {
    const { server, child } = await setup();
    const starting = server.start();
    const result = expect(starting).rejects.toThrow(/position encoding/i);
    try {
      await vi.waitFor(() =>
        expect(
          child.requests.find((message) => message.method === "initialize"),
        ).toBeDefined(),
      );
      const initialize = child.requests.find(
        (message) => message.method === "initialize",
      )!;
      child.respond(initialize.id, {
        capabilities: { positionEncoding: "utf-8" },
      });
      await result;
    } finally {
      await server.disposeAsync();
    }
  });

  it("does not overwrite a Normal status delivered with the initialize response", async () => {
    const { server, child } = await setup();
    const starting = server.start();
    await vi.waitFor(() =>
      expect(
        child.requests.find((message) => message.method === "initialize"),
      ).toBeDefined(),
    );
    const initialize = child.requests.find(
      (message) => message.method === "initialize",
    )!;
    child.stdout.write(
      Buffer.concat([
        frame({
          jsonrpc: "2.0",
          id: initialize.id,
          result: { capabilities: { positionEncoding: "utf-16" } },
        }),
        frame({
          jsonrpc: "2.0",
          method: "didChangeStatus",
          params: { kind: "Normal", busy: false, message: "Ready" },
        }),
      ]),
    );
    await starting;

    expect(server.currentStatus).toMatchObject({ kind: "Normal", busy: false });
    await server.disposeAsync();
  });

  it("sends all workspace folders and starts from the target document's folder", async () => {
    const folders = [
      { name: "first", uri: "file:///first" },
      { name: "second", uri: "file:///second" },
    ];
    const { server, child, spawnProcess } = await setup(folders);
    const starting = server.start("file:///second/notes/prose.md");
    await vi.waitFor(() =>
      expect(
        child.requests.find((message) => message.method === "initialize"),
      ).toBeDefined(),
    );
    const initialize = child.requests.find(
      (message) => message.method === "initialize",
    )!;
    expect(initialize.params.workspaceFolders).toEqual(folders);
    expect(initialize.params.rootUri).toBeNull();
    const spawnArgs = spawnProcess.mock.calls[0] as unknown as [
      string,
      string[],
      { readonly cwd?: string },
    ];
    expect(spawnArgs[2].cwd).toBe("/second");
    child.respond(initialize.id, {
      capabilities: { positionEncoding: "utf-16" },
    });
    await starting;
    await server.disposeAsync();
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

  it("keeps every incremental didChange exact across line-ending and Unicode edits", async () => {
    const { server, child } = await setup();
    await startServer(server, child);
    let uri = "file:///workspace/line-endings-0.md";
    const pairs: Array<[string, string]> = [
      ["abc\r\ndef", "abc\ndef"],
      ["abc\ndef", "abc\r\ndef"],
      ["one\r\ntwo", "ONE\r\ntwo"],
      ["a\r\nb\r\nc", "A\r\nB\r\nC"],
      ["end\r\n", "end\n"],
      ["one\n\nthree", "one\r\n\r\nthree"],
      ["one\r\ntwo", "onetwo"],
      ["a\r\nb\nc\r\nd", "a\nb\r\nc\nd"],
      ["日本語🌿\r\n後", "日本語🌱\n後ろ"],
      ["a\r\nb", "xa\r\nb"],
      ["xa\r\nb", "a\r\nb"],
    ];
    for (let mask = 0; mask < 8; mask += 1) {
      const pieces = ["前🌿", "中日", "後文"];
      const oldEndings = [
        mask & 1 ? "\r\n" : "\n",
        mask & 2 ? "\r\n" : "\n",
        mask & 4 ? "\r\n" : "",
      ];
      const newEndings = [
        mask & 2 ? "\n" : "\r\n",
        mask & 1 ? "\n" : "\r\n",
        mask & 4 ? "\n" : "",
      ];
      pairs.push([
        pieces[0]! +
          oldEndings[0]! +
          pieces[1]! +
          oldEndings[1]! +
          pieces[2]! +
          oldEndings[2]!,
        pieces[0]! +
          newEndings[0]! +
          pieces[1]! +
          newEndings[1]! +
          pieces[2]! +
          newEndings[2]!,
      ]);
    }
    let version = 2;
    let current = "";
    for (const [index, [previous, next]] of pairs.entries()) {
      uri = `file:///workspace/line-endings-${index}.md`;
      await server.synchronizeDocument(uri, 1, previous);
      await server.focusDocument(uri);
      expect(child.documents.get(uri)).toEqual({ version: 1, text: previous });
      await server.synchronizeDocument(uri, 2, next);
      expect(child.documents.get(uri)).toEqual({ version: 2, text: next });
      current = next;
    }

    const cursor = offsetToLspPosition(current, current.length);
    const response = server.requestInlineCompletion(
      uri,
      version,
      cursor,
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
    const request = child.requests.find(
      (message) => message.method === "textDocument/inlineCompletion",
    )!;
    expect(child.documents.get(uri)).toEqual({ version, text: current });
    expect(request.params.textDocument.version).toBe(version);
    expect(request.params.position).toEqual(cursor);
    child.respond(request.id, { items: [] });
    await expect(response).resolves.toEqual({ items: [] });
    await server.disposeAsync();
  });

  it("does not encode an offset between CR and LF as an LSP character", () => {
    expect(() => offsetToLspPosition("abc\r\ndef", 4)).toThrow(RangeError);
    expect(() => offsetToLspPosition("A🌿", 2)).toThrow(RangeError);
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
    child.completeExit(1, null);
    await expect(response).rejects.toThrow("exited");
    expect(server.isRunning).toBe(false);
  });

  it("terminates and releases a live child after malformed JSON", async () => {
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

    child.stdout.write(Buffer.from("Content-Length: 1\r\n\r\n{"));
    await expect(response).rejects.toThrow(/invalid json/i);
    await vi.waitFor(() => expect(child.hasExited()).toBe(true), {
      timeout: 2_500,
    });
    expect(server.isRunning).toBe(false);
    expect(child.listenerCount("exit")).toBe(0);
    await server.disposeAsync();
  });

  it("terminates and releases a live child after an oversized frame", async () => {
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

    child.stdout.write(
      Buffer.from("Content-Length: 33554433\r\n\r\n", "ascii"),
    );
    await expect(response).rejects.toThrow(/invalid message frame/i);
    await vi.waitFor(() => expect(child.hasExited()).toBe(true), {
      timeout: 2_500,
    });
    expect(server.isRunning).toBe(false);
    expect(child.listenerCount("exit")).toBe(0);
    await server.disposeAsync();
  });

  it("handles stdin, stdout, and stderr errors without leaking a request or process", async () => {
    for (const streamName of ["stdin", "stdout", "stderr"] as const) {
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

      child[streamName].emit("error", new Error(`${streamName} failed`));
      await expect(response).rejects.toThrow(`${streamName} failed`);
      await vi.waitFor(() => expect(child.hasExited()).toBe(true), {
        timeout: 2_500,
      });
      expect(server.isRunning).toBe(false);
      expect(child.listenerCount("exit")).toBe(0);
      await server.disposeAsync();
    }
  }, 10_000);

  it("ignores events from a failed child after restarting the server", async () => {
    const { server, child: oldChild, createNextChild } = await setup();
    await startServer(server, oldChild);
    oldChild.stdout.write(Buffer.from("Content-Length: 1\r\n\r\n{"));
    await vi.waitFor(() => expect(oldChild.hasExited()).toBe(true), {
      timeout: 2_500,
    });

    const child = createNextChild();
    const starting = server.start();
    await vi.waitFor(() =>
      expect(
        child.requests.find((message) => message.method === "initialize"),
      ).toBeDefined(),
    );
    const initialize = child.requests.find(
      (message) => message.method === "initialize",
    )!;
    child.respond(initialize.id, {
      capabilities: { positionEncoding: "utf-16" },
    });
    await starting;
    const readyStatus = server.currentStatus;
    oldChild.stdout.write(
      frame({
        jsonrpc: "2.0",
        method: "didChangeStatus",
        params: { kind: "Error", busy: false, message: "stale child" },
      }),
    );
    oldChild.completeExit(1, null);
    expect(server.currentStatus).toEqual(readyStatus);
    expect(server.isRunning).toBe(true);

    const uri = "file:///workspace/restarted.md";
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
    const completion = child.requests.find(
      (message) => message.method === "textDocument/inlineCompletion",
    )!;
    child.respond(completion.id, { items: [{ insertText: "Hello!" }] });
    await expect(response).resolves.toMatchObject({
      items: [{ insertText: "Hello!" }],
    });
    await server.disposeAsync();
  });

  it("finishes disposal after SIGTERM without escalating to SIGKILL", async () => {
    const { server, child } = await setup();
    await startServer(server, child);
    child.ignoreShutdownResponse = true;
    child.ignoreExitNotification = true;

    await server.disposeAsync();

    expect(child.killSignals).toEqual(["SIGTERM"]);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBe("SIGTERM");
    expect(child.listenerCount("exit")).toBe(0);
  }, 5_000);

  it("recognizes an already signaled child before registering exit listeners", async () => {
    const child = new FakeChild();
    child.completeExit(null, "SIGTERM");
    await expect(waitForChildExit(child as never, 50)).resolves.toBe(true);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBe("SIGTERM");
  });

  it("settles child waits on spawn errors and close without an exit event", async () => {
    const spawnFailure = new FakeChild();
    spawnFailure.pid = undefined;
    const failed = waitForChildExit(spawnFailure as never, 100);
    spawnFailure.emit("error", new Error("spawn failed"));
    await expect(failed).resolves.toBe(true);

    const closed = new FakeChild();
    const closing = waitForChildExit(closed as never, 100);
    closed.emit("error", new Error("process error"));
    closed.emit("close", null, null);
    await expect(closing).resolves.toBe(true);
  });

  it("releases a server start whose child fails to spawn", async () => {
    const { server, child } = await setup();
    child.pid = undefined;
    const starting = server.start();
    await vi.waitFor(() =>
      expect(
        child.requests.find((message) => message.method === "initialize"),
      ).toBeDefined(),
    );
    child.emit("error", new Error("spawn ENOENT"));

    await expect(starting).rejects.toThrow("spawn ENOENT");
    await server.disposeAsync();
    expect(server.isRunning).toBe(false);
    expect(child.listenerCount("exit")).toBe(0);
  });

  it("bounds shutdown and reports when a SIGKILL exit cannot be confirmed", async () => {
    const { server, child } = await setup();
    await startServer(server, child);
    child.ignoreShutdownResponse = true;
    child.ignoreExitNotification = true;
    child.ignoreSigterm = true;
    child.ignoreSigkill = true;

    await server.disposeAsync();

    expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(server.currentStatus.message).toMatch(
      /shutdown could not be confirmed/i,
    );
    expect(child.listenerCount("exit")).toBe(0);
  }, 5_000);

  it("observes SIGTERM from a real Node child process", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: ["pipe", "pipe", "pipe"] },
    ) as ChildProcessWithoutNullStreams;
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      const waiting = waitForChildExit(child, 3_000);
      expect(child.kill("SIGTERM")).toBe(true);
      await expect(waiting).resolves.toBe(true);
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBe("SIGTERM");
      await expect(waitForChildExit(child, 50)).resolves.toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForChildExit(child, 1_000);
      }
    }
  }, 5_000);

  it("escalates past unresponsive shutdown and SIGTERM and shares double disposal", async () => {
    const { server, child } = await setup();
    await startServer(server, child);
    child.ignoreShutdownResponse = true;
    child.ignoreExitNotification = true;
    child.ignoreSigterm = true;
    const first = server.disposeAsync();
    let secondSettled = false;
    const second = server.disposeAsync().then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    await Promise.all([first, second]);
    expect(child.hasExited()).toBe(true);
    expect(child.killSignals).toContain("SIGTERM");
    expect(child.killSignals).toContain("SIGKILL");
    expect(child.listenerCount("exit")).toBe(0);
  }, 7_000);

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
