import {
  MAX_IMAGE_IMPORT_BYTES,
  MAX_IMAGE_IMPORT_BASE64_LENGTH,
  MAX_IMAGE_IMPORT_FILE_NAME_LENGTH,
  MAX_RESOURCE_URL_LENGTH,
  type ImageImportMessage,
} from "../shared/protocol";

/** The small URI surface needed by the image importer. */
export interface ImageImportUriLike {
  readonly scheme: string;
  readonly path: string;
}

export interface ImageImportFileSystem<Uri extends ImageImportUriLike> {
  createDirectory(uri: Uri): PromiseLike<void>;
  delete(uri: Uri): PromiseLike<void>;
  rename(
    source: Uri,
    target: Uri,
    options: { readonly overwrite: boolean },
  ): PromiseLike<void>;
  writeFile(uri: Uri, bytes: Uint8Array): PromiseLike<void>;
}

export interface ImageImportResourceStat {
  readonly type: number;
  readonly size: number;
}

export interface ImageImportResourceReader<Uri extends ImageImportUriLike> {
  stat(uri: Uri): PromiseLike<ImageImportResourceStat>;
  readFile(uri: Uri): PromiseLike<Uint8Array>;
}

export interface ImageImportDependencies<Uri extends ImageImportUriLike> {
  readonly fs: ImageImportFileSystem<Uri>;
  readonly joinPath: (base: Uri, ...parts: string[]) => Uri;
}

export interface ImageImportUriDependencies<
  Uri extends ImageImportUriLike,
> extends ImageImportDependencies<Uri> {
  readonly resource: ImageImportResourceReader<Uri>;
  readonly parseUri: (value: string) => Uri | undefined;
  readonly isWorkspaceResource: (uri: Uri) => boolean;
}

export interface ImageImportUriReadResult {
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
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
export const IMAGE_IMPORT_FILE_TYPE_FILE = 1;
export const IMAGE_IMPORT_FILE_TYPE_DIRECTORY = 2;
let temporaryFileSequence = 0;

/**
 * Decode and validate a Webview base64 payload without relying on Node's
 * forgiving Buffer decoder. The Extension Host can therefore use the same
 * implementation for local and virtual workspaces.
 */
export function decodeImageImportBase64(base64: string): Uint8Array {
  if (base64.length > MAX_IMAGE_IMPORT_BASE64_LENGTH)
    throw new Error("The dropped image exceeds the 10 MB size limit.");
  if (base64.length === 0) return new Uint8Array(0);
  if (
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
    return await saveImageImportBytes(
      documentUri,
      request.fileName,
      request.mimeType,
      decodeImageImportBase64(request.base64),
      request.requestId,
      dependencies,
    );
  } catch (error) {
    return {
      success: false,
      message: errorMessage(error, "The image could not be imported."),
    };
  }
}

/** Read a VS Code Explorer resource through the Extension Host filesystem. */
export async function readImageImportUri<Uri extends ImageImportUriLike>(
  resourceUri: string,
  dependencies: ImageImportUriDependencies<Uri>,
): Promise<ImageImportUriReadResult> {
  if (
    resourceUri.length === 0 ||
    resourceUri.length > MAX_RESOURCE_URL_LENGTH ||
    hasControlCharacter(resourceUri)
  )
    throw new Error("The dropped image URI is not safe.");

  const sourceUri = dependencies.parseUri(resourceUri);
  if (!sourceUri?.scheme || !dependencies.isWorkspaceResource(sourceUri))
    throw new Error(
      "Only image resources inside the current workspace can be imported.",
    );

  const fileName = imageImportFileNameFromUri(sourceUri, resourceUri);
  if (!fileName) throw new Error("The dropped image URI has no file name.");
  normalizeImageImportFileName(fileName);
  const mimeType = imageImportMimeTypeForFileName(fileName);
  if (!mimeType)
    throw new Error("Only PNG, JPEG, GIF, and WebP images can be imported.");

  const stat = await dependencies.resource.stat(sourceUri);
  if (
    !Number.isSafeInteger(stat.type) ||
    (stat.type & IMAGE_IMPORT_FILE_TYPE_FILE) === 0 ||
    (stat.type & IMAGE_IMPORT_FILE_TYPE_DIRECTORY) !== 0
  )
    throw new Error("The dropped image resource is not a file.");
  if (!Number.isSafeInteger(stat.size) || stat.size < 0)
    throw new Error("The dropped image resource has an invalid size.");
  if (stat.size > MAX_IMAGE_IMPORT_BYTES)
    throw new Error("The dropped image exceeds the 10 MB size limit.");

  const bytes = await dependencies.resource.readFile(sourceUri);
  if (bytes.byteLength > MAX_IMAGE_IMPORT_BYTES)
    throw new Error("The dropped image exceeds the 10 MB size limit.");
  return { fileName, mimeType, bytes };
}

/** Read and save a URI source through the same pipeline as a File source. */
export async function saveImageImportUri<Uri extends ImageImportUriLike>(
  documentUri: Uri,
  resourceUri: string,
  requestId: string,
  dependencies: ImageImportUriDependencies<Uri>,
): Promise<ImageImportSaveResult> {
  try {
    const source = await readImageImportUri(resourceUri, dependencies);
    return await saveImageImportBytes(
      documentUri,
      source.fileName,
      source.mimeType,
      source.bytes,
      requestId,
      dependencies,
    );
  } catch (error) {
    return {
      success: false,
      message: errorMessage(error, "The image could not be imported."),
    };
  }
}

/** Return the decoded basename without ever exposing the URI path to Markdown. */
export function imageImportFileNameFromUri<Uri extends ImageImportUriLike>(
  uri: Uri,
  resourceUri?: string,
): string | undefined {
  const path = resourceUri ? (rawUriPath(resourceUri) ?? uri.path) : uri.path;
  if (!path || path.endsWith("/")) return undefined;
  const slash = path.lastIndexOf("/");
  const encodedFileName = path.slice(slash + 1);
  if (!encodedFileName) return undefined;
  try {
    return decodeURIComponent(encodedFileName);
  } catch {
    return undefined;
  }
}

function rawUriPath(resourceUri: string): string | undefined {
  try {
    return new URL(resourceUri).pathname;
  } catch {
    return undefined;
  }
}

export function imageImportMimeTypeForFileName(
  fileName: string,
): string | undefined {
  const extension = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  return MIME_TYPES_BY_EXTENSION[extension]?.[0];
}

/** Save validated bytes beside the Markdown document and return a portable path. */
export async function saveImageImportBytes<Uri extends ImageImportUriLike>(
  documentUri: Uri,
  fileName: string,
  mimeType: string,
  bytes: Uint8Array,
  requestId: string,
  dependencies: ImageImportDependencies<Uri>,
): Promise<ImageImportSaveResult> {
  let temporaryUri: Uri | undefined;
  let result: ImageImportSaveResult = {
    success: false,
    message: "The image could not be imported.",
  };
  let claimed = false;
  try {
    if (bytes.byteLength === 0) throw new Error("The dropped image is empty.");
    if (bytes.byteLength > MAX_IMAGE_IMPORT_BYTES)
      throw new Error("The dropped image exceeds the 10 MB size limit.");
    const safeFileName = normalizeImageImportFileName(fileName);
    validateImageType(safeFileName, mimeType);
    const documentDirectory = documentDirectoryUri(documentUri, dependencies);
    const imagesDirectory = dependencies.joinPath(documentDirectory, "images");

    await dependencies.fs.createDirectory(imagesDirectory);
    temporaryUri = dependencies.joinPath(
      imagesDirectory,
      temporaryFileName(requestId),
    );
    await dependencies.fs.writeFile(temporaryUri, bytes);
    for (let suffix = 0; suffix <= MAX_DUPLICATE_ATTEMPTS; suffix += 1) {
      const targetName =
        suffix === 0 ? safeFileName : withSuffix(safeFileName, suffix);
      const relativePath = relativeImagePath(targetName);
      try {
        await dependencies.fs.rename(
          temporaryUri,
          dependencies.joinPath(imagesDirectory, targetName),
          { overwrite: false },
        );
        result = { success: true, relativePath };
        claimed = true;
        break;
      } catch (error) {
        if (isExistingFile(error)) continue;
        throw error;
      }
    }
    if (!claimed) throw new Error("Too many images have the same file name.");
  } catch (error) {
    result = {
      success: false,
      message: errorMessage(error, "The image could not be imported."),
    };
  }
  if (temporaryUri) {
    try {
      // A successful rename removes the source; missing-file cleanup is
      // expected. On collision retries the source remains until the final
      // claim, so cleanup also covers every failure path.
      await cleanupTemporaryFile(dependencies.fs, temporaryUri);
    } catch (error) {
      const cleanupMessage = errorMessage(
        error,
        "The temporary image could not be cleaned up.",
      );
      result = result.success
        ? { success: false, message: cleanupMessage }
        : {
            success: false,
            message: `${result.message} ${cleanupMessage}`,
          };
    }
  }
  return result;
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

function withSuffix(fileName: string, suffix: number): string {
  const extensionIndex = fileName.lastIndexOf(".");
  const suffixText = `-${suffix}`;
  if (extensionIndex <= 0) {
    return `${fileName.slice(0, MAX_FILE_NAME_LENGTH - suffixText.length)}${suffixText}`;
  }
  const stem = fileName.slice(0, extensionIndex);
  const extension = fileName.slice(extensionIndex);
  const maxStemLength =
    MAX_FILE_NAME_LENGTH - suffixText.length - extension.length;
  if (maxStemLength > 0)
    return `${stem.slice(0, maxStemLength)}${suffixText}${extension}`;
  const maxExtensionLength = Math.max(
    1,
    MAX_FILE_NAME_LENGTH - suffixText.length - 1,
  );
  return `${stem.slice(0, 1)}${suffixText}${extension.slice(-maxExtensionLength)}`;
}

function relativeImagePath(fileName: string): string {
  try {
    return `./images/${encodeURIComponent(fileName)}`;
  } catch {
    throw new Error("The dropped image file name is not safe.");
  }
}

function temporaryFileName(requestId: string): string {
  temporaryFileSequence += 1;
  const safeRequestId = requestId.replace(/[^A-Za-z0-9_-]/g, "_").slice(-64);
  const randomPart =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `.markdown-mint-image-${safeRequestId || "request"}-${Date.now().toString(36)}-${temporaryFileSequence}-${randomPart}.tmp`;
}

async function cleanupTemporaryFile<Uri extends ImageImportUriLike>(
  fileSystem: ImageImportFileSystem<Uri>,
  uri: Uri,
): Promise<void> {
  try {
    await fileSystem.delete(uri);
  } catch (error) {
    if (isMissingFile(error)) return;
    throw new Error(
      errorMessage(error, "The temporary image could not be cleaned up."),
    );
  }
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

function isExistingFile(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "FileExists" || code === "EEXIST" || code === "AlreadyExists";
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
