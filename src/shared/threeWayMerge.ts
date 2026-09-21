/**
 * Merge Markdown snapshots without treating a version number as a patch.
 *
 * The merge is deliberately conservative: independent line hunks are joined,
 * while overlapping edits (including different insertions at one position) or
 * a diff that exceeds its deterministic safety budget return undefined.
 * Callers can then retain both snapshots for an explicit user decision
 * instead of silently replacing one with the other.
 */

interface ChangeHunk {
  readonly start: number;
  readonly end: number;
  readonly replacement: readonly string[];
}

interface DiffOperation {
  readonly kind: "equal" | "insert" | "delete";
  readonly value: string;
}

/**
 * Keep one diff attempt bounded independently of the Markdown source size.
 *
 * The work budget covers comparisons and frontier visits. The trace budget is
 * counted separately because backtracking needs every completed frontier, and
 * that retained state is the expensive part of a broad diff.
 */
const MAX_DIFF_WORK_UNITS = 4_000_000;
const MAX_DIFF_TRACE_CELLS = 250_000;
const MAX_SIMPLE_REPLACEMENT_PROBE_LINES = 64;

interface DiffBudget {
  workUnits: number;
  traceCells: number;
}

/** Return a merged Markdown source, or undefined when safe merging is unavailable. */
export function mergeMarkdownSnapshots(
  base: string,
  local: string,
  external: string,
): string | undefined {
  if (local === external) return local;
  if (local === base) return external;
  if (external === base) return local;

  const baseLines = splitLines(base);
  const localHunks = diffHunks(baseLines, splitLines(local));
  if (localHunks === undefined) return undefined;
  const externalHunks = diffHunks(baseLines, splitLines(external));
  if (externalHunks === undefined) return undefined;
  const mergedHunks: ChangeHunk[] = [...localHunks];

  for (const candidate of externalHunks) {
    const identical = mergedHunks.some(
      (existing) =>
        existing.start === candidate.start &&
        existing.end === candidate.end &&
        sameLines(existing.replacement, candidate.replacement),
    );
    if (identical) continue;
    if (mergedHunks.some((existing) => hunksConflict(existing, candidate)))
      return undefined;
    mergedHunks.push(candidate);
  }

  mergedHunks.sort((left, right) => {
    const byStart = left.start - right.start;
    if (byStart !== 0) return byStart;
    // An insertion at the start of a replacement belongs before that
    // replacement. Insertions at the end naturally sort after it by start.
    if (left.end === left.start && right.end !== right.start) return -1;
    if (left.end !== left.start && right.end === right.start) return 1;
    return left.end - right.end;
  });

  const result: string[] = [];
  let cursor = 0;
  for (const hunk of mergedHunks) {
    if (hunk.start < cursor) return undefined;
    appendLines(result, baseLines, cursor, hunk.start);
    appendLines(result, hunk.replacement);
    cursor = hunk.end;
  }
  appendLines(result, baseLines, cursor);
  return result.join("");
}

function appendLines(
  target: string[],
  source: readonly string[],
  start = 0,
  end = source.length,
): void {
  for (let index = start; index < end; index += 1) {
    const line = source[index];
    if (line !== undefined) target.push(line);
  }
}

function splitLines(value: string): string[] {
  if (!value) return [];
  const lines = value.split(/(?<=\n)/u);
  return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
}

function diffHunks(
  base: readonly string[],
  variant: readonly string[],
): ChangeHunk[] | undefined {
  const budget: DiffBudget = { workUnits: 0, traceCells: 0 };
  let prefixLength = 0;
  while (prefixLength < base.length && prefixLength < variant.length) {
    if (!consumeWork(budget)) return undefined;
    if (base[prefixLength] !== variant[prefixLength]) break;
    prefixLength += 1;
  }

  // Keep the full suffix in Myers. Trimming a repeated-line suffix can change
  // which base occurrence is treated as unchanged, turning a conflict at one
  // insertion position into two apparently independent edits.
  const baseEnd = base.length;
  const variantEnd = variant.length;

  const simpleReplacement = simpleReplacementHunk(
    base,
    variant,
    prefixLength,
    baseEnd,
    variantEnd,
    budget,
  );
  if (simpleReplacement !== null) {
    return simpleReplacement === undefined ? undefined : [simpleReplacement];
  }

  const operations = myersDiff(
    base,
    variant,
    prefixLength,
    baseEnd,
    prefixLength,
    variantEnd,
    budget,
  );
  if (operations === undefined) return undefined;
  const hunks: ChangeHunk[] = [];
  let baseIndex = prefixLength;
  let index = 0;
  while (index < operations.length) {
    const operation = operations[index];
    if (!operation || operation.kind === "equal") {
      if (operation) baseIndex += 1;
      index += 1;
      continue;
    }

    const start = baseIndex;
    const replacement: string[] = [];
    while (index < operations.length) {
      const current = operations[index];
      if (!current || current.kind === "equal") break;
      if (current.kind === "delete") baseIndex += 1;
      else replacement.push(current.value);
      index += 1;
    }
    hunks.push({ start, end: baseIndex, replacement });
  }
  return hunks;
}

/**
 * A pure insertion/deletion or a replacement with no shared line has one
 * unambiguous hunk. Recognize it without asking Myers to enumerate thousands
 * of edit distances (the long replacement regression is one such case).
 */
function simpleReplacementHunk(
  base: readonly string[],
  variant: readonly string[],
  start: number,
  baseEnd: number,
  variantEnd: number,
  budget: DiffBudget,
): ChangeHunk | null | undefined {
  const baseLength = baseEnd - start;
  const variantLength = variantEnd - start;
  if (baseLength === 0 || variantLength === 0)
    return {
      start,
      end: baseEnd,
      replacement: variant.slice(start, variantEnd),
    };
  if (
    baseLength > MAX_SIMPLE_REPLACEMENT_PROBE_LINES &&
    variantLength > MAX_SIMPLE_REPLACEMENT_PROBE_LINES
  )
    return null;

  // A small base side can still pair with a large insertion. If the only
  // shared lines are a unique, contiguous suffix, that suffix is an
  // unambiguous snake and the changed range can be returned directly. Do not
  // use this shortcut for repeated suffix lines: their occurrence may be the
  // alignment that a conservative merge must leave in conflict.
  let suffixLength = 0;
  while (baseEnd - suffixLength > start && variantEnd - suffixLength > start) {
    if (!consumeWork(budget)) return undefined;
    if (
      base[baseEnd - suffixLength - 1] !==
      variant[variantEnd - suffixLength - 1]
    )
      break;
    suffixLength += 1;
  }
  if (suffixLength > 0) {
    const baseCounts = new Map<string, number>();
    const variantCounts = new Map<string, number>();
    for (let index = start; index < baseEnd; index += 1) {
      if (!consumeWork(budget)) return undefined;
      const value = base[index];
      if (value !== undefined)
        baseCounts.set(value, (baseCounts.get(value) ?? 0) + 1);
    }
    for (let index = start; index < variantEnd; index += 1) {
      if (!consumeWork(budget)) return undefined;
      const value = variant[index];
      if (value !== undefined)
        variantCounts.set(value, (variantCounts.get(value) ?? 0) + 1);
    }
    const uniqueSuffix = Array.from(
      { length: suffixLength },
      (_, index) => base[baseEnd - suffixLength + index],
    ).every(
      (value) =>
        value !== undefined &&
        baseCounts.get(value) === 1 &&
        variantCounts.get(value) === 1,
    );
    if (uniqueSuffix) {
      const middleBaseEnd = baseEnd - suffixLength;
      const middleVariantEnd = variantEnd - suffixLength;
      const middleValues = new Set<string>();
      for (let index = start; index < middleBaseEnd; index += 1) {
        if (!consumeWork(budget)) return undefined;
        const value = base[index];
        if (value !== undefined) middleValues.add(value);
      }
      let sharedMiddleLine = false;
      for (let index = start; index < middleVariantEnd; index += 1) {
        if (!consumeWork(budget)) return undefined;
        const value = variant[index];
        if (value !== undefined && middleValues.has(value)) {
          sharedMiddleLine = true;
          break;
        }
      }
      if (!sharedMiddleLine)
        return {
          start,
          end: middleBaseEnd,
          replacement: variant.slice(start, middleVariantEnd),
        };
    }
  }

  const larger = baseLength >= variantLength ? base : variant;
  const largerStart = start;
  const largerEnd = baseLength >= variantLength ? baseEnd : variantEnd;
  const smaller = baseLength >= variantLength ? variant : base;
  const smallerEnd = baseLength >= variantLength ? variantEnd : baseEnd;
  const values = new Set<string>();
  for (let index = largerStart; index < largerEnd; index += 1) {
    if (!consumeWork(budget)) return undefined;
    const value = larger[index];
    if (value !== undefined) values.add(value);
  }
  for (let index = start; index < smallerEnd; index += 1) {
    if (!consumeWork(budget)) return undefined;
    const value = smaller[index];
    if (value !== undefined && values.has(value)) return null;
  }
  return { start, end: baseEnd, replacement: variant.slice(start, variantEnd) };
}

function hunksConflict(left: ChangeHunk, right: ChangeHunk): boolean {
  const leftInsertion = left.start === left.end;
  const rightInsertion = right.start === right.end;
  if (leftInsertion && rightInsertion) return left.start === right.start;
  if (leftInsertion) return right.start < left.start && left.start < right.end;
  if (rightInsertion) return left.start < right.start && right.start < left.end;
  return left.start < right.end && right.start < left.end;
}

function sameLines(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((line, index) => line === right[index])
  );
}

/** Myers' O((N+M)D) diff with bounded search and backtracking state. */
function myersDiff(
  base: readonly string[],
  variant: readonly string[],
  baseStart: number,
  baseEnd: number,
  variantStart: number,
  variantEnd: number,
  budget: DiffBudget,
): DiffOperation[] | undefined {
  const baseLength = baseEnd - baseStart;
  const variantLength = variantEnd - variantStart;
  const max = baseLength + variantLength;
  const trace: Array<Map<number, number>> = [];
  let frontier = new Map<number, number>([[1, 0]]);

  for (let distance = 0; distance <= max; distance += 1) {
    const nextFrontier = new Map<number, number>();
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      if (!consumeWork(budget)) return undefined;
      const down = frontier.get(diagonal + 1) ?? 0;
      const right = frontier.get(diagonal - 1) ?? -1;
      let x =
        diagonal === -distance || (diagonal !== distance && down > right)
          ? down
          : right + 1;
      let y = x - diagonal;
      while (x < baseLength && y < variantLength) {
        if (!consumeWork(budget)) return undefined;
        if (base[baseStart + x] !== variant[variantStart + y]) break;
        x += 1;
        y += 1;
      }
      nextFrontier.set(diagonal, x);
    }
    // Store only the frontier for this distance. Retaining the old cumulative
    // map makes the trace grow quadratically before the trace is even copied.
    if (!retainTrace(trace, nextFrontier, budget)) return undefined;
    const endpoint = nextFrontier.get(baseLength - variantLength);
    if (
      endpoint !== undefined &&
      endpoint >= baseLength &&
      endpoint - (baseLength - variantLength) >= variantLength
    ) {
      return backtrackDiff(
        trace,
        distance,
        base,
        variant,
        baseStart,
        variantStart,
        endpoint,
        endpoint - (baseLength - variantLength),
      );
    }
    frontier = nextFrontier;
  }
  return undefined;
}

function consumeWork(budget: DiffBudget): boolean {
  budget.workUnits += 1;
  return budget.workUnits <= MAX_DIFF_WORK_UNITS;
}

function retainTrace(
  trace: Array<Map<number, number>>,
  frontier: Map<number, number>,
  budget: DiffBudget,
): boolean {
  budget.traceCells += frontier.size;
  if (budget.traceCells > MAX_DIFF_TRACE_CELLS) return false;
  trace.push(frontier);
  return true;
}

function backtrackDiff(
  trace: readonly Map<number, number>[],
  endDistance: number,
  base: readonly string[],
  variant: readonly string[],
  baseStart: number,
  variantStart: number,
  endX: number,
  endY: number,
): DiffOperation[] {
  const operations: DiffOperation[] = [];
  let x = endX;
  let y = endY;

  for (let distance = endDistance; distance > 0; distance -= 1) {
    // trace[d] is the frontier before processing distance d. The edit that
    // led to the current point therefore comes from trace[d - 1].
    const frontier = trace[distance - 1];
    if (!frontier) break;
    const diagonal = x - y;
    const down = frontier.get(diagonal + 1) ?? -1;
    const right = frontier.get(diagonal - 1) ?? -1;
    const previousDiagonal =
      diagonal === -distance || (diagonal !== distance && down > right)
        ? diagonal + 1
        : diagonal - 1;
    const previousX = frontier.get(previousDiagonal) ?? 0;
    const previousY = previousX - previousDiagonal;

    while (x > previousX && y > previousY) {
      operations.push({
        kind: "equal",
        value: base[baseStart + x - 1] ?? "",
      });
      x -= 1;
      y -= 1;
    }
    if (x === previousX) {
      operations.push({
        kind: "insert",
        value: variant[variantStart + y - 1] ?? "",
      });
      y -= 1;
    } else {
      operations.push({
        kind: "delete",
        value: base[baseStart + x - 1] ?? "",
      });
      x -= 1;
    }
  }

  while (x > 0 && y > 0) {
    operations.push({
      kind: "equal",
      value: base[baseStart + x - 1] ?? "",
    });
    x -= 1;
    y -= 1;
  }
  while (x > 0) {
    operations.push({
      kind: "delete",
      value: base[baseStart + x - 1] ?? "",
    });
    x -= 1;
  }
  while (y > 0) {
    operations.push({
      kind: "insert",
      value: variant[variantStart + y - 1] ?? "",
    });
    y -= 1;
  }
  operations.reverse();
  return operations;
}
