import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRef,
  PDFString,
} from "pdf-lib";
import type { PDFNumber } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { addInteractiveTaskCheckboxes } from "../../../src/extension/export/pdfTaskCheckboxes";

const markerPrefix = "https://markdown-mint.invalid/pdf-task-checkbox/";

function addUriLink(
  pdf: PDFDocument,
  pageIndex: number,
  uri: string,
  rect: readonly [number, number, number, number] = [100, 200, 114, 214],
): void {
  const page = pdf.getPages()[pageIndex];
  if (!page) throw new Error(`Test page ${pageIndex} does not exist.`);
  const annotation = pdf.context.obj({
    Type: "Annot",
    Subtype: "Link",
    Rect: [...rect],
    Border: [0, 0, 0],
    A: {
      S: "URI",
      URI: PDFString.of(uri),
    },
  });
  page.node.addAnnot(pdf.context.register(annotation));
}

async function makePdfWithAnnotations(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([595.28, 841.89]);
  pdf.addPage([595.28, 841.89]);
  addUriLink(pdf, 0, `${markerPrefix}0?checked=0`);
  addUriLink(pdf, 0, "https://example.com/");
  addUriLink(pdf, 1, `${markerPrefix}1?checked=1`, [220, 400, 234, 414]);
  return pdf.save();
}

function pageLinkUris(pdf: PDFDocument): string[] {
  const uris: string[] = [];
  for (const page of pdf.getPages()) {
    const annotations = page.node.Annots();
    if (!annotations) continue;
    for (const object of annotations.asArray()) {
      const annotation = pdf.context.lookupMaybe(object, PDFDict);
      if (
        annotation?.lookupMaybe(PDFName.of("Subtype"), PDFName)?.asString() !==
        "/Link"
      )
        continue;
      const action = pdf.context.lookupMaybe(
        annotation.get(PDFName.of("A")),
        PDFDict,
      );
      if (action?.lookupMaybe(PDFName.of("S"), PDFName)?.asString() !== "/URI")
        continue;
      const uri = pdf.context.lookupMaybe(
        action.get(PDFName.of("URI")),
        PDFString,
        PDFHexString,
      );
      if (uri) uris.push(uri.decodeText());
    }
  }
  return uris;
}

function pageWidgetCount(pdf: PDFDocument, pageIndex: number): number {
  const page = pdf.getPages()[pageIndex];
  const annotations = page?.node.Annots();
  if (!annotations) return 0;
  return annotations.asArray().filter((object) => {
    const annotation = pdf.context.lookupMaybe(object, PDFDict);
    return (
      annotation?.lookupMaybe(PDFName.of("Subtype"), PDFName)?.asString() ===
      "/Widget"
    );
  }).length;
}

describe("PDF task checkbox post-processing", () => {
  it("creates editable checkboxes on their marker pages and preserves normal links", async () => {
    const output = await addInteractiveTaskCheckboxes(
      await makePdfWithAnnotations(),
    );
    const pdf = await PDFDocument.load(output);
    const form = pdf.getForm();
    const unchecked = form.getCheckBox("markdownMint.taskCheckbox.0");
    const checked = form.getCheckBox("markdownMint.taskCheckbox.1");

    expect(form.getFields().map((field) => field.getName())).toEqual([
      "markdownMint.taskCheckbox.0",
      "markdownMint.taskCheckbox.1",
    ]);
    expect(unchecked.isChecked()).toBe(false);
    expect(checked.isChecked()).toBe(true);
    expect(pageWidgetCount(pdf, 0)).toBe(1);
    expect(pageWidgetCount(pdf, 1)).toBe(1);
    expect(pageLinkUris(pdf)).toEqual(["https://example.com/"]);
    expect(Buffer.from(output).toString("latin1")).not.toContain(
      "markdown-mint.invalid",
    );

    unchecked.check();
    checked.uncheck();
    const toggledPdf = await PDFDocument.load(await pdf.save());
    expect(
      toggledPdf
        .getForm()
        .getCheckBox("markdownMint.taskCheckbox.0")
        .isChecked(),
    ).toBe(true);
    expect(
      toggledPdf
        .getForm()
        .getCheckBox("markdownMint.taskCheckbox.1")
        .isChecked(),
    ).toBe(false);
  });

  it("uses the annotation rect as the widget rect", async () => {
    const output = await addInteractiveTaskCheckboxes(
      await makePdfWithAnnotations(),
    );
    const pdf = await PDFDocument.load(output);
    const annotations = pdf.getPages()[0]?.node.Annots();
    const widget = annotations
      ?.asArray()
      .map((object) => pdf.context.lookupMaybe(object, PDFDict))
      .find(
        (annotation) =>
          annotation
            ?.lookupMaybe(PDFName.of("Subtype"), PDFName)
            ?.asString() === "/Widget",
      );
    const rect = widget?.lookupMaybe(PDFName.of("Rect"), PDFArray);
    expect(
      rect?.asArray().map((value) => (value as PDFNumber).asNumber()),
    ).toEqual([100, 200, 114, 214]);
  });

  it("returns the input unchanged when the PDF has no task markers", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const bytes = await pdf.save();

    await expect(addInteractiveTaskCheckboxes(bytes)).resolves.toBe(bytes);
  });

  it("fails clearly for malformed markers", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    addUriLink(pdf, 0, `${markerPrefix}task-0?checked=0`);

    await expect(
      addInteractiveTaskCheckboxes(await pdf.save()),
    ).rejects.toThrow("malformed PDF task checkbox marker");
  });

  it("rejects duplicate marker IDs instead of creating ambiguous fields", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    addUriLink(pdf, 0, `${markerPrefix}0?checked=0`);
    addUriLink(pdf, 0, `${markerPrefix}0?checked=1`, [120, 200, 134, 214]);

    await expect(
      addInteractiveTaskCheckboxes(await pdf.save()),
    ).rejects.toThrow("duplicate PDF task checkbox marker 0");
  });

  it("removes marker annotation references and preserves non-marker refs", async () => {
    const bytes = await makePdfWithAnnotations();
    const before = await PDFDocument.load(bytes);
    const oldMarkerRef = before.getPages()[0]?.node.Annots()?.asArray()[0];
    expect(oldMarkerRef).toBeInstanceOf(PDFRef);

    const output = await addInteractiveTaskCheckboxes(bytes);
    const pdf = await PDFDocument.load(output);
    expect(pageLinkUris(pdf)).toEqual(["https://example.com/"]);
    expect(Buffer.from(output).includes(Buffer.from(markerPrefix))).toBe(false);
  });
});
