function fenceCharacter(preferred: string): "`" | "~" {
  return preferred.startsWith("~") ? "~" : "`";
}

function longestFenceRun(value: string, character: "`" | "~"): number {
  let longest = 0;
  let current = 0;
  for (const candidate of value) {
    if (candidate === character) {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}

/** Select a fence longer than every run of its preferred marker. */
export function codeFenceFor(value: string, preferred = "```"): string {
  const character = fenceCharacter(preferred);
  const count = Math.max(
    1,
    preferred.length,
    longestFenceRun(value, character) + 1,
  );
  return character.repeat(count);
}

/** Select a safe block fence without weakening the info string. */
export function codeBlockFenceFor(
  value: string,
  info = "",
  preferred = "```",
): string {
  const character = info.includes("`") ? "~" : fenceCharacter(preferred);
  const minimum = Math.max(3, preferred.length);
  return codeFenceFor(value, character.repeat(minimum));
}

/** Serialize one code block using a fence that cannot be closed by its body. */
export function serializeCodeBlockMarkdown(
  source: string,
  info = "",
  preferred = "```",
): string {
  const fence = codeBlockFenceFor(source, info, preferred);
  const lineEnding = source.includes("\r\n") ? "\r\n" : "\n";
  return `${fence}${info}${lineEnding}${source}${lineEnding}${fence}`;
}
