import WebSocket, { type RawData } from "ws";

export interface CdpClient {
  send<T>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<T>;
  close(): Promise<void>;
}

export interface CdpClientOptions {
  readonly timeoutMs?: number;
}

interface PendingRequest {
  readonly reject: (error: Error) => void;
  readonly resolve: (value: unknown) => void;
  readonly timer: NodeJS.Timeout;
}

function errorFromUnknown(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

/** A deliberately small CDP JSON-over-WebSocket client. */
export function createCdpClient(
  endpoint: string,
  options: CdpClientOptions = {},
): Promise<CdpClient> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const socket = new WebSocket(endpoint);
  let nextId = 1;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  const pending = new Map<number, PendingRequest>();

  const rejectPending = (error: Error): void => {
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      request.reject(error);
      pending.delete(id);
    }
  };

  const ready = new Promise<void>((resolve, reject) => {
    rejectReady = reject;
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Timed out connecting to Chrome DevTools within ${timeoutMs} ms.`,
        ),
      );
      socket.terminate();
    }, timeoutMs);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (error: Error) => {
      clearTimeout(timer);
      reject(errorFromUnknown(error, "Chrome DevTools connection failed."));
    });
  });

  socket.on("message", (raw: RawData) => {
    let message: {
      id?: number;
      result?: unknown;
      error?: { code?: number; message?: string; data?: unknown };
    };
    try {
      message = JSON.parse(raw.toString()) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) {
      const details = message.error.data
        ? `: ${String(message.error.data)}`
        : "";
      request.reject(
        new Error(
          `CDP ${message.error.code ?? "protocol"} ${message.error.message ?? "request failed"}${details}`,
        ),
      );
      return;
    }
    request.resolve(message.result);
  });

  const closedError = (): Error =>
    new Error("Chrome DevTools connection closed while a request was pending.");
  socket.once("close", () => {
    closed = true;
    const error = closedError();
    rejectReady?.(error);
    rejectPending(error);
  });
  socket.once("error", (error: Error) => {
    rejectPending(
      errorFromUnknown(error, "Chrome DevTools connection failed."),
    );
  });

  const client: CdpClient = {
    async send<T>(
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string,
    ): Promise<T> {
      await ready;
      if (closed || socket.readyState !== WebSocket.OPEN) throw closedError();
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(
            new Error(
              `Timed out waiting for CDP ${method} within ${timeoutMs} ms.`,
            ),
          );
        }, timeoutMs);
        pending.set(id, {
          resolve: resolve as (value: unknown) => void,
          reject,
          timer,
        });
        try {
          socket.send(
            JSON.stringify({
              id,
              method,
              ...(params ? { params } : {}),
              ...(sessionId ? { sessionId } : {}),
            }),
          );
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(errorFromUnknown(error, `Could not send CDP ${method}.`));
        }
      });
    },
    async close(): Promise<void> {
      if (closePromise) return closePromise;
      closePromise = new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) {
          closed = true;
          rejectPending(new Error("Chrome DevTools connection closed."));
          resolve();
          return;
        }
        const finish = (): void => {
          closed = true;
          rejectPending(new Error("Chrome DevTools connection closed."));
          resolve();
        };
        socket.once("close", finish);
        socket.close();
        setTimeout(
          () => {
            if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
            finish();
          },
          Math.min(timeoutMs, 1_000),
        );
      });
      return closePromise;
    },
  };
  return ready.then(() => client);
}
