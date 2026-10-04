import * as vscode from "vscode";
import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";

export const COPILOT_LANGUAGE_SERVER_VERSION = "1.551.2";
export const COPILOT_LANGUAGE_SERVER_REPOSITORY =
  "https://github.com/github/copilot-language-server-release";

export type CopilotServerKind = "Normal" | "Error" | "Warning" | "Inactive";
export interface CopilotServerStatus {
  readonly kind: CopilotServerKind;
  readonly busy: boolean;
  readonly message: string;
  readonly actionTitle?: string;
  readonly documentUri?: string;
}
export interface CopilotWorkspaceFolder {
  readonly name: string;
  readonly uri: string;
}
export interface CopilotLanguageServerOptions {
  readonly binaryPath: string;
  readonly extensionVersion: string;
  readonly workspaceFolder: (
    documentUri?: string,
  ) => CopilotWorkspaceFolder | undefined;
  readonly workspaceFolders?: () => readonly CopilotWorkspaceFolder[];
  readonly proxy: () => { proxy: string; strictSSL: boolean };
  readonly onStatus?: (status: CopilotServerStatus) => void;
  readonly onMessage?: (
    type: number,
    message: string,
    actions?: readonly string[],
  ) => PromiseLike<string | undefined> | string | undefined;
  readonly spawnProcess?: typeof spawn;
  readonly now?: () => number;
}

export interface LspPosition {
  readonly line: number;
  readonly character: number;
}
export interface LspRange {
  readonly start: LspPosition;
  readonly end: LspPosition;
}
export interface InlineCompletionCommand {
  readonly title?: string;
  readonly command: string;
  readonly arguments?: readonly unknown[];
}
export interface InlineCompletionItem {
  readonly insertText: string;
  readonly range?: LspRange;
  readonly insertTextFormat?: number;
  readonly command?: InlineCompletionCommand;
}
export interface InlineCompletionResult {
  readonly items: readonly InlineCompletionItem[];
}

interface RpcMessage {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}
interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly disposeCancellation?: vscode.Disposable;
}
interface ServerDocument {
  readonly uri: string;
  version: number;
  text: string;
  readonly languageId: string;
}

const MAX_RPC_MESSAGE_BYTES = 32 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const MAX_STATUS_TEXT = 512;
const MAX_SERVER_MESSAGE = 1_024;
const SERVER_REQUEST_TIMEOUT_MS = 30_000;
const EXECUTABLE_NAME = "copilot-language-server";
const FAILED_PROCESS_TERM_GRACE_MS = 500;
const DISPOSE_TERM_GRACE_MS = 500;
const FINAL_PROCESS_EXIT_MS = 1_000;

interface ChildListeners {
  readonly generation: number;
  readonly onData: (chunk: Buffer | string) => void;
  readonly onStderr: () => void;
  readonly onError: (error: Error) => void;
  readonly onStreamError: (error: Error) => void;
  readonly onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  readonly onClose: (
    code: number | null,
    signal: NodeJS.Signals | null,
  ) => void;
}

const completedChildren = new WeakSet<ChildProcess>();

/**
 * Owns one official Copilot Language Server process and its stdio LSP
 * connection. Only the active Markdown document is synchronized. The host
 * never forwards arbitrary server commands to VS Code.
 */
export class CopilotLanguageServer implements vscode.Disposable {
  private child: ChildProcessWithoutNullStreams | undefined;
  private generation = 0;
  private readonly ownedChildren = new Set<ChildProcessWithoutNullStreams>();
  private readonly childListeners = new Map<
    ChildProcessWithoutNullStreams,
    ChildListeners
  >();
  private readonly cleanupPromises = new Map<
    ChildProcessWithoutNullStreams,
    Promise<boolean>
  >();
  private buffer = Buffer.alloc(0);
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly documents = new Map<string, ServerDocument>();
  private focusedUri: string | undefined;
  private startPromise: Promise<void> | undefined;
  private initialized = false;
  private statusRevision = 0;
  private disposed = false;
  private disposePromise: Promise<void> | undefined;
  private status: CopilotServerStatus = {
    kind: "Warning",
    busy: false,
    message: "Copilot Language Server is not running.",
  };

  constructor(private readonly options: CopilotLanguageServerOptions) {}

  public get currentStatus(): CopilotServerStatus {
    return this.status;
  }

  public get isRunning(): boolean {
    return this.child !== undefined && !this.disposed;
  }
  public get focusedDocumentUri(): string | undefined {
    return this.focusedUri;
  }

  public async start(documentUri?: string): Promise<void> {
    if (this.disposed) throw new Error("Copilot Language Server is disposed.");
    if (this.initialized && this.child) return;
    if (this.startPromise) return this.startPromise;
    const starting = this.startInternal(documentUri);
    this.startPromise = starting;
    try {
      await starting;
    } finally {
      if (this.startPromise === starting) this.startPromise = undefined;
    }
  }

  private async startInternal(documentUri?: string): Promise<void> {
    const binaryPath = this.options.binaryPath;
    if (
      !binaryPath ||
      basename(binaryPath, process.platform === "win32" ? ".exe" : "") !==
        EXECUTABLE_NAME ||
      !existsSync(binaryPath)
    ) {
      throw new Error("The packaged Copilot Language Server is unavailable.");
    }

    this.setStatus({
      kind: "Warning",
      busy: true,
      message: "Starting Copilot Language Server…",
    });
    const statusRevision = this.statusRevision;
    const configuredFolders = this.options.workspaceFolders?.() ?? [];
    const folder =
      this.options.workspaceFolder(documentUri) ??
      configuredFolders
        .filter((candidate) =>
          uriBelongsToWorkspace(documentUri, candidate.uri),
        )
        .sort((left, right) => right.uri.length - left.uri.length)[0] ??
      (configuredFolders.length === 1 ? configuredFolders[0] : undefined);
    const workspaceFolders = configuredFolders.length
      ? configuredFolders
      : folder
        ? [folder]
        : [];
    const cwd = folder?.uri.startsWith("file:")
      ? vscode.Uri.parse(folder.uri).fsPath
      : dirname(binaryPath);
    const processFactory = this.options.spawnProcess ?? spawn;
    const child = processFactory(binaryPath, ["--stdio"], {
      cwd,
      env: languageServerEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    const generation = ++this.generation;
    this.ownedChildren.add(child);
    this.buffer = Buffer.alloc(0);
    const listeners: ChildListeners = {
      generation,
      onData: (chunk) => {
        if (this.isCurrentChild(child, generation))
          this.receive(chunk, child, generation);
      },
      // Drain stderr to avoid blocking the server. Copilot logs are deliberately
      // discarded rather than retained in an OutputChannel or a file.
      onStderr: () => undefined,
      onError: (error) => this.handleChildError(child, generation, error),
      onStreamError: (error) => this.fail(error, child, generation),
      onExit: (code, signal) =>
        this.handleChildExit(child, generation, code, signal),
      onClose: (code, signal) =>
        this.handleChildClose(child, generation, code, signal),
    };
    this.childListeners.set(child, listeners);
    child.stdout.on("data", listeners.onData);
    child.stderr.on("data", listeners.onStderr);
    child.stdin.on("error", listeners.onStreamError);
    child.stdout.on("error", listeners.onStreamError);
    child.stderr.on("error", listeners.onStreamError);
    child.on("error", listeners.onError);
    child.on("exit", listeners.onExit);
    child.on("close", listeners.onClose);

    try {
      const initialized = await this.request("initialize", {
        processId: process.pid,
        rootUri:
          workspaceFolders.length === 1 ? workspaceFolders[0]?.uri : null,
        workspaceFolders: workspaceFolders.length ? workspaceFolders : null,
        capabilities: {
          general: { positionEncodings: ["utf-16"] },
          window: { showDocument: { support: true }, workDoneProgress: true },
          workspace: {
            configuration: true,
            workspaceFolders: true,
            applyEdit: false,
          },
          textDocument: {
            synchronization: {
              dynamicRegistration: false,
              willSave: false,
              willSaveWaitUntil: false,
              didSave: false,
            },
            inlineCompletion: { dynamicRegistration: false },
          },
        },
        initializationOptions: {
          editorInfo: { name: "Visual Studio Code", version: vscode.version },
          editorPluginInfo: {
            name: "Markdown Mint",
            version: this.options.extensionVersion,
          },
        },
      });
      if (!isRecord(initialized))
        throw new Error(
          "Copilot Language Server returned invalid initialization data.",
        );
      const capabilities = isRecord(initialized.capabilities)
        ? initialized.capabilities
        : {};
      if (
        capabilities.positionEncoding !== undefined &&
        capabilities.positionEncoding !== "utf-16"
      )
        throw new Error(
          "Copilot Language Server selected an unsupported position encoding.",
        );

      // LSP requires initialized to be the next client message after initialize.
      this.notify("initialized", {});
      const proxy = this.options.proxy();
      this.notify("workspace/didChangeConfiguration", {
        settings: {
          telemetry: { telemetryLevel: "off" },
          http: {
            proxy: proxy.proxy,
            proxyStrictSSL: proxy.strictSSL,
          },
        },
      });
      if (this.statusRevision === statusRevision)
        this.setStatus({
          kind: "Warning",
          busy: true,
          message: "Checking Copilot sign-in status…",
        });
      this.initialized = true;
    } catch (error) {
      this.fail(
        error instanceof Error
          ? error
          : new Error("Copilot Language Server initialization failed."),
        child,
        generation,
      );
      throw error;
    }
  }

  public async signInFromUserAction(
    presentCode: (code: string) => Promise<boolean>,
  ): Promise<boolean> {
    await this.start();
    const response = await this.request("signIn", {});
    if (!isRecord(response))
      throw new Error("Copilot sign-in response was invalid.");
    const userCode = boundedString(response.userCode, 32);
    const command = validateDeviceFlowCommand(response.command);
    if (!userCode || !command)
      throw new Error("Copilot returned an unsupported sign-in action.");
    if (!(await presentCode(userCode))) return false;
    await this.request("workspace/executeCommand", command);
    return true;
  }

  public async synchronizeDocument(
    uri: string,
    version: number,
    text: string,
    languageId = "markdown",
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    await this.start(uri);
    if (!isCurrent()) return;
    this.validateDocumentSnapshot(uri, version, text);
    if (!isCurrent()) return;
    this.synchronizeDocumentStarted(uri, version, text, languageId, isCurrent);
  }

  /** Synchronize and focus the active document without yielding between sends. */
  public async synchronizeAndFocusDocument(
    uri: string,
    version: number,
    text: string,
    isCurrent: () => boolean,
  ): Promise<boolean> {
    await this.start(uri);
    if (!isCurrent()) return false;
    this.validateDocumentSnapshot(uri, version, text);
    if (!isCurrent()) return false;
    this.synchronizeDocumentStarted(uri, version, text, "markdown", isCurrent);
    if (!isCurrent()) return false;
    return this.focusDocumentStarted(uri, isCurrent);
  }

  private validateDocumentSnapshot(
    uri: string,
    version: number,
    text: string,
  ): void {
    if (
      !isSafeDocumentUri(uri) ||
      !Number.isSafeInteger(version) ||
      version < 1 ||
      Buffer.byteLength(text, "utf8") > MAX_DOCUMENT_BYTES
    )
      throw new Error(
        "The Markdown document is outside the supported LSP bounds.",
      );
  }

  private synchronizeDocumentStarted(
    uri: string,
    version: number,
    text: string,
    languageId: string,
    isCurrent: () => boolean = () => true,
  ): void {
    if (!isCurrent()) return;
    const open = this.documents.get(uri);
    if (!open) {
      if (!isCurrent()) return;
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId, version, text },
      });
      this.documents.set(uri, { uri, languageId, version, text });
      return;
    }
    if (open.version === version && open.text === text) return;
    if (version <= open.version)
      throw new Error("The Copilot document version did not advance.");
    const change = minimalTextChange(open.text, text);
    if (!isCurrent()) return;
    this.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ range: change.range, text: change.text }],
    });
    open.version = version;
    open.text = text;
  }

  public async focusDocument(
    uri: string | undefined,
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    await this.start(uri);
    if (!isCurrent()) return;
    if (uri !== undefined && !this.documents.has(uri))
      throw new Error("The focused Copilot document has not been opened.");
    this.focusDocumentStarted(uri, isCurrent);
  }

  private focusDocumentStarted(
    uri: string | undefined,
    isCurrent: () => boolean,
  ): boolean {
    if (!this.closeDocumentsExcept(uri, isCurrent)) return false;
    if (!isCurrent()) return false;
    if (this.focusedUri === uri) return true;
    if (!isCurrent()) return false;
    this.notify("textDocument/didFocus", uri ? { textDocument: { uri } } : {});
    this.focusedUri = uri;
    return true;
  }

  private closeDocumentsExcept(
    uri: string | undefined,
    isCurrent: () => boolean,
  ): boolean {
    for (const documentUri of [...this.documents.keys()]) {
      if (documentUri === uri) continue;
      if (!isCurrent()) return false;
      this.notify("textDocument/didClose", {
        textDocument: { uri: documentUri },
      });
      this.documents.delete(documentUri);
    }
    return isCurrent();
  }

  public async requestInlineCompletion(
    uri: string,
    version: number,
    position: LspPosition,
    trigger: "auto" | "manual",
    token: vscode.CancellationToken,
  ): Promise<InlineCompletionResult> {
    if (this.focusedUri !== uri || !this.documents.has(uri))
      throw new Error("The Copilot document is not focused.");
    const result = await this.request(
      "textDocument/inlineCompletion",
      {
        textDocument: { uri, version },
        position,
        context: { triggerKind: trigger === "manual" ? 1 : 2 },
        formattingOptions: { tabSize: 2, insertSpaces: true },
      },
      token,
    );
    if (!isRecord(result) || !Array.isArray(result.items))
      throw new Error("Copilot returned an invalid inline completion result.");
    return {
      items: result.items.filter(isInlineCompletionItem).slice(0, 20),
    };
  }

  public reportShown(item: InlineCompletionItem): void {
    this.notify("textDocument/didShowCompletion", { item });
  }

  public reportPartiallyAccepted(
    item: InlineCompletionItem,
    acceptedLength: number,
  ): void {
    if (!Number.isSafeInteger(acceptedLength) || acceptedLength < 1) return;
    this.notify("textDocument/didPartiallyAcceptCompletion", {
      item,
      acceptedLength,
    });
  }

  public async reportAccepted(item: InlineCompletionItem): Promise<void> {
    const command = item.command;
    if (
      !command ||
      command.command !== "github.copilot.didAcceptCompletionItem"
    )
      return;
    const safe = validateAcceptedCommand(command);
    if (!safe) return;
    await this.request("workspace/executeCommand", safe);
  }

  public async closeDocument(uri: string): Promise<void> {
    if (!this.documents.has(uri)) return;
    this.notify("textDocument/didClose", { textDocument: { uri } });
    this.documents.delete(uri);
    if (this.focusedUri === uri) {
      this.focusedUri = undefined;
      this.notify("textDocument/didFocus", {});
    }
  }

  private request(
    method: string,
    params: unknown,
    token?: vscode.CancellationToken,
  ): Promise<unknown> {
    const child = this.child;
    if (!child || this.disposed)
      return Promise.reject(
        new Error("Copilot Language Server is not running."),
      );
    const id = this.nextRequestId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.reject(new Error(`Copilot request timed out: ${method}`));
      }, SERVER_REQUEST_TIMEOUT_MS);
      const disposeCancellation = token?.onCancellationRequested(() => {
        try {
          this.notify("$/cancelRequest", { id });
        } catch {
          // Still settle the request if the process already exited.
        }
        const pending = this.pending.get(id);
        this.pending.delete(id);
        if (pending)
          pending.reject(new Error("Copilot request was cancelled."));
        else reject(new Error("Copilot request was cancelled."));
      });
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          disposeCancellation?.dispose();
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          disposeCancellation?.dispose();
          reject(error);
        },
        ...(disposeCancellation ? { disposeCancellation } : {}),
      });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        disposeCancellation?.dispose();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: Record<string, unknown>): void {
    const child = this.child;
    if (!child || this.disposed || child.stdin.destroyed)
      throw new Error("Copilot Language Server connection is closed.");
    const body = Buffer.from(JSON.stringify(message), "utf8");
    if (body.length > MAX_RPC_MESSAGE_BYTES)
      throw new Error("Copilot Language Server message is too large.");
    child.stdin.write(
      Buffer.concat([
        Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
        body,
      ]),
    );
  }

  private receive(
    chunk: Buffer | string,
    child: ChildProcessWithoutNullStreams,
    generation: number,
  ): void {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    if (this.buffer.length + data.length > MAX_RPC_MESSAGE_BYTES + 8_192) {
      this.fail(
        new Error("Copilot Language Server message buffer exceeded its limit."),
        child,
        generation,
      );
      return;
    }
    this.buffer = Buffer.concat([this.buffer, data]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.toString("ascii", 0, headerEnd);
      const lengthMatch = header.match(
        /(?:^|\r\n)Content-Length:\s*(\d+)\s*(?:\r?\n|$)/i,
      );
      const length = lengthMatch ? Number(lengthMatch[1]) : NaN;
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > MAX_RPC_MESSAGE_BYTES
      ) {
        this.fail(
          new Error("Copilot Language Server sent an invalid message frame."),
          child,
          generation,
        );
        return;
      }
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.toString("utf8", bodyStart, bodyStart + length);
      this.buffer = this.buffer.subarray(bodyStart + length);
      let message: RpcMessage;
      try {
        const parsed: unknown = JSON.parse(body);
        if (!isRecord(parsed)) throw new Error("not an object");
        message = parsed;
      } catch {
        this.fail(
          new Error("Copilot Language Server sent invalid JSON."),
          child,
          generation,
        );
        return;
      }
      void this.handleMessage(message, child, generation).catch(
        (error: unknown) => {
          this.fail(
            error instanceof Error
              ? error
              : new Error("Copilot Language Server message handling failed."),
            child,
            generation,
          );
        },
      );
    }
  }

  private async handleMessage(
    message: RpcMessage,
    child: ChildProcessWithoutNullStreams,
    generation: number,
  ): Promise<void> {
    if (!this.isCurrentChild(child, generation)) return;
    if (typeof message.id === "number" && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(
          boundedString(message.error.message, MAX_SERVER_MESSAGE) ??
            "Copilot Language Server request failed.",
        );
        pending.reject(error);
      } else pending.resolve(message.result);
      return;
    }
    if (typeof message.method !== "string") return;
    if (message.id !== undefined) {
      await this.handleServerRequest(message, child, generation);
      return;
    }
    const params = isRecord(message.params) ? message.params : {};
    if (message.method === "didChangeStatus") {
      const rawKind = params.kind;
      const kind: CopilotServerKind =
        rawKind === "Normal" || rawKind === "Warning" || rawKind === "Inactive"
          ? rawKind
          : "Error";
      this.setStatus({
        kind,
        busy: params.busy === true,
        message: boundedString(params.message, MAX_STATUS_TEXT) ?? "",
        ...(this.focusedUri ? { documentUri: this.focusedUri } : {}),
        ...(isRecord(params.command) && typeof params.command.title === "string"
          ? { actionTitle: params.command.title.slice(0, 128) }
          : {}),
      });
    } else if (message.method === "window/showMessage") {
      const type = typeof params.type === "number" ? params.type : 3;
      const text = boundedString(params.message, MAX_SERVER_MESSAGE);
      if (text) void this.options.onMessage?.(type, text);
    }
    // window/logMessage and unknown notifications are intentionally discarded.
  }

  private async handleServerRequest(
    message: RpcMessage,
    child: ChildProcessWithoutNullStreams,
    generation: number,
  ): Promise<void> {
    if (typeof message.id !== "number" || typeof message.method !== "string")
      return;
    let result: unknown = null;
    let error: { code: number; message: string } | undefined;
    const params = isRecord(message.params) ? message.params : {};
    try {
      switch (message.method) {
        case "workspace/configuration":
          result = Array.isArray(params.items)
            ? params.items.map((item) => this.configurationFor(item))
            : [];
          break;
        case "window/showDocument": {
          const uri = boundedString(params.uri, 2_048);
          let opened = false;
          if (uri) {
            try {
              const parsed = vscode.Uri.parse(uri);
              if (
                parsed.scheme === "https" &&
                ["github.com", "github.dev"].includes(parsed.authority)
              )
                opened = await vscode.env.openExternal(parsed);
            } catch {
              opened = false;
            }
          }
          result = { success: opened };
          break;
        }
        case "window/showMessageRequest": {
          const text = boundedString(params.message, MAX_SERVER_MESSAGE);
          const actions = safeMessageActions(params.actions);
          const selected = text
            ? await this.options.onMessage?.(
                typeof params.type === "number" ? params.type : 3,
                text,
                actions,
              )
            : undefined;
          result =
            selected && actions.includes(selected) ? { title: selected } : null;
          break;
        }
        case "workspace/applyEdit":
          result = {
            applied: false,
            failureReason:
              "Markdown Mint does not apply server workspace edits.",
          };
          break;
        case "workspace/executeClientCommand":
        case "workspace/executeCommand":
          error = {
            code: -32601,
            message: "Server commands are not exposed to VS Code.",
          };
          break;
        default:
          error = {
            code: -32601,
            message: "Unsupported Copilot client request.",
          };
      }
    } catch (caught) {
      error = {
        code: -32603,
        message:
          caught instanceof Error
            ? caught.message.slice(0, MAX_SERVER_MESSAGE)
            : "Copilot client request failed.",
      };
    }
    const response: Record<string, unknown> = {
      jsonrpc: "2.0",
      id: message.id,
    };
    if (error) response.error = error;
    else response.result = result;
    if (this.isCurrentChild(child, generation)) this.write(response);
  }

  private configurationFor(item: unknown): unknown {
    if (!isRecord(item) || typeof item.section !== "string") return null;
    const proxy = this.options.proxy();
    if (item.section === "http.proxy") return proxy.proxy;
    if (item.section === "http.proxyStrictSSL") return proxy.strictSSL;
    if (item.section === "telemetry.telemetryLevel") return "off";
    return null;
  }

  private fail(
    error: Error,
    child: ChildProcessWithoutNullStreams | undefined = this.child,
    generation = this.generation,
  ): void {
    if (!child || !this.isCurrentChild(child, generation)) return;
    this.child = undefined;
    this.initialized = false;
    this.documents.clear();
    this.focusedUri = undefined;
    this.buffer = Buffer.alloc(0);
    this.setStatus({
      kind: "Warning",
      busy: false,
      message: error.message.slice(0, MAX_STATUS_TEXT),
    });
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.detachDataListeners(child);
    if (!hasChildExited(child)) {
      const cleanup = this.terminateFailedChild(child);
      this.cleanupPromises.set(child, cleanup);
      void cleanup.finally(() => this.cleanupPromises.delete(child));
    } else {
      this.cleanupChild(child);
    }
  }

  private handleChildError(
    child: ChildProcessWithoutNullStreams,
    generation: number,
    error: Error,
  ): void {
    // A spawn error has no process to wait for. Errors from an already spawned
    // child (for example, a failed kill) still require exit/close confirmation.
    if (child.pid === undefined) completedChildren.add(child);
    this.fail(error, child, generation);
  }

  private handleChildClose(
    child: ChildProcessWithoutNullStreams,
    generation: number,
    _code: number | null,
    _signal: NodeJS.Signals | null,
  ): void {
    completedChildren.add(child);
    if (this.isCurrentChild(child, generation)) {
      this.fail(
        new Error("Copilot Language Server closed before reporting exit."),
        child,
        generation,
      );
      return;
    }
    this.cleanupChild(child);
  }

  private isCurrentChild(
    child: ChildProcessWithoutNullStreams,
    generation: number,
  ): boolean {
    return this.child === child && this.generation === generation;
  }

  private detachDataListeners(child: ChildProcessWithoutNullStreams): void {
    const listeners = this.childListeners.get(child);
    if (!listeners) return;
    child.stdout.removeListener("data", listeners.onData);
    child.stderr.removeListener("data", listeners.onStderr);
  }

  private cleanupChild(child: ChildProcessWithoutNullStreams): void {
    const listeners = this.childListeners.get(child);
    if (listeners) {
      child.stdout.removeListener("data", listeners.onData);
      child.stderr.removeListener("data", listeners.onStderr);
      child.stdin.removeListener("error", listeners.onStreamError);
      child.stdout.removeListener("error", listeners.onStreamError);
      child.stderr.removeListener("error", listeners.onStreamError);
      child.removeListener("error", listeners.onError);
      child.removeListener("exit", listeners.onExit);
      child.removeListener("close", listeners.onClose);
      this.childListeners.delete(child);
    }
    this.ownedChildren.delete(child);
  }

  private handleChildExit(
    child: ChildProcessWithoutNullStreams,
    generation: number,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    completedChildren.add(child);
    if (this.isCurrentChild(child, generation)) {
      if (this.disposed) {
        this.child = undefined;
        this.initialized = false;
        this.documents.clear();
        this.focusedUri = undefined;
        for (const pending of this.pending.values())
          pending.reject(new Error("Copilot Language Server was stopped."));
        this.pending.clear();
        this.setStatus({
          kind: "Warning",
          busy: false,
          message: "Copilot Language Server is stopped.",
        });
      } else {
        this.fail(
          new Error(
            `Copilot Language Server exited (${signal ?? code ?? "unknown"}).`,
          ),
          child,
          generation,
        );
      }
    }
    this.cleanupChild(child);
  }

  private async terminateFailedChild(
    child: ChildProcessWithoutNullStreams,
  ): Promise<boolean> {
    try {
      child.stdin.end();
    } catch {
      // The transport may already be closed.
    }
    if (await waitForChildExit(child, FAILED_PROCESS_TERM_GRACE_MS)) {
      this.cleanupChild(child);
      return true;
    }
    if (!hasChildExited(child)) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Continue to SIGKILL after the grace period.
      }
      if (await waitForChildExit(child, FAILED_PROCESS_TERM_GRACE_MS)) {
        this.cleanupChild(child);
        return true;
      }
    }
    if (!hasChildExited(child)) {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may have exited concurrently.
      }
      const confirmed = await waitForChildExit(child, FINAL_PROCESS_EXIT_MS);
      this.cleanupChild(child);
      return confirmed;
    }
    this.cleanupChild(child);
    return true;
  }

  private setStatus(status: CopilotServerStatus): void {
    this.statusRevision += 1;
    this.status = status;
    this.options.onStatus?.(status);
  }

  public disposeAsync(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = this.disposeInternal();
    return this.disposePromise;
  }

  private async disposeInternal(): Promise<void> {
    const child = this.child;
    this.documents.clear();
    this.focusedUri = undefined;
    for (const pending of this.pending.values())
      pending.reject(new Error("Copilot Language Server was stopped."));
    this.pending.clear();
    const cleanups = [...this.cleanupPromises.values()];
    let exitConfirmed = !child;
    if (child && !hasChildExited(child)) {
      try {
        await this.requestBeforeDispose(child, "shutdown", null);
      } catch {
        // Exit and signal escalation below still release the process.
      }
      try {
        child.stdin.write(encodeMessage({ jsonrpc: "2.0", method: "exit" }));
        child.stdin.end();
      } catch {
        // The child may have closed its input while shutdown was in flight.
      }
      exitConfirmed = await this.escalateDispose(child);
      if (!exitConfirmed) this.cleanupChild(child);
    } else if (child) {
      exitConfirmed = true;
      this.cleanupChild(child);
    }
    const cleanupResults = await Promise.all(cleanups);
    exitConfirmed = exitConfirmed && cleanupResults.every(Boolean);
    for (const ownedChild of [...this.ownedChildren]) {
      if (ownedChild === child) continue;
      const cleanup = this.cleanupPromises.get(ownedChild);
      const confirmed = cleanup
        ? await cleanup
        : await this.terminateFailedChild(ownedChild);
      exitConfirmed = exitConfirmed && confirmed;
    }
    if (child && hasChildExited(child)) this.cleanupChild(child);
    this.setStatus({
      kind: "Warning",
      busy: false,
      message: exitConfirmed
        ? "Copilot Language Server is stopped."
        : "Copilot Language Server shutdown could not be confirmed.",
    });
  }

  private async escalateDispose(
    child: ChildProcessWithoutNullStreams,
  ): Promise<boolean> {
    if (await waitForChildExit(child, 1_000)) return true;
    if (!hasChildExited(child)) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Continue to SIGKILL after the grace period.
      }
      if (await waitForChildExit(child, DISPOSE_TERM_GRACE_MS)) return true;
    }
    if (!hasChildExited(child)) {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may have exited concurrently.
      }
      return waitForChildExit(child, FINAL_PROCESS_EXIT_MS);
    }
    return true;
  }

  private requestBeforeDispose(
    child: ChildProcessWithoutNullStreams,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("shutdown timed out"));
      }, 1_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(encodeMessage({ jsonrpc: "2.0", id, method, params }));
    });
  }

  public dispose(): void {
    void this.disposeAsync();
  }
}

function hasChildExited(child: ChildProcess): boolean {
  return (
    completedChildren.has(child) ||
    child.exitCode !== null ||
    child.signalCode !== null
  );
}

export function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (hasChildExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (confirmed) completedChildren.add(child);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
      resolve(confirmed);
    };
    const onExit = () => finish(true);
    const onClose = () => finish(true);
    const onError = () => {
      if (child.pid === undefined) finish(true);
    };
    child.once("exit", onExit);
    child.once("close", onClose);
    child.once("error", onError);
    if (hasChildExited(child)) {
      finish(true);
      return;
    }
    timer = setTimeout(() => finish(hasChildExited(child)), timeoutMs);
  });
}

function encodeMessage(message: Record<string, unknown>): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
    body,
  ]);
}

function languageServerEnvironment(): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  const names = [
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ];
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) safe[name] = value;
  }
  return safe;
}

function uriBelongsToWorkspace(
  documentUri: string | undefined,
  workspaceUri: string,
): boolean {
  if (!documentUri) return false;
  const normalized = workspaceUri.endsWith("/")
    ? workspaceUri
    : `${workspaceUri}/`;
  return documentUri === workspaceUri || documentUri.startsWith(normalized);
}

function minimalTextChange(
  previous: string,
  next: string,
): { range: LspRange; text: string } {
  let start = 0;
  const maxPrefix = Math.min(previous.length, next.length);
  while (
    start < maxPrefix &&
    previous.charCodeAt(start) === next.charCodeAt(start)
  )
    start += 1;
  while (
    start > 0 &&
    (isCrLfBoundary(previous, start) ||
      isCrLfBoundary(next, start) ||
      isSurrogateBoundary(previous, start) ||
      isSurrogateBoundary(next, start))
  )
    start -= 1;

  let suffix = 0;
  while (
    suffix < previous.length - start &&
    suffix < next.length - start &&
    previous.charCodeAt(previous.length - suffix - 1) ===
      next.charCodeAt(next.length - suffix - 1)
  )
    suffix += 1;
  let previousEnd = previous.length - suffix;
  let nextEnd = next.length - suffix;
  while (
    suffix > 0 &&
    (isCrLfBoundary(previous, previousEnd) ||
      isCrLfBoundary(next, nextEnd) ||
      isSurrogateBoundary(previous, previousEnd) ||
      isSurrogateBoundary(next, nextEnd))
  ) {
    suffix -= 1;
    previousEnd += 1;
    nextEnd += 1;
  }
  return {
    range: {
      start: offsetToLspPosition(previous, start),
      end: offsetToLspPosition(previous, previousEnd),
    },
    text: next.slice(start, nextEnd),
  };
}

export function offsetToLspPosition(text: string, offset: number): LspPosition {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length)
    throw new RangeError("Markdown offset is outside the document.");
  if (isCrLfBoundary(text, offset) || isSurrogateBoundary(text, offset))
    throw new RangeError(
      "Markdown offset splits a line ending or surrogate pair.",
    );
  let line = 0;
  let lineStart = 0;
  for (let index = 0; index < offset; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x0d) {
      if (text.charCodeAt(index + 1) === 0x0a) {
        if (index + 1 < offset) index += 1;
        else break;
      }
      line += 1;
      lineStart = index + 1;
    } else if (code === 0x0a) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, character: offset - lineStart };
}

export function lspPositionToOffset(
  text: string,
  position: LspPosition,
): number | undefined {
  if (
    !Number.isSafeInteger(position.line) ||
    !Number.isSafeInteger(position.character) ||
    position.line < 0 ||
    position.character < 0
  )
    return undefined;
  let line = 0;
  let start = 0;
  while (line < position.line) {
    const lf = text.indexOf("\n", start);
    const cr = text.indexOf("\r", start);
    const next = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
    if (next < 0) return undefined;
    if (text[next] === "\r" && text[next + 1] === "\n") start = next + 2;
    else start = next + 1;
    line += 1;
  }
  let end = text.length;
  const lf = text.indexOf("\n", start);
  const cr = text.indexOf("\r", start);
  const next = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
  if (next >= 0) end = next;
  const offset = start + position.character;
  if (offset > end) return undefined;
  if (isLowSurrogate(text.charCodeAt(offset))) return undefined;
  return offset;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function isCrLfBoundary(text: string, offset: number): boolean {
  return (
    offset > 0 &&
    offset < text.length &&
    text.charCodeAt(offset - 1) === 0x0d &&
    text.charCodeAt(offset) === 0x0a
  );
}

function isSurrogateBoundary(text: string, offset: number): boolean {
  return (
    offset > 0 &&
    offset < text.length &&
    text.charCodeAt(offset - 1) >= 0xd800 &&
    text.charCodeAt(offset - 1) <= 0xdbff &&
    isLowSurrogate(text.charCodeAt(offset))
  );
}

export function isInlineCompletionItem(
  value: unknown,
): value is InlineCompletionItem {
  if (!isRecord(value) || typeof value.insertText !== "string") return false;
  if (value.insertText.length > 32_768) return false;
  if (value.insertTextFormat !== undefined && value.insertTextFormat !== 1)
    return false;
  if (value.range !== undefined && !isLspRange(value.range)) return false;
  if (value.command !== undefined && !isInlineCompletionCommand(value.command))
    return false;
  return !hasControlCharacters(value.insertText);
}

export function isLspRange(value: unknown): value is LspRange {
  if (
    !isRecord(value) ||
    !isLspPosition(value.start) ||
    !isLspPosition(value.end)
  )
    return false;
  return comparePositions(value.start, value.end) <= 0;
}

export function comparePositions(
  left: LspPosition,
  right: LspPosition,
): number {
  return left.line === right.line
    ? left.character - right.character
    : left.line - right.line;
}

function isLspPosition(value: unknown): value is LspPosition {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.line) &&
    Number.isSafeInteger(value.character) &&
    Number(value.line) >= 0 &&
    Number(value.character) >= 0
  );
}

function isInlineCompletionCommand(
  value: unknown,
): value is InlineCompletionCommand {
  return (
    isRecord(value) &&
    typeof value.command === "string" &&
    value.command.length <= 256 &&
    (value.title === undefined ||
      (typeof value.title === "string" && value.title.length <= 256)) &&
    (value.arguments === undefined ||
      (Array.isArray(value.arguments) && value.arguments.length <= 8))
  );
}

function validateDeviceFlowCommand(
  value: unknown,
): Record<string, unknown> | undefined {
  if (
    !isRecord(value) ||
    value.command !== "github.copilot.finishDeviceFlow" ||
    (value.arguments !== undefined &&
      (!Array.isArray(value.arguments) || value.arguments.length !== 0))
  )
    return undefined;
  const args = value.arguments ?? [];
  return {
    command: value.command,
    arguments: args,
  };
}

function validateAcceptedCommand(
  value: InlineCompletionCommand,
): Record<string, unknown> | undefined {
  if (value.command !== "github.copilot.didAcceptCompletionItem")
    return undefined;
  const args = value.arguments ?? [];
  if (
    args.length !== 1 ||
    typeof args[0] !== "string" ||
    args[0].length === 0 ||
    args[0].length > 256 ||
    hasAsciiControl(args[0])
  )
    return undefined;
  return { command: value.command, arguments: args };
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length <= max ? value : undefined;
}

function safeMessageActions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 5)
    .map((item) =>
      isRecord(item) ? boundedString(item.title, 128) : undefined,
    )
    .filter((title): title is string => Boolean(title));
}

function isSafeDocumentUri(value: string): boolean {
  try {
    const uri = vscode.Uri.parse(value);
    return uri.scheme === "file" && !hasAsciiControl(value);
  } catch {
    return false;
  }
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      code === 0x7f
    )
      return true;
  }
  return false;
}

function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
