# Development and CI

## Local checks

Install the lockfile dependencies with `npm ci`. The focused PR smoke suites
are:

```sh
npm run test:browser:blocks
npm run test:browser:tables
npm run test:extension
```

The browser suites use Playwright Chromium. Install it locally with
`npx playwright install chromium` if it is not already available. Their
screenshots and reports are written below `output/playwright/`.

The Extension Host runner downloads the latest stable VS Code when no installed
VS Code is found. Use these environment variables to choose the test
environment:

| Variable                       | Effect                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `MARKDOWN_MINT_VSCODE_VERSION` | Download and run `stable`, `insiders`, or an exact VS Code version such as `1.105.0`.                                           |
| `MARKDOWN_MINT_CODE`           | Use this VS Code executable path. It takes precedence over the version selector.                                                |
| `MARKDOWN_MINT_TEST_TMP`       | Parent directory for isolated Extension Host and PDF test workspaces. Defaults to the operating system temporary directory.     |
| `VSCODE_MARKDOWN_CSS`          | Use this exact VS Code `markdown.css` file in browser native-preview fixtures. An invalid path fails before the harness starts. |

The browser harness derives `markdown.css` from the selected or installed
VS Code executable. If no stylesheet is found beside an installed executable,
it downloads the selected version (or latest stable) before starting the
server. It never substitutes an empty or synthetic stylesheet. The selected
VS Code version, executable path, and CSS path are printed in the test log.

The five profile fixtures in `tests/md/` are rendered by the block browser
suite: `common-test.md`, `github-test.md`,
`github-test-class-B.md`, `gitlab-test.md`, and
`gitlab-test-class-B.md`.

The native acceptance suite also renders all five fixtures. Its editing checks
use each document's line ending, and its formatter checks explicitly convert
LF to the project's EditorConfig CRLF setting and CRLF to a file-specific LF
override. These expectations do not depend on the operating system default.
Local file paths are compared through `vscode.Uri.file(...).fsPath`, including
Windows drive normalization; Markdown links retain encoded POSIX separators.
`@vscode/test-electron` selects the VS Code download for the current OS and
architecture and handles native process shutdown. The resolver accepts both
legacy `Electron` and current `Code` executable names inside downloaded macOS
bundles, including Insiders. After each run, any native log files are copied to
`output/extension-host/` before temporary workspace deletion;
deletion retries transient file locks on Windows.

## Pull request CI

Every pull request targeting `main`, every push to `main`, and manual
`workflow_dispatch` runs `.github/workflows/ci.yml`. CI and Release use only
standard GitHub-hosted runners for this public repository. Self-hosted runner
setup and Larger runners are unnecessary. The four required check names remain:

| Required check    | Validation                                                                              |
| ----------------- | --------------------------------------------------------------------------------------- |
| `quality`         | Node 22, `npm ci`, compile, unit tests, lint, and formatting.                           |
| `browser-smoke`   | Playwright Chromium, block/table interaction suites, and HTML/PDF export browser smoke. |
| `extension-smoke` | Aggregates the Extension Host matrix; all three OS jobs must succeed.                   |
| `package-check`   | `npm run package` and local VSIX verification.                                          |

`quality`, `browser-smoke`, `package-check`, and the aggregate run on
`ubuntu-24.04`. The actual `extension-host-matrix` jobs use Node 22, `npm ci`,
and `MARKDOWN_MINT_VSCODE_VERSION=stable` on each OS:

| OS      | Runner         | Acceptance command                   |
| ------- | -------------- | ------------------------------------ |
| Linux   | `ubuntu-24.04` | `xvfb-run -a npm run test:extension` |
| Windows | `windows-2025` | `npm run test:extension`             |
| macOS   | `macos-15`     | `npm run test:extension`             |

Linux checks for the runner image's preinstalled `xvfb-run` and fails clearly
if it is missing; no Xvfb installation is needed. Windows and macOS launch
VS Code directly. All matrix commands use Bash (Git Bash on Windows), and each
OS job has a 30-minute timeout. `fail-fast: false` lets every OS finish after a
failure. No job or step ignores test failures. The aggregate uses
`needs: extension-host-matrix` and `always()` and fails for a failed, cancelled,
or skipped matrix result. Cancelling the workflow cannot produce a successful
required check. Existing branch protection therefore requires all three OSes
without changing its check names.

Each CI job has read-only `contents` permission. The workflow uses
`pull_request`, with no secrets or `pull_request_target`. Job duration is
written to the job summary and CI log. Browser screenshots/reports, captured
command logs, and native Extension Host logs are uploaded as artifacts even
when a test fails. Matrix artifact names include the runner OS, run ID, and
attempt to avoid collisions. Missing artifact paths are ignored because an
early setup failure may leave no files.

The block browser suite exercises all five Markdown profile fixtures listed
above. HTML/PDF browser checks are included in the Phase 1 PR smoke gate after
the first successful local runs: block 57.82s, table 10.74s, HTML export 3.57s,
and PDF export 8.28s. They used macOS 26.7.1 arm64, Node 24.5.0, npm 11.5.1,
Playwright 1.63.0, and Chromium 153.0.8010.12 (revision 1243) already installed
in the Playwright cache. HTML/PDF use the same Chromium installation as the
block/table tests and do not need VS Code or a separate native UI setup. The
local measurements include each build and test command but not a fresh browser
download; CI measures clean-runner setup and job duration separately.
The Linux PDF browser fixture passes `--no-sandbox` to its direct Chromium
launch for the hosted runner; extension runtime launch defaults are unchanged.

The PDF Extension Host suite passed locally in 20.72s using the installed VS
Code 1.141.2 and the same Chromium cache. It combines VS Code, Chromium, native
host launch, and PDF extraction. Phase 1 keeps this in Phase 2 because the
extension job would need a separate Playwright browser and Linux dependency
installation; the browser and extension jobs intentionally remain
independently reportable. The release workflow does not run the browser or
Extension Host smoke suites.

Each CI job runs on its own GitHub-hosted runner. Browser suites execute in
sequence on their distinct ports 4175 and 4176, and the Extension Host uses
`runner.temp/markdown-mint-extension` for isolated profile and workspace
directories. Test failures retain their command logs and native logs before
cleanup; any logs left by an interrupted process are also included in the
matrix diagnostic upload.

## Required checks on main

After the CI jobs have completed successfully at least once, require these
status checks for the `main` branch in repository branch protection or a
ruleset:

- `quality`
- `browser-smoke`
- `extension-smoke`
- `package-check`

In GitHub, open **Settings → Branches** (or **Rules → Rulesets**), edit the
rule targeting `main`, enable **Require status checks to pass before merging**,
and add all four check names above. A green workflow run alone does not mean
that branch protection is configured. Record the rule or ruleset state
separately from CI results.

## Release validation

`.github/workflows/release.yml` remains a manual, `main`-only release
workflow. It repeats compile, unit, lint, format, and package validation, then
retains and publishes the exact verified VSIX. Those five checks overlap with
PR CI. The release workflow does not run the browser or Extension Host smoke
suites; PR CI does not create or publish a GitHub Release.

All three Release jobs (`preflight`, `validate`, and `publish_github_release`)
run on `ubuntu-24.04`. The validation and publication jobs check the
preinstalled `gh`, `jq`, `curl`, and `sha256sum` commands before use and fail
with the missing command's name; no extra installation is required. See the
[Ubuntu 24.04 runner image inventory](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md).
No persistent runner or runner-specific credentials need setup.

Preflight rejects refs other than `refs/heads/main` before checkout. Validation
checks out the selected commit with read-only `contents` permission, uses
Node 22 and `npm ci`, and packages exactly one VSIX. It retains that VSIX and
the release notes in an Actions artifact for 90 days and exposes the VSIX
SHA-256. Only `publish_github_release` has `contents: write`: it downloads
the retained payload, verifies its SHA-256, creates or recovers a draft,
downloads and verifies its attached VSIX, and then publishes. The workflow
does not publish to the Marketplace.

If publication fails, rerun **failed jobs** for that workflow run. Recovery
reuses the exact retained VSIX and checksum; it does not rebuild the package.
Do not dispatch Release merely to validate CI changes. YAML/Bash validation
and the workflow/recovery regression suites cover the publication definition
without creating a tag or release.
