/** Select a fence longer than every backtick run in the code body. */
export function codeFenceFor(value: string, preferred = "```"): string {
  const runs = value.match(/`+/g) ?? [];
  const longest = Math.max(0, ...runs.map((run) => run.length));
  const count = Math.max(preferred.length, longest + 1);
  return "`".repeat(Math.max(preferred.length, count));
}

/** Serialize one code block using a fence that cannot be closed by its body. */
export function serializeCodeBlockMarkdown(source: string, info = ""): string {
  const fence = codeFenceFor(source);
  const lineEnding = source.includes("\r\n") ? "\r\n" : "\n";
  return `${fence}${info}${lineEnding}${source}${lineEnding}${fence}`;
}
