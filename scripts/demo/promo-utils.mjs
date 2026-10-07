import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export const PROMO_SIZE = Object.freeze({ width: 1280, height: 720 });
export const GIF_SIZE = Object.freeze({ width: 960, height: 540 });
export const PROMO_DURATION = Object.freeze({ min: 15, max: 20 });
export const GIF_SIZE_TARGET_BYTES = 5 * 1024 * 1024;
export const GIF_SIZE_LIMIT_BYTES = 8 * 1024 * 1024;

export function parsePromoArgs(argv, env = process.env) {
  let headed = env.MM_PROMO_HEADED === "1";
  let port = Number(env.MM_PROMO_PORT ?? 4177);
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--headed") headed = true;
    else if (argument === "--headless") headed = false;
    else if (argument === "--help" || argument === "-h") help = true;
    else if (argument === "--port") {
      const value = argv[++index];
      if (value === undefined) throw new Error("--port requires a value.");
      port = Number(value);
    } else if (argument.startsWith("--port=")) {
      port = Number(argument.slice("--port=".length));
    } else {
      throw new Error(`Unknown promo demo option: ${argument}`);
    }
  }

  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Promo demo port must be an integer from 1024 to 65535.");
  return { headed, help, port };
}

export function parseRenderArgs(argv) {
  if (argv.length === 0) return { help: false };
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h"))
    return { help: true };
  throw new Error(`Unknown promo render option: ${argv[0]}`);
}

export function normalizeNewlines(source) {
  return source.replace(/\r\n?/g, "\n");
}

export async function readExpectedMarkdown(path) {
  const fixture = JSON.parse(await readFile(path, "utf8"));
  if (!fixture || typeof fixture.markdown !== "string")
    throw new Error(
      `Expected Markdown fixture must contain a string "markdown" property: ${path}`,
    );
  return fixture.markdown;
}

export function assertExpectedSource(actual, expected) {
  const normalizedActual = normalizeNewlines(actual);
  const normalizedExpected = normalizeNewlines(expected);
  if (normalizedActual !== normalizedExpected)
    throw new Error(
      [
        "Generated Markdown differs from docs/demo/promo-expected.json.",
        `generated JSON: ${JSON.stringify(normalizedActual)}`,
        "--- generated ---",
        normalizedActual,
        "--- expected ---",
        normalizedExpected,
      ].join("\n"),
    );
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function classifyMarkerPixel(pixels, frameIndex) {
  const offset = frameIndex * 3;
  const red = pixels[offset];
  const green = pixels[offset + 1];
  const blue = pixels[offset + 2];
  if (red > 180 && green < 90 && blue > 180) return "clip-start";
  if (red > 180 && green > 180 && blue < 90) return "source-start";
  if (red < 90 && green > 180 && blue < 90) return "source-end";
  if (red < 90 && green > 180 && blue > 180) return "clip-end";
  return null;
}

export function locateVideoMarkers(frameTimestamps, pixels) {
  if (pixels.length !== frameTimestamps.length * 3)
    throw new Error(
      `Marker frame count mismatch: ${frameTimestamps.length} timestamps, ${pixels.length / 3} pixels.`,
    );

  const segments = [];
  let active = null;
  for (
    let frameIndex = 0;
    frameIndex < frameTimestamps.length;
    frameIndex += 1
  ) {
    const kind = classifyMarkerPixel(pixels, frameIndex);
    if (kind === active?.kind) {
      active.lastFrame = frameIndex;
      continue;
    }
    active = null;
    if (kind) {
      active = { kind, firstFrame: frameIndex, lastFrame: frameIndex };
      segments.push(active);
    }
  }

  const markers = Object.fromEntries(
    ["clip-start", "source-start", "source-end", "clip-end"].map((kind) => {
      const matches = segments.filter((segment) => segment.kind === kind);
      if (matches.length !== 1)
        throw new Error(
          `Expected one ${kind} video marker; found ${matches.length}.`,
        );
      return [kind, matches[0]];
    }),
  );
  const ordered = Object.values(markers);
  if (
    !ordered.every(
      (marker, index) =>
        index === 0 || ordered[index - 1].lastFrame < marker.firstFrame,
    )
  )
    throw new Error("Promo video markers are missing or out of order.");

  const clipStartFrame = markers["clip-start"].lastFrame + 1;
  const clipEndFrameExclusive = markers["clip-end"].firstFrame;
  const sourceVisibleStartFrame = markers["source-start"].lastFrame + 1;
  const sourceVisibleEndFrame = markers["source-end"].firstFrame;
  if (
    clipStartFrame >= sourceVisibleStartFrame ||
    sourceVisibleStartFrame >= sourceVisibleEndFrame ||
    sourceVisibleEndFrame >= clipEndFrameExclusive
  )
    throw new Error("Promo video markers do not bound the visible scenario.");

  const frameRate =
    frameTimestamps.length > 1
      ? 1 / (frameTimestamps[1] - frameTimestamps[0])
      : NaN;
  const clipStartSeconds = frameTimestamps[clipStartFrame];
  const clipEndSeconds = frameTimestamps[clipEndFrameExclusive];
  const sourceVisibleStartSeconds = frameTimestamps[sourceVisibleStartFrame];
  const sourceVisibleEndSeconds = frameTimestamps[sourceVisibleEndFrame];
  const capture = {
    frameRate,
    markers: ordered.map(({ kind, firstFrame, lastFrame }) => ({
      kind,
      firstFrame,
      lastFrame,
    })),
    clipStartFrame,
    clipEndFrameExclusive,
    clipStartSeconds,
    clipEndSeconds,
    durationSeconds: clipEndSeconds - clipStartSeconds,
    sourceVisibleStartFrame,
    sourceVisibleEndFrame,
    sourceVisibleStartSeconds,
    sourceVisibleEndSeconds,
    sourceVisibleDurationSeconds:
      sourceVisibleEndSeconds - sourceVisibleStartSeconds,
  };
  if (
    !Number.isFinite(capture.durationSeconds) ||
    !Number.isFinite(capture.sourceVisibleDurationSeconds) ||
    capture.durationSeconds <= 0 ||
    capture.sourceVisibleDurationSeconds < 2
  )
    throw new Error(
      "Promo recording did not meet its clip or Source hold duration.",
    );
  return capture;
}

export function buildPromoSelectExpression(capture) {
  const clauses = [
    `between(n,${capture.clipStartFrame},${capture.clipEndFrameExclusive - 1})`,
    ...capture.markers.map(
      ({ firstFrame, lastFrame }) =>
        `not(between(n,${firstFrame},${lastFrame}))`,
    ),
  ];
  return `select='${clauses.join("*")}'`;
}

export async function runProcess(
  command,
  args,
  { cwd, env, timeoutMs = 120_000, maxOutputBytes = 32 * 1024 * 1024 } = {},
) {
  return await new Promise((resolveRun, rejectRun) => {
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let abortError = null;
    let timeout;
    let killTimeout;
    const stdout = [];
    const stderr = [];
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const clearTimers = () => {
      if (timeout) clearTimeout(timeout);
      if (killTimeout) clearTimeout(killTimeout);
    };

    const finishError = (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      rejectRun(error);
    };

    const abortProcess = (error) => {
      if (settled || abortError) return;
      abortError = error;
      child.kill("SIGTERM");
      killTimeout = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 2000);
    };

    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        abortProcess(
          new Error(`${basename(command)} timed out after ${timeoutMs} ms.`),
        );
      }, timeoutMs);
    }

    child.once("error", (error) => {
      if (abortError) return;
      finishError(
        new Error(`Could not start ${basename(command)}: ${error.message}`, {
          cause: error,
        }),
      );
    });
    child.stdout.on("data", (chunk) => {
      if (abortError) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes + stderrBytes > maxOutputBytes) {
        abortProcess(
          new Error(
            `${basename(command)} output exceeded ${maxOutputBytes} bytes.`,
          ),
        );
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (abortError) return;
      stderrBytes += chunk.length;
      if (stdoutBytes + stderrBytes > maxOutputBytes) {
        abortProcess(
          new Error(
            `${basename(command)} output exceeded ${maxOutputBytes} bytes.`,
          ),
        );
        return;
      }
      stderr.push(chunk);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (abortError) {
        rejectRun(abortError);
        return;
      }
      const stdoutBuffer = Buffer.concat(stdout);
      const stderrText = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        const status = signal ? `signal ${signal}` : `code ${code}`;
        const diagnostic = stderrText || stdoutBuffer.toString("utf8").trim();
        rejectRun(
          new Error(
            `${basename(command)} exited with ${status}.${diagnostic ? `\n${diagnostic}` : ""}`,
          ),
        );
        return;
      }
      resolveRun({ stdout: stdoutBuffer, stderr: stderrText, code });
    });
  });
}

export async function publishValidatedFiles(entries) {
  if (!Array.isArray(entries) || entries.length === 0)
    throw new Error("No validated promo files were provided for publishing.");
  const targets = entries.map(({ target }) => resolve(target));
  if (new Set(targets).size !== targets.length)
    throw new Error("Promo publish targets must be unique.");
  for (const { source } of entries) {
    if (!existsSync(source))
      throw new Error(`Validated promo output is missing: ${source}`);
  }

  const backupDir = await mkdtemp(
    join(dirname(targets[0]), ".promo-publish-backup-"),
  );
  const backups = [];
  const published = [];
  try {
    for (const [index, target] of targets.entries()) {
      await mkdir(dirname(target), { recursive: true });
      if (!existsSync(target)) continue;
      const backup = join(backupDir, `${index}-${basename(target)}`);
      await rename(target, backup);
      backups.push({ target, backup });
    }
    for (const [index, entry] of entries.entries()) {
      const target = targets[index];
      await rename(entry.source, target);
      published.push(target);
    }
  } catch (error) {
    for (const target of published.reverse())
      await rm(target, { force: true }).catch(() => {});
    for (const { target, backup } of backups.reverse())
      await rename(backup, target).catch(() => {});
    throw new Error(
      `Could not publish the validated promo outputs: ${error.message}`,
      {
        cause: error,
      },
    );
  } finally {
    await rm(backupDir, { recursive: true, force: true });
  }
}
