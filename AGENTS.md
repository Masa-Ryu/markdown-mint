# Repository Guidelines

## Repository Overview

This repository contains the TypeScript Markdown Mint VS Code extension.
`src/core` owns the Markdown/ProseMirror model, `src/extension` owns the VS
Code host, `src/webview` owns the dedicated editor UI, and `src/shared` owns
the validated host/webview protocol. `media/document.css` is also contributed
to VS Code's native Markdown preview.

## Structure and Conventions

Keep production code in `src/`, tests in the parallel `tests/` tree, and
project documentation in `docs/`. `scripts/build.mjs` bundles the extension,
webview, and native acceptance runner into `dist/`; generated `dist/`,
`output/`, and `.playwright-cli/` content is ignored. Use strict TypeScript,
ES modules in source, and Prettier formatting.

## Testing and Validation

Run `npm run compile`, `npm test`, `npm run lint`, and `npm run format:check`
before review. `npm run test:extension` launches the installed VS Code
Extension Development Host with an isolated temporary workspace and runs the
native acceptance suite. `npm run package` builds and verifies the local VSIX.
If a behavior requires visual or IME inspection, record the manual check in
the requirements documentation.

テスト時には以下のファイルで正しく表示されていることを確認すること。
- ./tests/md/common-test.md
- ./tests/md/github-test.md
- ./tests/md/github-test-class-B.md
- ./tests/md/gitlab-test.md
- ./tests/md/gitlab-test-class-B.md

## Commits and Pull Requests

Use short, imperative commit subjects focused on one change. Keep pull
requests focused, describe the motivation and behavioral impact, list
validation performed, and update documentation when user-facing behavior or
setup changes. Reviewers should be able to understand the change from the PR
description without reconstructing intent from the diff alone.

作業が完了したらPushしてPullrequestの内容を書き上げること。
issueが見つからない時はissue番号はないです。

### Version update rule

Update the version for every completed task. Determine the required PATCH,
MINOR, or MAJOR bump from the final pull request diff.

Determine the version once per pull request relative to its base branch. Do not
bump the version again for additional commits or review fixes within the same
pull request. If the scope changes, reassess the final diff and use the highest
required SemVer level.

### SemVer rules

Use the same PATCH, MINOR, and MAJOR rules for all versions, including `0.x`.
Breaking changes require a MAJOR bump.

* **PATCH** (`x.y.Z`): backward-compatible fixes and maintenance that do not add
  substantial new user-facing functionality. This includes bug fixes,
  regressions, rendering, keyboard, cursor, focus, IME, performance, stability,
  security, dependency updates, packaging, documentation, tests, and internal
  refactoring.
* **MINOR** (`x.Y.0`): backward-compatible new user-facing functionality or a
  substantial extension of an existing feature. This includes new Markdown
  capabilities, commands, settings, toolbar actions, dialogs, and editing
  workflows.
* **MAJOR** (`X.0.0`): changes that break existing user-facing behavior or
  compatibility. This includes removing or incompatibly changing commands,
  settings, supported Markdown behavior, serialization, source round-trip
  behavior, defaults, minimum VS Code requirements, or persistent data formats.

### Compatibility boundaries

Treat changes to the following as compatibility-sensitive when deciding whether
a change is breaking:

* documented editor behavior
* supported Markdown syntax
* CommonMark, GitHub, and GitLab profile behavior
* Markdown serialization and source round-trip behavior
* VS Code command IDs
* `markdownMint.*` configuration keys, types, defaults, and documented behavior
* `engines.vscode`
* persistent configuration and data formats

Internal TypeScript APIs and implementation details are not compatibility
boundaries unless they affect one of the items above. Internal-only changes are
PATCH changes.
