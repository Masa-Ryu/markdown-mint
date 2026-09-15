process.env.MM_FILE_SEARCH_BENCHMARK = "1";
process.env.MM_BLOCK_BROWSER_CASE = "WorkspaceFileAutocompleteBenchmark";
await import("../tests/browser/block-editing.test.mjs");
