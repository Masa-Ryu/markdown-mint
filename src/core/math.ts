/** Language identifiers that Markdown Mint renders as display Math fences. */
export const MATH_FENCE_LANGUAGES = [
  "math",
  "latex",
  "tex",
  "asciimath",
] as const;

const mathFenceLanguages = new Set<string>(MATH_FENCE_LANGUAGES);

/** Return the normalized Math fence language from an info string, if any. */
export function mathFenceLanguage(info: string): string | null {
  const language = info.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  return mathFenceLanguages.has(language) ? language : null;
}

/** Test the complete info-string language identifier against the Math set. */
export function isMathFenceLanguage(info: string): boolean {
  return mathFenceLanguage(info) !== null;
}
