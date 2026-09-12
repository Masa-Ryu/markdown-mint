import { describe, expect, it } from "vitest";
import {
  SyncController,
  matrixToTsv,
  parseTsv,
} from "../../src/webview/editor";
import { PROTOCOL_VERSION } from "../../src/shared/protocol";
import { mergeMarkdownSnapshots } from "../../src/shared/threeWayMerge";

describe("three-way Markdown merge", () => {
  it("combines independent local and external line changes", () => {
    expect(
      mergeMarkdownSnapshots(
        "Title\nBody\n",
        "Title\nBody local\n",
        "Remote title\nBody\n",
      ),
    ).toBe("Remote title\nBody local\n");
  });

  it("rejects overlapping changes so both snapshots remain available", () => {
    expect(
      mergeMarkdownSnapshots("Title\n", "Local title\n", "Remote title\n"),
    ).toBeUndefined();
  });
});

describe("webview sync queue", () => {
  it("sends one edit at a time and rebases the queued draft on acknowledgement", () => {
    const messages: unknown[] = [];
    const sync = new SyncController(1, {
      postMessage: (message) => messages.push(message),
    });
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
  });

  it("retains a newer queued draft when the inflight edit is rejected", () => {
    const messages: unknown[] = [];
    const sync = new SyncController(7, {
      postMessage: (message) => messages.push(message),
    });
    const edit = sync.enqueue("draft");
    sync.enqueue("newer draft");
    expect(sync.reject(edit.operationId, 8)).toBe(true);
    expect(sync.queuedEdit?.markdown).toBe("newer draft");
    expect(messages).toHaveLength(1);
  });

  it("bounds repeated stale rebases and preserves the final local draft", () => {
    const messages: unknown[] = [];
    const sync = new SyncController(
      1,
      { postMessage: (message) => messages.push(message) },
      "one\ntwo\nthree\nfour\nfive\nsix\n",
    );
    let local = "one local\ntwo\nthree\nfour\nfive\nsix\n";
    let external = "one\ntwo external\nthree\nfour\nfive\nsix\n";
    let version = 2;
    let pending = sync.enqueue(local);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = sync.rebaseRejected(
        pending.operationId,
        version,
        external,
        local,
      );
      expect(result.kind).toBe("merged");
      local = result.markdown;
      pending = sync.enqueue(local);
      version += 1;
      const lines = external.split("\n");
      lines[attempt + 2] = `${lines[attempt + 2]} external`;
      external = lines.join("\n");
    }

    const exhausted = sync.rebaseRejected(
      pending.operationId,
      version,
      external,
      local,
    );
    expect(exhausted.kind).toBe("conflict");
    expect(sync.hasBlockedConflict).toBe(true);
    expect(sync.blockedDraft).toBe(local);
    expect(sync.hasPending).toBe(false);
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
