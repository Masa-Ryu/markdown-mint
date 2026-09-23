export interface PerformanceBenchmarkRecorder {
  record(name: string, durationMilliseconds: number): void;
  count?(name: string, value: number): void;
  reset?(): void;
  snapshot?(): unknown;
  counterSnapshot?(): unknown;
}

export interface PerformanceBenchmarkOptions {
  disableTableControls?: boolean;
  disableTableEditing?: boolean;
  disableSpellcheck?: boolean;
  /** Benchmark-only table NodeView that moves horizontal scrolling to a wrapper. */
  tableScrollWrapper?: boolean;
  /** Benchmark-only table scroll presentation. */
  tableScrollMode?: "native" | "wrapper" | "proxy" | "threshold";
  /**
   * Legacy threshold field retained for old benchmark JSON. Threshold mode
   * now uses cell count as its primary shape signal; this field is ignored.
   */
  tableScrollProxyOnRows?: number;
  /** Legacy counterpart retained for old benchmark JSON; ignored in cell mode. */
  tableScrollProxyOffRows?: number;
  /** Threshold mode: turn the proxy on at or above this cell count. */
  tableScrollProxyOnCells?: number;
  /** Threshold mode: turn the proxy off below this cell count. */
  tableScrollProxyOffCells?: number;
  /** Benchmark-only proxy scrollbar placement. */
  tableScrollProxyPlacement?: "bottom" | "sticky";
  /** Threshold prototype may confirm horizontal overflow after mount. */
  tableScrollProxyRequiresHorizontalOverflow?: boolean;
  /** Benchmark-only: keep the selection toolbar out of keyboard navigation probes. */
  disableSelectionToolbar?: boolean;
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

export type BenchmarkTableScrollMode = "native" | "wrapper" | "proxy";

/**
 * Resolve a benchmark table presentation from O(1) PM table shape metadata.
 * This helper deliberately uses only row and first-row child counts; it must
 * never walk table cells or read layout while deciding the presentation.
 */
export function classifyTableScrollModeForBenchmark(
  rows: number,
  columns: number,
  previousMode?: BenchmarkTableScrollMode,
): BenchmarkTableScrollMode {
  if (!__MM_EDITOR_PERFORMANCE_BENCHMARK__) return "native";
  const options = globalThis.__markdownMintPerformanceBenchmarkOptions ?? {};
  const configuredMode = options?.tableScrollMode;
  const startedAt = globalThis.performance?.now?.() ?? 0;
  let mode: BenchmarkTableScrollMode = "native";
  if (configuredMode === "proxy") mode = "proxy";
  else if (configuredMode === "wrapper" || options?.tableScrollWrapper)
    mode = "wrapper";
  else if (configuredMode === "threshold") {
    const cells = rows * columns;
    const onCells = Math.max(0, options.tableScrollProxyOnCells ?? Infinity);
    const offCells = Math.max(0, options.tableScrollProxyOffCells ?? onCells);
    const previouslyProxy = previousMode === "proxy";
    const enable = previouslyProxy ? cells >= offCells : cells >= onCells;
    mode = enable ? "proxy" : "native";
  }
  if (globalThis.performance && globalThis.__markdownMintPerformanceBenchmark) {
    try {
      globalThis.__markdownMintPerformanceBenchmark.count?.(
        "tableScroll.classification.calls",
        1,
      );
      globalThis.__markdownMintPerformanceBenchmark.record(
        "tableScroll.classification",
        Math.max(0, (globalThis.performance.now?.() ?? startedAt) - startedAt),
      );
      globalThis.__markdownMintPerformanceBenchmark.count?.(
        `tableScroll.classification.mode.${mode}`,
        1,
      );
      globalThis.__markdownMintPerformanceBenchmark.count?.(
        "tableScroll.classification.rows",
        rows,
      );
      globalThis.__markdownMintPerformanceBenchmark.count?.(
        "tableScroll.classification.columns",
        columns,
      );
    } catch {
      // Benchmark instrumentation must never affect the editor.
    }
  }
  return mode;
}

export function tableScrollNodeViewEnabledForBenchmark(): boolean {
  if (!__MM_EDITOR_PERFORMANCE_BENCHMARK__) return false;
  const mode =
    globalThis.__markdownMintPerformanceBenchmarkOptions?.tableScrollMode;
  return Boolean(
    mode === "wrapper" ||
    mode === "proxy" ||
    mode === "threshold" ||
    tableScrollWrapperForBenchmark(),
  );
}

export function tableScrollProxyPlacementForBenchmark(): "bottom" | "sticky" {
  if (!__MM_EDITOR_PERFORMANCE_BENCHMARK__) return "bottom";
  return (
    globalThis.__markdownMintPerformanceBenchmarkOptions
      ?.tableScrollProxyPlacement ?? "bottom"
  );
}

export function selectionToolbarDisabledForBenchmark(): boolean {
  if (!__MM_EDITOR_PERFORMANCE_BENCHMARK__) return false;
  return (
    globalThis.__markdownMintPerformanceBenchmarkOptions
      ?.disableSelectionToolbar === true
  );
}

export function tableScrollProxyRequiresHorizontalOverflowForBenchmark(): boolean {
  if (!__MM_EDITOR_PERFORMANCE_BENCHMARK__) return false;
  const options = globalThis.__markdownMintPerformanceBenchmarkOptions;
  return (
    options?.tableScrollMode === "threshold" &&
    options.tableScrollProxyRequiresHorizontalOverflow === true
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
