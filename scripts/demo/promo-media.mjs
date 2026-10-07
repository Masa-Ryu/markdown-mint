import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  GIF_SIZE,
  GIF_SIZE_LIMIT_BYTES,
  GIF_SIZE_TARGET_BYTES,
  PROMO_DURATION,
  PROMO_SIZE,
  buildPromoSelectExpression,
  assertExpectedSource,
  locateVideoMarkers,
  readExpectedMarkdown,
  runProcess,
  sha256,
} from "./promo-utils.mjs";

const encodeTimeoutMs = 10 * 60 * 1000;

export async function checkFfmpegPrerequisites(ffmpegPath, ffprobePath, cwd) {
  const [ffmpegVersion, ffprobeVersion, encoders, filters] = await Promise.all([
    runProcess(ffmpegPath, ["-hide_banner", "-version"], { cwd }),
    runProcess(ffprobePath, ["-version"], { cwd }),
    runProcess(ffmpegPath, ["-hide_banner", "-encoders"], { cwd }),
    runProcess(ffmpegPath, ["-hide_banner", "-filters"], { cwd }),
  ]);
  const encoderList = `${encoders.stdout.toString("utf8")}\n${encoders.stderr}`;
  const filterList = `${filters.stdout.toString("utf8")}\n${filters.stderr}`;
  if (!/\blibx264\b/.test(encoderList))
    throw new Error("FFmpeg must include the libx264 H.264 encoder.");
  for (const filter of ["palettegen", "paletteuse"]) {
    if (!new RegExp(`\\b${filter}\\b`).test(filterList))
      throw new Error(`FFmpeg must include the ${filter} filter.`);
  }
  return {
    ffmpeg: firstLine(ffmpegVersion.stdout, ffmpegVersion.stderr),
    ffprobe: firstLine(ffprobeVersion.stdout, ffprobeVersion.stderr),
  };
}

function firstLine(stdout, stderr) {
  return `${stdout.toString("utf8")}\n${stderr}`
    .split(/\r?\n/)
    .find((line) => line.trim())
    ?.trim();
}

export async function inspectVideo(path, ffprobePath, cwd) {
  const result = await runProcess(
    ffprobePath,
    ["-v", "error", "-show_streams", "-show_format", "-of", "json", path],
    { cwd },
  );
  const data = JSON.parse(result.stdout.toString("utf8"));
  const video = data.streams?.find((stream) => stream.codec_type === "video");
  if (!video) throw new Error(`${basename(path)} has no video stream.`);
  const info = {
    codec: video.codec_name,
    width: Number(video.width),
    height: Number(video.height),
    pixelFormat: video.pix_fmt ?? null,
    frameRate: video.avg_frame_rate ?? video.r_frame_rate ?? null,
    durationSeconds: Number(data.format?.duration ?? video.duration),
    sizeBytes: Number(data.format?.size ?? (await stat(path)).size),
    audioStreams: data.streams.filter((stream) => stream.codec_type === "audio")
      .length,
  };
  if (
    !Number.isFinite(info.durationSeconds) ||
    !Number.isFinite(info.sizeBytes) ||
    info.durationSeconds <= 0 ||
    info.sizeBytes <= 0
  )
    throw new Error(`${basename(path)} has invalid duration or size metadata.`);
  return info;
}

export async function inspectRecordingMarkers(
  masterPath,
  ffmpegPath,
  ffprobePath,
  cwd,
) {
  const [frameResult, pixelResult, masterInfo] = await Promise.all([
    runProcess(
      ffprobePath,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_frames",
        "-show_entries",
        "frame=best_effort_timestamp_time",
        "-of",
        "json",
        masterPath,
      ],
      { cwd },
    ),
    runProcess(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        masterPath,
        "-map",
        "0:v:0",
        "-vf",
        "scale=1:1:flags=area",
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      { cwd },
    ),
    inspectVideo(masterPath, ffprobePath, cwd),
  ]);
  const frameData = JSON.parse(frameResult.stdout.toString("utf8"));
  const timestamps = (frameData.frames ?? []).map((frame) =>
    Number(frame.best_effort_timestamp_time),
  );
  if (timestamps.some((timestamp) => !Number.isFinite(timestamp)))
    throw new Error(
      "FFprobe did not return a timestamp for every video frame.",
    );
  if (
    masterInfo.width !== PROMO_SIZE.width ||
    masterInfo.height !== PROMO_SIZE.height
  )
    throw new Error(
      `Playwright recording must be ${PROMO_SIZE.width}x${PROMO_SIZE.height}; got ${masterInfo.width}x${masterInfo.height}.`,
    );

  const capture = locateVideoMarkers(timestamps, pixelResult.stdout);
  const fraction = (masterInfo.frameRate ?? "").split("/").map(Number);
  const reportedRate =
    fraction.length === 2 && fraction[1] > 0
      ? fraction[0] / fraction[1]
      : Number.NaN;
  if (!Number.isFinite(reportedRate) || reportedRate <= 0)
    throw new Error("FFprobe did not report a usable recording frame rate.");
  capture.frameRate = reportedRate;
  capture.master = masterInfo;
  return capture;
}

export async function validateRecordedRun({
  masterPath,
  sourcePath,
  expectedPath,
  report,
  ffmpegPath,
  ffprobePath,
  cwd,
}) {
  if (report.schemaVersion !== 1 || !report.runId)
    throw new Error(
      "Promo report is missing a supported schema version or run id.",
    );
  if (report.scenario?.validated !== true)
    throw new Error(
      "Promo report does not contain a successful scenario validation.",
    );
  const [masterBytes, source, expected] = await Promise.all([
    readFile(masterPath),
    readFile(sourcePath, "utf8"),
    readExpectedMarkdown(expectedPath),
  ]);
  const masterSha256 = sha256(masterBytes);
  const sourceSha256 = sha256(source);
  const expectedSha256 = sha256(expected);
  if (report.capture?.masterSha256 !== masterSha256)
    throw new Error("Recording master does not match the promo report.");
  if (report.scenario?.generatedMarkdownSha256 !== sourceSha256)
    throw new Error("Generated Markdown does not match the promo report.");
  if (report.scenario?.expectedMarkdownSha256 !== expectedSha256)
    throw new Error(
      "Expected Markdown fixture changed since this run was validated.",
    );
  assertExpectedSource(source, expected);

  const capture = report.capture;
  if (
    !Number.isInteger(capture.clipStartFrame) ||
    !Number.isInteger(capture.clipEndFrameExclusive) ||
    !Array.isArray(capture.markers) ||
    !Number.isFinite(capture.frameRate) ||
    capture.frameRate <= 0 ||
    capture.clipStartFrame >= capture.clipEndFrameExclusive
  )
    throw new Error("Promo report has invalid frame boundaries.");
  const currentCapture = await inspectRecordingMarkers(
    masterPath,
    ffmpegPath,
    ffprobePath,
    cwd,
  );
  for (const key of [
    "clipStartFrame",
    "clipEndFrameExclusive",
    "sourceVisibleStartFrame",
    "sourceVisibleEndFrame",
  ]) {
    if (currentCapture[key] !== capture[key])
      throw new Error(`Recording ${key} differs from the promo report.`);
  }
  if (currentCapture.sourceVisibleDurationSeconds < 2)
    throw new Error("Source is visible for less than two recorded seconds.");
  return { masterSha256, sourceSha256, capture: currentCapture };
}

export async function renderPromoMedia({
  masterPath,
  outputDir,
  capture,
  ffmpegPath,
  ffprobePath,
  cwd,
}) {
  const masterInfo = await inspectVideo(masterPath, ffprobePath, cwd);
  if (
    masterInfo.width !== PROMO_SIZE.width ||
    masterInfo.height !== PROMO_SIZE.height
  )
    throw new Error("Promo recording dimensions changed before rendering.");
  await validateDecode(masterPath, ffmpegPath, cwd);

  const mp4Path = join(outputDir, "markdown-mint-promo.mp4");
  const gifPath = join(outputDir, "markdown-mint-promo.gif");
  const select = buildPromoSelectExpression(capture);
  const fps = Number(capture.frameRate.toFixed(6)).toString();
  const videoFilter = `${select},setpts=N/(${fps}*TB),scale=${PROMO_SIZE.width}:${PROMO_SIZE.height}:flags=lanczos`;
  await runProcess(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      masterPath,
      "-map",
      "0:v:0",
      "-an",
      "-vf",
      videoFilter,
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-fps_mode",
      "cfr",
      "-r",
      fps,
      "-movflags",
      "+faststart",
      "-y",
      mp4Path,
    ],
    { cwd, timeoutMs: encodeTimeoutMs },
  );

  const gifFilter =
    `[0:v]${select},setpts=N/(${fps}*TB),fps=12,scale=${GIF_SIZE.width}:${GIF_SIZE.height}:flags=lanczos,split[gif][paletteInput];` +
    `[paletteInput]palettegen=max_colors=256:stats_mode=diff[palette];` +
    `[gif][palette]paletteuse=dither=sierra2_4a:diff_mode=rectangle[output]`;
  await runProcess(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      masterPath,
      "-filter_complex",
      gifFilter,
      "-map",
      "[output]",
      "-an",
      "-loop",
      "0",
      "-y",
      gifPath,
    ],
    { cwd, timeoutMs: encodeTimeoutMs },
  );

  const [mp4, gif] = await Promise.all([
    inspectVideo(mp4Path, ffprobePath, cwd),
    inspectVideo(gifPath, ffprobePath, cwd),
  ]);
  validateMp4(mp4);
  validateGif(gif);
  if (Math.abs(mp4.durationSeconds - gif.durationSeconds) > 1)
    throw new Error("MP4 and GIF durations differ by more than one second.");
  if (
    mp4.durationSeconds < PROMO_DURATION.min ||
    mp4.durationSeconds > PROMO_DURATION.max
  )
    throw new Error(
      `Promo MP4 must be ${PROMO_DURATION.min}-${PROMO_DURATION.max} seconds; got ${mp4.durationSeconds.toFixed(2)} seconds.`,
    );
  if (gif.sizeBytes > GIF_SIZE_LIMIT_BYTES)
    throw new Error(
      `Promo GIF is ${formatMiB(gif.sizeBytes)} MiB; the ${formatMiB(GIF_SIZE_LIMIT_BYTES)} MiB limit was exceeded.`,
    );
  await Promise.all([
    validateDecode(mp4Path, ffmpegPath, cwd),
    validateDecode(gifPath, ffmpegPath, cwd),
  ]);

  return {
    runId: null,
    mp4: { ...mp4, path: "output/demo/markdown-mint-promo.mp4" },
    gif: { ...gif, path: "output/demo/markdown-mint-promo.gif" },
    gifSizeTargetBytes: GIF_SIZE_TARGET_BYTES,
    gifSizeLimitBytes: GIF_SIZE_LIMIT_BYTES,
    sourceFrameRate: capture.frameRate,
    masterDurationSeconds: masterInfo.durationSeconds,
    outputDurationSeconds: mp4.durationSeconds,
    sourceVisibleDurationSeconds: capture.sourceVisibleDurationSeconds,
  };
}

function validateMp4(info) {
  if (
    info.codec !== "h264" ||
    info.width !== PROMO_SIZE.width ||
    info.height !== PROMO_SIZE.height ||
    info.pixelFormat !== "yuv420p" ||
    info.audioStreams !== 0
  )
    throw new Error(
      `MP4 validation failed: expected silent ${PROMO_SIZE.width}x${PROMO_SIZE.height} H.264 yuv420p; received ${JSON.stringify(info)}.`,
    );
}

function validateGif(info) {
  if (
    info.codec !== "gif" ||
    info.width !== GIF_SIZE.width ||
    info.height !== GIF_SIZE.height ||
    info.audioStreams !== 0
  )
    throw new Error(
      `GIF validation failed: expected silent ${GIF_SIZE.width}x${GIF_SIZE.height} GIF; received ${JSON.stringify(info)}.`,
    );
}

async function validateDecode(path, ffmpegPath, cwd) {
  await runProcess(
    ffmpegPath,
    ["-hide_banner", "-v", "error", "-i", path, "-f", "null", "-"],
    { cwd, timeoutMs: encodeTimeoutMs },
  );
}

function formatMiB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2);
}

export function promoOutputPaths(repository) {
  const outputDir = join(repository, "output", "demo");
  return {
    outputDir,
    masterPath: join(outputDir, "markdown-mint-promo.webm"),
    mp4Path: join(outputDir, "markdown-mint-promo.mp4"),
    gifPath: join(outputDir, "markdown-mint-promo.gif"),
    sourcePath: join(outputDir, "generated.md"),
    reportPath: join(outputDir, "report.json"),
    overviewGifPath: join(repository, "docs", "media", "overview.gif"),
    initialPath: join(repository, "docs", "demo", "promo-initial.md"),
    tsvPath: join(repository, "docs", "demo", "promo-table.tsv"),
    expectedPath: join(repository, "docs", "demo", "promo-expected.json"),
  };
}
