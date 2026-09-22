export interface PerformanceBenchmarkRecorder {
  record(name: string, durationMilliseconds: number): void;
}

declare global {
  var __markdownMintPerformanceBenchmark:
    PerformanceBenchmarkRecorder | undefined;
}

declare const __MM_EDITOR_PERFORMANCE_BENCHMARK__: boolean;

export const editorPerformanceBenchmarkEnabled =
  typeof __MM_EDITOR_PERFORMANCE_BENCHMARK__ !== "undefined" &&
  __MM_EDITOR_PERFORMANCE_BENCHMARK__;

/** Measure a synchronous editor operation in the dedicated benchmark bundle. */
export function measureEditorPerformance<T>(
  name: string,
  operation: () => T,
): T {
  if (!editorPerformanceBenchmarkEnabled) return operation();
  const recorder = globalThis.__markdownMintPerformanceBenchmark;
  const now = globalThis.performance?.now?.bind(globalThis.performance);
  if (!recorder || !now) return operation();

  const startedAt = now();
  try {
    return operation();
  } finally {
    try {
      recorder.record(name, now() - startedAt);
    } catch {
      // Benchmark reporting must never change editor behavior.
    }
  }
}
