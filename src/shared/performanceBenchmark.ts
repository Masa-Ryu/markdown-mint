export interface PerformanceBenchmarkRecorder {
  record(name: string, durationMilliseconds: number): void;
  count?(name: string, value: number): void;
}

export interface PerformanceBenchmarkOptions {
  disableTableControls?: boolean;
}

declare global {
  const __MM_EDITOR_PERFORMANCE_BENCHMARK__: boolean;
  var __markdownMintPerformanceBenchmark:
    PerformanceBenchmarkRecorder | undefined;
  var __markdownMintPerformanceBenchmarkOptions:
    PerformanceBenchmarkOptions | undefined;
}

export function tableControlsDisabledForBenchmark(): boolean {
  if (!__MM_EDITOR_PERFORMANCE_BENCHMARK__) return false;
  return (
    globalThis.__markdownMintPerformanceBenchmarkOptions
      ?.disableTableControls === true
  );
}

/** Record a benchmark-only integer counter without affecting editor behavior. */
export function recordEditorPerformanceCount(
  name: string,
  value: number,
): void {
  if (!__MM_EDITOR_PERFORMANCE_BENCHMARK__) return;
  try {
    globalThis.__markdownMintPerformanceBenchmark?.count?.(name, value);
  } catch {
    // Benchmark reporting must never change editor behavior.
  }
}

/** Record a benchmark-only timing segment inside a larger measured operation. */
export function recordEditorPerformanceDuration(
  name: string,
  durationMilliseconds: number,
): void {
  if (!__MM_EDITOR_PERFORMANCE_BENCHMARK__) return;
  try {
    globalThis.__markdownMintPerformanceBenchmark?.record(
      name,
      durationMilliseconds,
    );
  } catch {
    // Benchmark reporting must never change editor behavior.
  }
}

/** Measure a synchronous editor operation in the dedicated benchmark bundle. */
export function measureEditorPerformance<T>(
  name: string,
  operation: () => T,
): T {
  if (!__MM_EDITOR_PERFORMANCE_BENCHMARK__) return operation();
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
