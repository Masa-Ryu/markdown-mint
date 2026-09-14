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
issueが見つからない時はissue番号はないです。

## Versioning and Releases

Markdown Mint follows Semantic Versioning (SemVer). The authoritative project
version is `package.json`'s `version` field. The project versions in
`package.json` and `package-lock.json` must always match. Version numbers
describe the meaning of the changes included in a release; they must not be
incremented merely because a task, commit, pull request, refactor, or test
addition was completed.

Change the version only when preparing a release or when the user explicitly
requests a version change. A local VSIX built for inspection or validation does
not require a version bump. Do not add release automation or GitHub Actions
solely to enforce these rules.

For releases from `1.0.0` onward, apply the normal SemVer rules. If a release
contains several kinds of changes, use the highest required bump exactly once
for the release:

- **PATCH** (`x.y.Z`): backward-compatible bug fixes and conservative
  maintenance, including table, cursor, keyboard, IME, focus, rendering,
  Mermaid, Alert/Details/Code block layout, regression, performance,
  stability, security, dependency, packaging, README, or Marketplace metadata
  fixes when a new release is needed.
- **MINOR** (`x.Y.0`): backward-compatible new user-facing functionality,
  including new Markdown editing or syntax support, Mermaid syntax validation,
  Excel/Spreadsheet/TSV-to-Table generation, VS Code commands,
  `markdownMint.*` settings, toolbar actions, dialogs, editing workflows,
  substantial compatible extensions, or deprecations that do not remove
  existing behavior.
- **MAJOR** (`X.0.0`): an intentional incompatibility with existing users,
  including removing or renaming a `markdownMint.*` setting or command ID,
  changing configuration type or meaning incompatibly, removing supported
  GitHub/GitLab/CommonMark behavior, changing Markdown serialization or
  existing-file rewriting incompatibly, breaking source round-trip guarantees,
  changing a default in a workflow-breaking way, raising the minimum VS Code
  version incompatibly, or changing a persistent configuration/data format
  incompatibly.

Treat the following as Markdown Mint's public compatibility contract for SemVer
decisions: documented editor behavior; supported Markdown syntax;
CommonMark/GitHub/GitLab profile behavior; Markdown serialization; source
round-trip guarantees; VS Code command identifiers; every `markdownMint.*`
configuration key, type, default, and documented meaning; `engines.vscode`; and
persistent configuration/data formats. Internal TypeScript APIs and other
implementation details that are not explicitly exposed to consumers are not
public APIs for SemVer purposes. Internal refactoring alone must not trigger a
MINOR or MAJOR bump.

Before `1.0.0`, Markdown Mint uses one consistent `0.x` rule for the complete
release:

1. If any new user-facing feature, substantial feature extension, or
   intentional compatibility change is included, use **MINOR** (`0.Y.0`).
2. Otherwise, if the release contains changes that need to be published, use
   **PATCH** (`0.y.Z`).
3. If no release is being made, do not change the version.

During `0.x`, breaking changes are treated as MINOR and must not automatically
become `1.0.0`. MINOR examples include new Markdown capabilities, commands,
settings, toolbar actions, dialogs, workflows, substantial feature extensions,
intentional documented behavior changes, command or configuration breaking
changes, Markdown serialization or supported-profile breaking changes, source
round-trip breaking changes, and any change users would recognize as a new
feature or a specification change. PATCH examples include bug or regression
fixes, rendering and keyboard/cursor/focus/IME fixes, performance or reliability
improvements, security and dependency maintenance, documentation, README or
Marketplace metadata updates, packaging fixes, and releasable internal
maintenance that does not meet the MINOR criteria.

For `0.x`, decide once for the release as a whole; do not bump once per change.
For example: bug fix only, or bug fix plus documentation, is PATCH; a new
feature, a breaking change, or either combined with bug fixes is MINOR; tests or
refactoring only with no release is no version bump. Do not continue an
indefinite `0.0.x`-only workflow: feature or compatibility changes must advance
the minor component to `0.Y.0`.

### Transition to `1.0.0`

Release `1.0.0` only when Markdown Mint is ready to begin a formal compatibility
contract across future releases for its documented user-facing behavior and
public compatibility contract. Development duration, release count, or feature
count alone must never be used as the reason to release `1.0.0`. After `1.0.0`,
apply the normal PATCH/MINOR/MAJOR SemVer rules above.

### Release version update procedure

During release preparation, update the version with npm rather than editing
`package.json` and `package-lock.json` separately. Run exactly one required bump:

```bash
npm version patch --no-git-tag-version
npm version minor --no-git-tag-version
npm version major --no-git-tag-version
```

During `0.x`, follow the existing `0.x` rule and normally use `patch` or
`minor`. If the release contents change after the bump and the required SemVer
level may have changed, reassess the final release contents and update the
version accordingly before publishing.

After changing the version, perform at least these checks:

1. Confirm that `package.json` and `package-lock.json` contain the same version.
2. Confirm that `CHANGELOG.md` has a section for that exact version.
3. Confirm that the `CHANGELOG.md` section accurately describes the release
   contents.
4. Run `npm run compile`.
5. Run `npm test`.
6. Run `npm run lint`.
7. Run `npm run format:check`.
8. Run the required extension and acceptance tests.
9. Run `npm run package`.
10. Confirm that the generated VSIX has the intended version.

### Git tag policy

Formal release tags must use the exact format `vX.Y.Z`, for example:

```text
v0.1.0
v1.4.2
```

Create a tag only after the release contents and version are final. Never reuse
or overwrite a version or tag that has already been formally released. If a
published release needs a correction, publish a new version instead; for
example, `v0.1.0` must be followed by `v0.1.1`, not by replacing the contents of
`v0.1.0`.

### VS Code Marketplace pre-release

Do not confuse the VS Code Marketplace pre-release publishing mechanism with a
SemVer pre-release suffix. The following forms are not part of Markdown Mint's
normal VS Code extension versioning operation:

```text
1.2.0-beta.1
1.2.0-rc.1
```

Treat Marketplace pre-release publishing as the Marketplace's separate
pre-release mechanism. Keep it separate from the ordinary PATCH/MINOR/MAJOR
version bump decision.
