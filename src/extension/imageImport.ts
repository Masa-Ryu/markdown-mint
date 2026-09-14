import {
  MAX_IMAGE_IMPORT_BYTES,
  MAX_IMAGE_IMPORT_BASE64_LENGTH,
  MAX_IMAGE_IMPORT_FILE_NAME_LENGTH,
  type ImageImportMessage,
} from "../shared/protocol";

/** The small URI surface needed by the image importer. */
export interface ImageImportUriLike {
  readonly scheme: string;
  readonly path: string;
}

export interface ImageImportFileSystem<Uri extends ImageImportUriLike> {
  createDirectory(uri: Uri): PromiseLike<void>;
  stat(uri: Uri): PromiseLike<unknown>;
  writeFile(uri: Uri, bytes: Uint8Array): PromiseLike<void>;
}

export interface ImageImportDependencies<Uri extends ImageImportUriLike> {
  readonly fs: ImageImportFileSystem<Uri>;
  readonly joinPath: (base: Uri, ...parts: string[]) => Uri;
}

export type ImageImportSaveResult =
  | { readonly success: true; readonly relativePath: string }
  | { readonly success: false; readonly message: string };

const MIME_TYPES_BY_EXTENSION: Readonly<Record<string, readonly string[]>> = {
  ".png": ["image/png"],
  ".jpeg": ["image/jpeg", "image/jpg"],
  ".jpg": ["image/jpeg", "image/jpg"],
  ".gif": ["image/gif"],
  ".webp": ["image/webp"],
};

const MAX_FILE_NAME_LENGTH = 255;
const MAX_DUPLICATE_ATTEMPTS = 10_000;

/**
 * Decode and validate a Webview base64 payload without relying on Node's
 * forgiving Buffer decoder. The Extension Host can therefore use the same
 * implementation for local and virtual workspaces.
 */
export function decodeImageImportBase64(base64: string): Uint8Array {
  if (base64.length > MAX_IMAGE_IMPORT_BASE64_LENGTH)
    throw new Error("The dropped image exceeds the 10 MB size limit.");
  if (
    base64.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      base64,
    )
  )
    throw new Error("The dropped image data was not valid base64.");

  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const byteLength = (base64.length / 4) * 3 - padding;
  if (byteLength > MAX_IMAGE_IMPORT_BYTES)
    throw new Error("The dropped image exceeds the 10 MB size limit.");

  const bytes = new Uint8Array(byteLength);
  let output = 0;
  for (let index = 0; index < base64.length; index += 4) {
    const first = base64Value(base64.charCodeAt(index));
    const second = base64Value(base64.charCodeAt(index + 1));
    const thirdChar = base64[index + 2] ?? "=";
    const fourthChar = base64[index + 3] ?? "=";
    const third = thirdChar === "=" ? 0 : base64Value(thirdChar.charCodeAt(0));
    const fourth =
      fourthChar === "=" ? 0 : base64Value(fourthChar.charCodeAt(0));
    bytes[output++] = (first << 2) | (second >> 4);
    if (thirdChar !== "=") bytes[output++] = (second << 4) | (third >> 2);
    if (fourthChar !== "=") bytes[output++] = (third << 6) | fourth;
  }
  return bytes;
}

/** Validate and preserve the browser-provided basename for host-side writes. */
export function normalizeImageImportFileName(fileName: string): string {
  if (
    fileName.length === 0 ||
    fileName.length > MAX_IMAGE_IMPORT_FILE_NAME_LENGTH ||
    fileName.length > MAX_FILE_NAME_LENGTH ||
    fileName.trim().length === 0 ||
    fileName === "." ||
    fileName === ".." ||
    hasControlCharacter(fileName) ||
    fileName.includes("/") ||
    fileName.includes("\\")
  )
    throw new Error("The dropped image file name is not safe.");
  return fileName;
}

/**
 * Save one validated image beside the Markdown document and return only the
 * portable path that the Markdown source should store.
 */
export async function saveImageImport<Uri extends ImageImportUriLike>(
  documentUri: Uri,
  request: ImageImportMessage,
  dependencies: ImageImportDependencies<Uri>,
): Promise<ImageImportSaveResult> {
  try {
    const bytes = decodeImageImportBase64(request.base64);
    const fileName = normalizeImageImportFileName(request.fileName);
    validateImageType(fileName, request.mimeType);
    const documentDirectory = documentDirectoryUri(documentUri, dependencies);
    const imagesDirectory = dependencies.joinPath(documentDirectory, "images");

    await dependencies.fs.createDirectory(imagesDirectory);
    const targetName = await availableFileName(
      imagesDirectory,
      fileName,
      dependencies,
    );
    await dependencies.fs.writeFile(
      dependencies.joinPath(imagesDirectory, targetName),
      bytes,
    );
    return { success: true, relativePath: `./images/${targetName}` };
  } catch (error) {
    return {
      success: false,
      message: errorMessage(error, "The image could not be imported."),
    };
  }
}

function documentDirectoryUri<Uri extends ImageImportUriLike>(
  documentUri: Uri,
  dependencies: ImageImportDependencies<Uri>,
): Uri {
  if (
    !documentUri.scheme ||
    documentUri.scheme === "untitled" ||
    !documentUri.path ||
    documentUri.path.endsWith("/") ||
    !documentUri.path.includes("/")
  )
    throw new Error(
      "The Markdown document does not have a safe writable directory.",
    );
  return dependencies.joinPath(documentUri, "..");
}

async function availableFileName<Uri extends ImageImportUriLike>(
  directory: Uri,
  originalName: string,
  dependencies: ImageImportDependencies<Uri>,
): Promise<string> {
  for (let suffix = 0; suffix <= MAX_DUPLICATE_ATTEMPTS; suffix += 1) {
    const candidate =
      suffix === 0 ? originalName : withSuffix(originalName, suffix);
    try {
      await dependencies.fs.stat(dependencies.joinPath(directory, candidate));
    } catch (error) {
      if (isMissingFile(error)) return candidate;
      throw new Error(
        errorMessage(error, "The existing image could not be inspected."),
      );
    }
  }
  throw new Error("Too many images have the same file name.");
}

function withSuffix(fileName: string, suffix: number): string {
  const extensionIndex = fileName.lastIndexOf(".");
  if (extensionIndex <= 0) return `${fileName}-${suffix}`;
  return `${fileName.slice(0, extensionIndex)}-${suffix}${fileName.slice(extensionIndex)}`;
}

function validateImageType(fileName: string, mimeType: string): void {
  const extension = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  const allowedMimeTypes = MIME_TYPES_BY_EXTENSION[extension];
  if (!allowedMimeTypes)
    throw new Error("Only PNG, JPEG, GIF, and WebP images can be imported.");
  if (!allowedMimeTypes.includes(mimeType.toLowerCase()))
    throw new Error("The dropped image MIME type is not supported.");
}

function base64Value(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43) return 62;
  if (code === 47) return 63;
  throw new Error("The dropped image data was not valid base64.");
}

function isMissingFile(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "FileNotFound" || code === "ENOENT" || code === "NotFound";
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}
