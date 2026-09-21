/**
 * Merge Markdown snapshots without treating a version number as a patch.
 *
 * The merge is deliberately conservative: independent line hunks are joined,
 * while overlapping edits (including different insertions at one position)
 * return undefined. Callers can then retain both snapshots for an explicit
 * user decision instead of silently replacing one with the other.
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

/** Return a merged Markdown source, or undefined when the edits overlap. */
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
  const externalHunks = diffHunks(baseLines, splitLines(external));
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
): ChangeHunk[] {
  const operations = myersDiff(base, variant);
  const hunks: ChangeHunk[] = [];
  let baseIndex = 0;
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

/** Myers' O((N+M)D) diff keeps the merge usable for large Markdown files. */
function myersDiff(
  base: readonly string[],
  variant: readonly string[],
): DiffOperation[] {
  const max = base.length + variant.length;
  const trace: Array<Map<number, number>> = [];
  let frontier = new Map<number, number>([[1, 0]]);

  for (let distance = 0; distance <= max; distance += 1) {
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const down = frontier.get(diagonal + 1) ?? 0;
      const right = frontier.get(diagonal - 1) ?? -1;
      let x =
        diagonal === -distance || (diagonal !== distance && down > right)
          ? down
          : right + 1;
      let y = x - diagonal;
      while (x < base.length && y < variant.length && base[x] === variant[y]) {
        x += 1;
        y += 1;
      }
      frontier.set(diagonal, x);
      if (x >= base.length && y >= variant.length) {
        trace.push(new Map(frontier));
        return backtrackDiff(trace, distance, base, variant, x, y);
      }
    }
    // Store the completed frontier. Backtracking from distance d needs the
    // frontier completed at distance d - 1.
    trace.push(new Map(frontier));
  }
  return [];
}

function backtrackDiff(
  trace: readonly Map<number, number>[],
  endDistance: number,
  base: readonly string[],
  variant: readonly string[],
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
      operations.push({ kind: "equal", value: base[x - 1] ?? "" });
      x -= 1;
      y -= 1;
    }
    if (x === previousX) {
      operations.push({ kind: "insert", value: variant[y - 1] ?? "" });
      y -= 1;
    } else {
      operations.push({ kind: "delete", value: base[x - 1] ?? "" });
      x -= 1;
    }
  }

  while (x > 0 && y > 0) {
    operations.push({ kind: "equal", value: base[x - 1] ?? "" });
    x -= 1;
    y -= 1;
  }
  while (x > 0) {
    operations.push({ kind: "delete", value: base[x - 1] ?? "" });
    x -= 1;
  }
  while (y > 0) {
    operations.push({ kind: "insert", value: variant[y - 1] ?? "" });
    y -= 1;
  }
  operations.reverse();
  return operations;
}
