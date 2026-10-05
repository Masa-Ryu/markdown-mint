import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertExpectedSource,
  buildPromoSelectExpression,
  locateVideoMarkers,
  parsePromoArgs,
  parseRenderArgs,
  publishValidatedFiles,
  readExpectedMarkdown,
  runProcess,
} from "../../scripts/demo/promo-utils.mjs";

const temporaryDirectories = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "markdown-mint-promo-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function markerPixel(kind) {
  return {
    "clip-start": [240, 0, 240],
    "source-start": [240, 240, 0],
    "source-end": [0, 240, 0],
    "clip-end": [0, 240, 240],
    content: [40, 80, 120],
  }[kind];
}

function markerFrames(segments) {
  const frames = [];
  for (const [kind, count] of segments)
    for (let index = 0; index < count; index += 1)
      frames.push(markerPixel(kind));
  return {
    timestamps: frames.map((_, index) => index / 25),
    pixels: Buffer.from(frames.flat()),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("promo demo arguments", () => {
  it("accepts a headed run and a valid port", () => {
    expect(parsePromoArgs(["--headed", "--port", "4921"], {})).toEqual({
      headed: true,
      help: false,
      port: 4921,
    });
    expect(
      parsePromoArgs([], { MM_PROMO_HEADED: "1", MM_PROMO_PORT: "4178" }),
    ).toEqual({
      headed: true,
      help: false,
      port: 4178,
    });
  });

  it("rejects invalid ports and unknown options", () => {
    expect(() => parsePromoArgs(["--port", "80"], {})).toThrow(/port/);
    expect(() => parsePromoArgs(["--mystery"], {})).toThrow(/Unknown/);
    expect(parseRenderArgs(["--help"])).toEqual({ help: true });
    expect(() => parseRenderArgs(["--force"])).toThrow(/Unknown/);
  });
});

describe("promo source and recording checks", () => {
  it("normalizes only newline style when comparing Markdown", () => {
    expect(() =>
      assertExpectedSource("# Status\r\n", "# Status\n"),
    ).not.toThrow();
    expect(() => assertExpectedSource("# Status\n\n", "# Status\n")).toThrow(
      /differs/,
    );
    expect(() =>
      assertExpectedSource("| Feature | Status |", "| Status | Feature |"),
    ).toThrow(/differs/);
  });

  it("reads exact Markdown from a JSON fixture string", async () => {
    const directory = await temporaryDirectory();
    const fixturePath = join(directory, "expected.json");
    const markdown = "# Status\n\nBody\n\n\n";
    await writeFile(fixturePath, `${JSON.stringify({ markdown })}\n`);
    await expect(readExpectedMarkdown(fixturePath)).resolves.toBe(markdown);

    await writeFile(fixturePath, JSON.stringify({ markdown: 42 }));
    await expect(readExpectedMarkdown(fixturePath)).rejects.toThrow(/string/);
  });

  it("maps recorded color markers to real frame boundaries", () => {
    const { timestamps, pixels } = markerFrames([
      ["clip-start", 5],
      ["content", 20],
      ["source-start", 5],
      ["content", 55],
      ["source-end", 5],
      ["content", 20],
      ["clip-end", 5],
    ]);
    const capture = locateVideoMarkers(timestamps, pixels);
    expect(capture.clipStartFrame).toBe(5);
    expect(capture.sourceVisibleStartFrame).toBe(30);
    expect(capture.sourceVisibleEndFrame).toBe(85);
    expect(capture.clipEndFrameExclusive).toBe(110);
    expect(capture.sourceVisibleDurationSeconds).toBeCloseTo(2.2);
    expect(buildPromoSelectExpression(capture)).toContain(
      "between(n,5,109)*not(between(n,0,4))",
    );
    expect(buildPromoSelectExpression(capture)).toContain(
      "not(between(n,85,89))",
    );
  });

  it("fails a conversion process with its diagnostic output", async () => {
    await expect(
      runProcess(process.execPath, [
        "-e",
        "process.stderr.write('encoder stopped'); process.exit(7)",
      ]),
    ).rejects.toThrow(/exited with code 7[\s\S]*encoder stopped/);
  });

  it("waits for a timed-out child process to exit", async () => {
    const directory = await temporaryDirectory();
    const closedPath = join(directory, "child-closed");
    const script = [
      "process.on('SIGTERM', () => setTimeout(() => {",
      `require('node:fs').writeFileSync(${JSON.stringify(closedPath)}, 'closed');`,
      "process.exit(0); }, 100));",
      "setInterval(() => {}, 1000);",
    ].join(" ");

    await expect(
      runProcess(process.execPath, ["-e", script], { timeoutMs: 250 }),
    ).rejects.toThrow(/timed out/);
    expect(await readFile(closedPath, "utf8")).toBe("closed");
  });
});

describe("promo publication", () => {
  it("keeps the prior overview GIF if a validated publish cannot finish", async () => {
    const directory = await temporaryDirectory();
    const targetGif = join(directory, "overview.gif");
    const sourceGif = join(directory, "new-overview.gif");
    const blockedParent = join(directory, "blocked");
    const blockedTarget = join(blockedParent, "report.json");
    await writeFile(targetGif, "previous-gif");
    await writeFile(sourceGif, "new-gif");
    await writeFile(blockedParent, "not-a-directory");
    await expect(
      publishValidatedFiles([
        { source: sourceGif, target: targetGif },
        { source: sourceGif, target: blockedTarget },
      ]),
    ).rejects.toThrow(/publish/);
    await expect(readFile(targetGif, "utf8")).resolves.toBe("previous-gif");
  });

  it("replaces files after validation and keeps them from a single staging run", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "stage-report.json");
    const target = join(directory, "report.json");
    await writeFile(source, '{"runId":"same-run"}\n');
    await writeFile(target, "old-report");
    await publishValidatedFiles([{ source, target }]);
    await expect(readFile(target, "utf8")).resolves.toBe(
      '{"runId":"same-run"}\n',
    );
  });
});
