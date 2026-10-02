import { beforeEach, describe, expect, it, vi } from "vitest";

const fakeWs = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  class FakeSocket {
    public static readonly OPEN = 1;
    public static readonly CLOSED = 3;
    public static readonly instances: FakeSocket[] = [];
    public static onSend:
      ((socket: FakeSocket, message: string) => void) | undefined;
    public readyState = 0;
    private readonly listeners = new Map<string, Listener[]>();
    public constructor(public readonly endpoint: string) {
      FakeSocket.instances.push(this);
      queueMicrotask(() => {
        this.readyState = FakeSocket.OPEN;
        this.emit("open");
      });
    }
    public on(event: string, listener: Listener): this {
      this.listeners.set(event, [
        ...(this.listeners.get(event) ?? []),
        listener,
      ]);
      return this;
    }
    public once(event: string, listener: Listener): this {
      const wrapper: Listener = (...args) => {
        this.remove(event, wrapper);
        listener(...args);
      };
      return this.on(event, wrapper);
    }
    public remove(event: string, listener: Listener): void {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter(
          (candidate) => candidate !== listener,
        ),
      );
    }
    public emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])])
        listener(...args);
    }
    public send(message: string): void {
      FakeSocket.onSend?.(this, message);
    }
    public close(): void {
      this.readyState = FakeSocket.CLOSED;
      this.emit("close");
    }
    public terminate(): void {
      this.readyState = FakeSocket.CLOSED;
      this.emit("close");
    }
    public respond(message: unknown): void {
      this.emit("message", Buffer.from(JSON.stringify(message)));
    }
  }
  return { FakeSocket };
});

vi.mock("ws", () => ({ default: fakeWs.FakeSocket }));

import { createCdpClient } from "../../../src/extension/export/cdpClient";

beforeEach(() => {
  fakeWs.FakeSocket.instances.length = 0;
  fakeWs.FakeSocket.onSend = undefined;
});

describe("CDP client", () => {
  it("matches a response to a request and includes sessionId", async () => {
    let sent: Record<string, unknown> | undefined;
    fakeWs.FakeSocket.onSend = (socket, message) => {
      sent = JSON.parse(message) as Record<string, unknown>;
      socket.respond({ id: sent.id, result: { value: 42 } });
    };
    const client = await createCdpClient("ws://browser", { timeoutMs: 100 });
    await expect(
      client.send("Runtime.evaluate", { expression: "1" }, "session-1"),
    ).resolves.toEqual({ value: 42 });
    expect(sent).toMatchObject({
      method: "Runtime.evaluate",
      sessionId: "session-1",
    });
    await client.close();
  });

  it("supports concurrent request IDs", async () => {
    fakeWs.FakeSocket.onSend = (socket, message) => {
      const request = JSON.parse(message) as { id: number };
      setTimeout(
        () => socket.respond({ id: request.id, result: request.id }),
        request.id === 1 ? 10 : 0,
      );
    };
    const client = await createCdpClient("ws://browser", { timeoutMs: 100 });
    await expect(
      Promise.all([
        client.send<number>("First"),
        client.send<number>("Second"),
      ]),
    ).resolves.toEqual([1, 2]);
    await client.close();
  });

  it("rejects CDP protocol errors", async () => {
    fakeWs.FakeSocket.onSend = (socket, message) => {
      const request = JSON.parse(message) as { id: number };
      socket.respond({
        id: request.id,
        error: { code: -32601, message: "Unknown method" },
      });
    };
    const client = await createCdpClient("ws://browser", { timeoutMs: 100 });
    await expect(client.send("Missing.method")).rejects.toThrow(
      "Unknown method",
    );
    await client.close();
  });

  it("rejects a request on timeout and on socket close", async () => {
    fakeWs.FakeSocket.onSend = () => undefined;
    const client = await createCdpClient("ws://browser", { timeoutMs: 15 });
    await expect(client.send("Never.responds")).rejects.toThrow(
      "Timed out waiting for CDP",
    );
    const socket = fakeWs.FakeSocket.instances[0];
    expect(socket).toBeDefined();
    const pending = client.send("Pending");
    socket?.emit("close");
    await expect(pending).rejects.toThrow("connection closed");
  });

  it("closes the socket and makes close idempotent", async () => {
    const client = await createCdpClient("ws://browser", { timeoutMs: 100 });
    await client.close();
    await client.close();
    expect(fakeWs.FakeSocket.instances[0]?.readyState).toBe(3);
  });
});
