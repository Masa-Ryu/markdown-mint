# Promotional browser demo

The promotional demo records the real Markdown Mint webview in a local browser
harness. It pastes a fixed TSV through the production editor paste handler,
moves a table column with the table controls, inserts a GitHub TIP Alert, and
checks the Source view against an exact Markdown fixture. The run replaces
`docs/media/overview.gif` only after the scenario, source, recording boundaries,
and exported files pass validation.

The browser harness uses the Source textarea fallback because it does not run
inside VS Code. In VS Code, Markdown Mint's Source command opens the standard
editor. The recording also adds a demo-only pointer ring to show Playwright
input; this ring is not part of the extension.

## Requirements

- Node.js 18 or newer and npm.
- Dependencies installed with `npm ci`.
- Playwright Chromium installed with `npx playwright install chromium`.
- FFmpeg with the `libx264`, `palettegen`, and `paletteuse` encoder and filters,
  plus the matching `ffprobe` command.

The script checks these tools before recording and never installs software.
On macOS, install FFmpeg with `brew install ffmpeg`. On Ubuntu, install it with
`sudo apt-get update` followed by `sudo apt-get install ffmpeg`.

Set `MM_FFMPEG` or `MM_FFPROBE` to use non-default executable paths.
`MM_PROMO_PORT` selects the local browser harness port, and
`MM_PROMO_HEADED=1` starts Chromium with a visible window.

## Run and re-render

Record the browser scenario and update the README GIF:

```sh
npm run demo:promo
```

To watch the browser actions, run:

```sh
npm run demo:promo -- --headed
```

You can choose a free local port with `--port`, for example:

```sh
npm run demo:promo -- --headed --port 4921
```

After changing an encoder option, regenerate MP4 and GIF from the last
validated WebM without repeating browser input:

```sh
npm run demo:promo:render
```

## Outputs and validation

The script writes its reproducible run artifacts under ignored
`output/demo/`:

- `markdown-mint-promo.webm` is the Playwright recording master.
- `markdown-mint-promo.mp4` is the H.264, silent 1280x720 video.
- `markdown-mint-promo.gif` is the silent 960x540 README animation.
- `generated.md` is the Markdown read from the Source view.
- `report.json` records tool versions, scenario values, hashes, frame markers,
  and media metadata.

The master includes colored boundary frames used to find the actual clip and
Source-view timestamps. Those calibration frames are removed from both
exports. The MP4 is expected to run for 15 to 20 seconds. The GIF target is
under 5 MiB and its hard size limit is 8 MiB; GIF timing uses centiseconds, so
FFprobe may report an average rate near 12 fps.

`docs/demo/promo-initial.md`, `docs/demo/promo-table.tsv`, and
`docs/demo/promo-expected.json` are fixed inputs. Its `markdown` string stores
the exact generated source, including terminal blank lines; the generated
Markdown is compared allowing only CRLF/LF newline differences. The report
binds the WebM, expected source, and generated source by SHA-256 so a later
render cannot combine outputs from different runs.

## Recorded validation

The checked-in `docs/media/overview.gif` was produced and visually reviewed on
macOS ARM64 (Darwin 25.6.0), with Node.js 24.5.0, npm 11.5.1, Playwright 1.63.0,
and FFmpeg/FFprobe 9.0.1. The browser harness rendered the GitHub profile and
the Source textarea displayed all generated Markdown lines. Both exported
formats were inspected at the README display width. Ubuntu setup instructions
are provided above; Ubuntu recording has not been run as part of this
validation.
