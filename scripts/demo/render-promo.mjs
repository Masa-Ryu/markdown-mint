import { randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  checkFfmpegPrerequisites,
  promoOutputPaths,
  renderPromoMedia,
  validateRecordedRun,
} from "./promo-media.mjs";
import { parseRenderArgs, publishValidatedFiles } from "./promo-utils.mjs";

const repository = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function helpText() {
  return [
    "Usage: npm run demo:promo:render",
    "Re-render MP4/GIF from the current validated output/demo recording without opening Chromium.",
  ].join("\n");
}

async function requireReadable(path, description) {
  try {
    await access(path, fsConstants.R_OK);
  } catch {
    throw new Error(`${description} is missing or unreadable: ${path}`);
  }
}

async function main() {
  const options = parseRenderArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  const paths = promoOutputPaths(repository);
  const ffmpegPath = process.env.MM_FFMPEG ?? "ffmpeg";
  const ffprobePath = process.env.MM_FFPROBE ?? "ffprobe";
  const ffmpeg = await checkFfmpegPrerequisites(
    ffmpegPath,
    ffprobePath,
    repository,
  );
  await Promise.all([
    requireReadable(paths.masterPath, "Validated Playwright recording"),
    requireReadable(paths.sourcePath, "Generated Markdown"),
    requireReadable(paths.reportPath, "Promo report"),
    requireReadable(paths.expectedPath, "Expected Markdown fixture"),
  ]);
  const report = JSON.parse(await readFile(paths.reportPath, "utf8"));
  const validated = await validateRecordedRun({
    masterPath: paths.masterPath,
    sourcePath: paths.sourcePath,
    expectedPath: paths.expectedPath,
    report,
    ffmpegPath,
    ffprobePath,
    cwd: repository,
  });

  const stageDir = resolve(paths.outputDir, `.promo-render-${randomUUID()}`);
  await mkdir(stageDir, { recursive: true });
  try {
    const media = await renderPromoMedia({
      masterPath: paths.masterPath,
      outputDir: stageDir,
      capture: validated.capture,
      ffmpegPath,
      ffprobePath,
      cwd: repository,
    });
    report.renderedAt = new Date().toISOString();
    report.media = { ...media, runId: report.runId };
    report.renderEnvironment = ffmpeg;
    await writeFile(
      resolve(stageDir, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
    await copyFile(
      resolve(stageDir, "markdown-mint-promo.gif"),
      resolve(stageDir, "overview.gif"),
    );
    await publishValidatedFiles([
      {
        source: resolve(stageDir, "markdown-mint-promo.mp4"),
        target: paths.mp4Path,
      },
      {
        source: resolve(stageDir, "markdown-mint-promo.gif"),
        target: paths.gifPath,
      },
      {
        source: resolve(stageDir, "report.json"),
        target: paths.reportPath,
      },
      {
        source: resolve(stageDir, "overview.gif"),
        target: paths.overviewGifPath,
      },
    ]);
    process.stdout.write(`Rendered validated run ${report.runId}.\n`);
    process.stdout.write(
      `MP4: ${media.outputDurationSeconds.toFixed(2)}s, ${formatMiB(media.mp4.sizeBytes)} MiB\n`,
    );
    process.stdout.write(`GIF: ${formatMiB(media.gif.sizeBytes)} MiB\n`);
    if (media.gif.sizeBytes > media.gifSizeTargetBytes)
      process.stdout.write(
        "GIF is above the 5 MiB target and below the 8 MiB limit.\n",
      );
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
}

function formatMiB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
