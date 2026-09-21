/** Select a fence longer than every backtick run in the code body. */
export function codeFenceFor(value: string, preferred = "```"): string {
  let longest = 0;
  let current = 0;
  for (const character of value) {
    if (character === "`") {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  const count = Math.max(preferred.length, longest + 1);
  return "`".repeat(count);
}

/** Serialize one code block using a fence that cannot be closed by its body. */
export function serializeCodeBlockMarkdown(source: string, info = ""): string {
  const fence = codeFenceFor(source);
  const lineEnding = source.includes("\r\n") ? "\r\n" : "\n";
  return `${fence}${info}${lineEnding}${source}${lineEnding}${fence}`;
}
