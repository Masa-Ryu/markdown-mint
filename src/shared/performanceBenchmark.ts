export interface PerformanceBenchmarkRecorder {
  record(name: string, durationMilliseconds: number): void;
  count?(name: string, value: number): void;
  reset?(): void;
}

export interface PerformanceBenchmarkOptions {
  disableTableControls?: boolean;
  disableTableEditing?: boolean;
  disableSpellcheck?: boolean;
  /** Benchmark-only table NodeView that moves horizontal scrolling to a wrapper. */
  tableScrollWrapper?: boolean;
}

export interface PerformanceBenchmarkSelectionEvent {
  at: number;
  phase: string;
  phaseStartedAt: number | null;
  fromPhaseStartMs: number | null;
  from: number;
  to: number;
  head: number;
  anchor: number;
  empty: boolean;
}

export interface PerformanceBenchmarkSelectionTransactionEvent {
  phase: string;
  phaseStartedAt: number | null;
  fromPhaseStartMs: number | null;
  durationMs: number;
}

export interface PerformanceBenchmarkEditorApi {
  setTableCellSelection(
    row: number,
    column: number,
    edge: "start" | "end",
  ): {
    startedAt: number;
    dispatchStartedAt: number;
    completedAt: number;
    selectionPreparationMs: number;
    dispatchMs: number;
    position: number;
    selectionFrom: number;
    selectionTo: number;
    selectionHead: number;
  };
}

declare global {
  const __MM_EDITOR_PERFORMANCE_BENCHMARK__: boolean;
  var __markdownMintPerformanceBenchmark:
    PerformanceBenchmarkRecorder | undefined;
  var __markdownMintPerformanceBenchmarkOptions:
    PerformanceBenchmarkOptions | undefined;
  var __markdownMintBenchmarkPmSelectionChanges:
    PerformanceBenchmarkSelectionEvent[] | undefined;
  var __markdownMintBenchmarkSelectionOnlyTransactions:
    PerformanceBenchmarkSelectionTransactionEvent[] | undefined;
  var __markdownMintBenchmarkEditor: PerformanceBenchmarkEditorApi | undefined;
  var __mmInteractionPhase: string | undefined;
  var __mmInteractionPhaseStartedAt: Record<string, number> | undefined;
  var __mmInteractionPhaseStarts:
    Record<string, number | undefined> | undefined;
}

export function tableControlsDisabledForBenchmark(): boolean {
  if (!__MM_EDITOR_PERFORMANCE_BENCHMARK__) return false;
  return (
    globalThis.__markdownMintPerformanceBenchmarkOptions
      ?.disableTableControls === true
  );
}

export function tableEditingDisabledForBenchmark(): boolean {
  if (!__MM_EDITOR_PERFORMANCE_BENCHMARK__) return false;
  return (
    globalThis.__markdownMintPerformanceBenchmarkOptions
      ?.disableTableEditing === true
  );
}

export function spellcheckDisabledForBenchmark(): boolean {
  if (!__MM_EDITOR_PERFORMANCE_BENCHMARK__) return false;
  return (
    globalThis.__markdownMintPerformanceBenchmarkOptions?.disableSpellcheck ===
    true
  );
}

export function tableScrollWrapperForBenchmark(): boolean {
  if (!__MM_EDITOR_PERFORMANCE_BENCHMARK__) return false;
  return (
    globalThis.__markdownMintPerformanceBenchmarkOptions?.tableScrollWrapper ===
    true
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
