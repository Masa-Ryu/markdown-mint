import { describe, expect, it } from "vitest";
import {
  SyncController,
  matrixToTsv,
  parseTsv,
} from "../../src/webview/editor";
import { PROTOCOL_VERSION } from "../../src/shared/protocol";

describe("webview sync queue", () => {
  it("sends one edit at a time and rebases the queued draft on acknowledgement", () => {
    const messages: unknown[] = [];
    const statuses: string[] = [];
    const sync = new SyncController(
      1,
      { postMessage: (message) => messages.push(message) },
      (status) => statuses.push(status),
      () => undefined,
    );
    const first = sync.enqueue("first");
    const second = sync.enqueue("second");

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      type: "edit",
      baseVersion: 1,
      markdown: "first",
    });
    expect(sync.queuedEdit?.markdown).toBe("second");

    expect(sync.acknowledge(first.operationId, 2, "first")).toBe(true);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      type: "edit",
      baseVersion: 2,
      markdown: "second",
    });
    expect(sync.acknowledge(second.operationId, 3, "second")).toBe(true);
    expect(sync.hasPending).toBe(false);
    expect(statuses.at(-1)).toBe("saved");
  });

  it("drops only the rejected inflight edit and never changes a queued draft silently", () => {
    const messages: unknown[] = [];
    const sync = new SyncController(
      7,
      { postMessage: (message) => messages.push(message) },
      () => undefined,
      () => undefined,
    );
    const edit = sync.enqueue("draft");
    sync.enqueue("newer draft");
    expect(sync.reject(edit.operationId, 8)).toBe(true);
    expect(sync.hasPending).toBe(false);
    expect(messages).toHaveLength(1);
  });
});

describe("table clipboard text", () => {
  it("round trips Japanese, empty cells and quoted tabs/newlines without truncation", () => {
    const matrix = {
      values: [
        ["日本語", "", "line\nwith\ttab"],
        ["", "終端", ""],
      ],
      rows: 2,
      columns: 3,
    };
    const tsv = matrixToTsv(matrix);
    expect(parseTsv(tsv)).toMatchObject(matrix);
  });
});
