export const MAX_IMAGE_IMPORT_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_IMPORT_BASE64_LENGTH =
  Math.ceil(MAX_IMAGE_IMPORT_BYTES / 3) * 4;

/**
 * Return the decoded byte length for a bounded, strictly formatted Base64 value.
 * The scan is linear and uses constant auxiliary space so large image payloads
 * cannot exhaust the regular expression engine's stack.
 */
export function imageImportBase64ByteLength(
  value: unknown,
): number | undefined {
  if (
    typeof value !== "string" ||
    value.length > MAX_IMAGE_IMPORT_BASE64_LENGTH ||
    value.length % 4 !== 0
  )
    return undefined;

  let padding = 0;
  if (value.length > 0 && value.charCodeAt(value.length - 1) === 61) {
    padding = 1;
    if (value.length > 1 && value.charCodeAt(value.length - 2) === 61)
      padding = 2;
  }

  const contentLength = value.length - padding;
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    if (!(
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47
    ))
      return undefined;
  }

  return (value.length / 4) * 3 - padding;
}

export function isImageImportBase64(value: unknown): value is string {
  const byteLength = imageImportBase64ByteLength(value);
  return byteLength !== undefined && byteLength <= MAX_IMAGE_IMPORT_BYTES;
}
