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

## Pull request CI

Every pull request targeting `main`, every push to `main`, and manual
`workflow_dispatch` runs `.github/workflows/ci.yml`. Its four independent
GitHub-hosted `ubuntu-latest` jobs are:

| Required check    | Validation                                                                              |
| ----------------- | --------------------------------------------------------------------------------------- |
| `quality`         | Node 22, `npm ci`, compile, unit tests, lint, and formatting.                           |
| `browser-smoke`   | Playwright Chromium, block/table interaction suites, and HTML/PDF export browser smoke. |
| `extension-smoke` | Xvfb, a selected/downloaded VS Code build, and `npm run test:extension`.                |
| `package-check`   | `npm run package` and local VSIX verification.                                          |

Each job has read-only `contents` permission and runs on GitHub-hosted runners.
The workflow does not use secrets or `pull_request_target`, and PR code never
runs on the persistent self-hosted release runners. Job duration is written to
the job summary and CI log. Browser screenshots/reports and captured job logs
are uploaded as artifacts even when a job fails; missing artifact paths are
ignored because an early setup failure may leave no files.

The block browser suite exercises all five Markdown profile fixtures listed
above. HTML/PDF browser checks are included in the Phase 1 PR smoke gate after
the first successful local runs: block 57.82s, table 10.74s, HTML export 3.57s,
and PDF export 8.28s. They used macOS 26.7.1 arm64, Node 24.5.0, npm 11.5.1,
Playwright 1.63.0, and Chromium 153.0.8010.12 (revision 1243) already installed
in the Playwright cache. HTML/PDF use the same Chromium installation as the
block/table tests and do not need VS Code or a separate native UI setup. The
local measurements include each build and test command but not a fresh browser
download; CI measures clean-runner setup and job duration separately.

The PDF Extension Host suite passed locally in 20.72s using the installed VS
Code 1.141.2 and the same Chromium cache. It combines VS Code, Chromium, native
host launch, and PDF extraction. Phase 1 keeps this in Phase 2 because the
extension job would need a separate Playwright browser and Linux dependency
installation; the browser and extension jobs intentionally remain
independently reportable. The release workflow does not run the browser or
Extension Host smoke suites.

Each CI job runs on its own GitHub-hosted runner. Browser suites execute in
sequence on their distinct ports 4175 and 4176, and the Extension Host uses
`runner.temp` for isolated profile and workspace directories.

## Required checks on main

After the four CI jobs have completed successfully at least once, require these
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
