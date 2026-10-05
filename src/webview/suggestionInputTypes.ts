const SUGGESTION_INPUT_TYPES: ReadonlySet<string> = new Set([
  "insertText",
  "insertCompositionText",
  "insertFromComposition",
  "insertReplacementText",
  "insertParagraph",
  "insertLineBreak",
  "deleteContentBackward",
  "deleteContentForward",
  "deleteWordBackward",
  "deleteWordForward",
  "deleteSoftLineBackward",
  "deleteSoftLineForward",
  "deleteHardLineBackward",
  "deleteHardLineForward",
  "deleteEntireSoftLine",
  "deleteByCut",
]);

export function isSuggestionInputType(inputType: string): boolean {
  return SUGGESTION_INPUT_TYPES.has(inputType);
}
