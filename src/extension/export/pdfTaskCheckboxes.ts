import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
  type PDFPage,
} from "pdf-lib";

const markerNamespace = "https://markdown-mint.invalid/pdf-task-checkbox/";
const subtypeKey = PDFName.of("Subtype");
const actionKey = PDFName.of("A");
const actionTypeKey = PDFName.of("S");
const uriKey = PDFName.of("URI");
const rectangleKey = PDFName.of("Rect");

interface TaskMarker {
  readonly page: PDFPage;
  readonly annotationArray: PDFArray;
  readonly annotationIndex: number;
  readonly annotationObject: ReturnType<PDFArray["get"]>;
  readonly annotationDictionary: PDFDict;
  readonly identifier: string;
  readonly checked: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface InteractiveTaskCheckboxOptions {
  readonly markerToken: string;
  readonly expectedCount: number;
}

function readMarkerUri(
  pdf: PDFDocument,
  annotation: PDFDict,
):
  | { readonly uri: string; readonly actionObject: ReturnType<PDFDict["get"]> }
  | undefined {
  const actionObject = annotation.get(actionKey);
  const action = pdf.context.lookupMaybe(actionObject, PDFDict);
  if (action?.lookupMaybe(actionTypeKey, PDFName)?.asString() !== "/URI")
    return undefined;
  const uriObject = action.get(uriKey);
  const uri = pdf.context.lookupMaybe(uriObject, PDFString, PDFHexString);
  if (!uri) return undefined;
  return { uri: uri.decodeText(), actionObject };
}

function parseMarkerUri(
  uri: string,
  markerTokenPrefix: string,
): {
  readonly identifier: string;
  readonly checked: boolean;
} {
  const match = /^(0|[1-9]\d*)\?checked=([01])$/.exec(
    uri.slice(markerTokenPrefix.length),
  );
  if (!match)
    throw new Error("Chrome returned a malformed PDF task checkbox marker.");
  return { identifier: match[1]!, checked: match[2] === "1" };
}

function readMarkerRect(annotation: PDFDict): {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
} {
  const rect = annotation.lookupMaybe(rectangleKey, PDFArray);
  if (!rect || rect.size() !== 4)
    throw new Error("Chrome returned a PDF task marker without a valid rect.");
  const values = [0, 1, 2, 3].map((index) =>
    rect.lookup(index, PDFNumber).asNumber(),
  );
  const [left, bottom, right, top] = values;
  if (
    left === undefined ||
    bottom === undefined ||
    right === undefined ||
    top === undefined ||
    !values.every(Number.isFinite) ||
    right <= left ||
    top <= bottom
  )
    throw new Error("Chrome returned a PDF task marker with an invalid rect.");
  return {
    x: left,
    y: bottom,
    width: right - left,
    height: top - bottom,
  };
}

function deleteIndirectMarkerObjects(
  pdf: PDFDocument,
  annotationObject: ReturnType<PDFArray["get"]>,
  actionObject: ReturnType<PDFDict["get"]>,
): void {
  const action = pdf.context.lookupMaybe(actionObject, PDFDict);
  const uriObject = action?.get(uriKey);
  if (uriObject instanceof PDFRef) pdf.context.delete(uriObject);
  if (actionObject instanceof PDFRef) pdf.context.delete(actionObject);
  if (annotationObject instanceof PDFRef) pdf.context.delete(annotationObject);
}

/** Replace Chrome-generated marker links with editable PDF form checkboxes. */
export async function addInteractiveTaskCheckboxes(
  pdfBytes: Uint8Array,
  options: InteractiveTaskCheckboxOptions,
): Promise<Uint8Array> {
  const { markerToken, expectedCount } = options;
  if (!/^[0-9a-f]+$/i.test(markerToken))
    throw new Error(
      "PDF task checkbox marker token must contain only hex characters.",
    );
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 0)
    throw new Error(
      "Expected PDF task checkbox marker count must be a non-negative integer.",
    );
  if (expectedCount === 0) return pdfBytes;

  const markerTokenPrefix = `${markerNamespace}${markerToken}/`;
  const pdf = await PDFDocument.load(pdfBytes);
  const markers: TaskMarker[] = [];
  const identifiers = new Set<string>();

  for (const page of pdf.getPages()) {
    const annotations = page.node.Annots();
    if (!annotations) continue;
    for (let index = 0; index < annotations.size(); index += 1) {
      const annotationObject = annotations.get(index);
      const annotation = pdf.context.lookupMaybe(annotationObject, PDFDict);
      if (annotation?.lookupMaybe(subtypeKey, PDFName)?.asString() !== "/Link")
        continue;
      const markerAction = readMarkerUri(pdf, annotation);
      if (!markerAction?.uri.startsWith(markerTokenPrefix)) continue;
      const { identifier, checked } = parseMarkerUri(
        markerAction.uri,
        markerTokenPrefix,
      );
      if (identifiers.has(identifier))
        throw new Error(
          `Chrome returned duplicate PDF task checkbox marker ${identifier}.`,
        );
      identifiers.add(identifier);
      markers.push({
        page,
        annotationArray: annotations,
        annotationIndex: index,
        annotationObject,
        annotationDictionary: annotation,
        identifier,
        checked,
        ...readMarkerRect(annotation),
      });
    }
  }

  if (markers.length !== expectedCount)
    throw new Error(
      `Chrome generated ${markers.length} of ${expectedCount} expected PDF task checkbox markers.`,
    );

  const expectedIdentifiers = Array.from(
    { length: expectedCount },
    (_, index) => String(index),
  ).sort();
  const actualIdentifiers = [...identifiers].sort();
  if (
    actualIdentifiers.length !== expectedIdentifiers.length ||
    actualIdentifiers.some(
      (identifier, index) => identifier !== expectedIdentifiers[index],
    )
  )
    throw new Error(
      `Chrome returned an unexpected PDF task checkbox marker ID set: expected [${expectedIdentifiers.join(", ")}], received [${actualIdentifiers.join(", ")}].`,
    );

  const removedPerArray = new Map<PDFArray, TaskMarker[]>();
  for (const marker of markers) {
    const group = removedPerArray.get(marker.annotationArray) ?? [];
    group.push(marker);
    removedPerArray.set(marker.annotationArray, group);
  }
  for (const group of removedPerArray.values()) {
    for (const marker of group.sort(
      (left, right) => right.annotationIndex - left.annotationIndex,
    )) {
      marker.annotationArray.remove(marker.annotationIndex);
      const actionObject = marker.annotationDictionary.get(actionKey);
      deleteIndirectMarkerObjects(pdf, marker.annotationObject, actionObject);
    }
  }

  const form = pdf.getForm();
  const borderWidth = 1;
  for (const marker of markers) {
    const checkbox = form.createCheckBox(
      `markdownMint.taskCheckbox.${marker.identifier}`,
    );
    checkbox.addToPage(marker.page, {
      // pdf-lib expands widget bounds by half the border width on each side.
      // Compensate so the final widget /Rect stays equal to Chrome's marker.
      x: marker.x + borderWidth / 2,
      y: marker.y + borderWidth / 2,
      width: marker.width - borderWidth,
      height: marker.height - borderWidth,
      borderWidth,
    });
    if (marker.checked) checkbox.check();
    else checkbox.uncheck();
  }

  return pdf.save();
}
