計画は最上位モデルで、実装作業はサブエージェントの GPT-5.6 Luna Max で実施する。

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
- ./md/common-test.md
- ./md/github-test.md
- ./md/github-test-class-B.md
- ./md/gitlab-test.md
- ./md/gitlab-test-class-B.md

## Commits and Pull Requests

Use short, imperative commit subjects focused on one change. Keep pull
requests focused, describe the motivation and behavioral impact, list
validation performed, and update documentation when user-facing behavior or
setup changes. Reviewers should be able to understand the change from the PR
description without reconstructing intent from the diff alone.

作業が完了したらPushしてPullrequestの内容を書き上げること。
作業終了後にバージョンを適切なバージョンを上げて、VSIXを作成すること。
