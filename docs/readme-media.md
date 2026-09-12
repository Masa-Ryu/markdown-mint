# README media provenance

The README uses captured product output, not generated UI mock-ups.

## Capture

- Product base: `78b4202da0f2e5dc8922b9e97ff8c311181732c7` (0.0.23).
- Capture source: `73b7a8ccd80a89cf1f4212209eb1f818c04e49c8`.
- Successful run: https://github.com/Masa-Ryu/markdown-mint/actions/runs/34677294933.
- Runtime: the actual bundled `dist/webview.js`, `dist/mermaid.js`, and document/editor styles, running in the existing browser harness with a simulated asynchronous VS Code host transport.
- Environment: Ubuntu 24.04, Chromium supplied by Playwright 1.58.2, dark theme tokens, system font at 14px, device scale factor 1.
- The images show the editor webview, not the surrounding native VS Code window. They are not evidence of native Extension Host or operating-system IME correctness.
- Sample documents contain fictional release-plan data. Page requests are restricted to the local capture server; no workspace documents are sent to an external service.

## Assets

- `images/readme/editor.png`: 1180 x 760, editing overview.
- `images/readme/diagrams.png`: 1180 x 760, rendered Mermaid, equation, and note.
- `images/readme/table-demo.gif`: 1080 x 650, captured states from actual mouse and keyboard operations, approximately seven seconds, looping.
- `images/readme/table-paste.png`: static fallback showing the paste result.

The demo activates the table before measuring cell coordinates because contextual controls change layout. It then uses a real drag gesture to select the expected six cells, real clipboard keyboard commands to paste into two empty rows, and one Undo to restore the original Markdown. Assertions check the selected text, resulting document, and restoration. No cell values or selection highlights are drawn into the captures.

## Validation

The successful capture run passed the build, compile, lint, unit tests, and repository formatting check. The produced assets and five significant animation frames were inspected separately. This run did not run native Extension Host tests or generate a release VSIX.

The workflow is now manual-only and read-only. Run **Capture README media** from Actions to create a new artifact; inspect it before committing replacement assets. It never publishes the extension or pushes to a branch. Capture tooling remains separate from production dependencies.

## Marketplace image hosting

Relative images work for viewers with access to this repository. While it remains private, those repository image URLs are not a public image host for Marketplace visitors. Before publishing the visual README, place these non-sensitive images at a public HTTPS location and configure the image base URL or replace their links. Do not make the source repository public as a side effect.

Official publishing requirements: https://code.visualstudio.com/api/working-with-extensions/publishing-extension.
