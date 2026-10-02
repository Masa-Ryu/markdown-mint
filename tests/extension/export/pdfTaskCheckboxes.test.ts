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

const markerNamespace = "https://markdown-mint.invalid/pdf-task-checkbox/";
const markerToken = "0123456789abcdef0123456789abcdef";
const reservedLookingUri = `${markerNamespace}0?checked=0`;

function markerUri(
  token: string,
  identifier: string,
  checked: boolean,
): string {
  return `${markerNamespace}${token}/${identifier}?checked=${checked ? 1 : 0}`;
}

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

async function makePdfWithAnnotations(
  token = markerToken,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([595.28, 841.89]);
  pdf.addPage([595.28, 841.89]);
  addUriLink(pdf, 0, markerUri(token, "0", false));
  addUriLink(pdf, 0, "https://example.com/");
  addUriLink(pdf, 1, markerUri(token, "1", true), [220, 400, 234, 414]);
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
      { markerToken, expectedCount: 2 },
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
      { markerToken, expectedCount: 2 },
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

  it("keeps the no-task fast path unchanged", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const bytes = await pdf.save();

    await expect(
      addInteractiveTaskCheckboxes(bytes, { markerToken, expectedCount: 0 }),
    ).resolves.toBe(bytes);
  });

  it("rejects when no marker is found for a positive expected count", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();

    await expect(
      addInteractiveTaskCheckboxes(await pdf.save(), {
        markerToken,
        expectedCount: 1,
      }),
    ).rejects.toThrow(
      "Chrome generated 0 of 1 expected PDF task checkbox markers.",
    );
  });

  it("rejects when the marker count is short", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    addUriLink(pdf, 0, markerUri(markerToken, "0", false));
    const bytes = await pdf.save();

    await expect(
      addInteractiveTaskCheckboxes(bytes, {
        markerToken,
        expectedCount: 2,
      }),
    ).rejects.toThrow(
      "Chrome generated 1 of 2 expected PDF task checkbox markers.",
    );
    const unchanged = await PDFDocument.load(bytes);
    expect(pageLinkUris(unchanged)).toEqual([
      markerUri(markerToken, "0", false),
    ]);
  });

  it("rejects when the marker count exceeds the expected count", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    addUriLink(pdf, 0, markerUri(markerToken, "0", false));
    addUriLink(pdf, 0, markerUri(markerToken, "1", true), [120, 200, 134, 214]);

    await expect(
      addInteractiveTaskCheckboxes(await pdf.save(), {
        markerToken,
        expectedCount: 1,
      }),
    ).rejects.toThrow(
      "Chrome generated 2 of 1 expected PDF task checkbox markers.",
    );
  });

  it("rejects an ID gap and an out-of-range marker despite a matching count", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    addUriLink(pdf, 0, markerUri(markerToken, "0", false));
    addUriLink(pdf, 0, markerUri(markerToken, "2", true), [120, 200, 134, 214]);

    await expect(
      addInteractiveTaskCheckboxes(await pdf.save(), {
        markerToken,
        expectedCount: 2,
      }),
    ).rejects.toThrow(
      "Chrome returned an unexpected PDF task checkbox marker ID set: expected [0, 1], received [0, 2].",
    );
  });

  it("rejects malformed markers for the current export token", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    addUriLink(pdf, 0, `${markerNamespace}${markerToken}/task-0?checked=0`);

    await expect(
      addInteractiveTaskCheckboxes(await pdf.save(), {
        markerToken,
        expectedCount: 1,
      }),
    ).rejects.toThrow("malformed PDF task checkbox marker");
  });

  it("rejects duplicate marker IDs instead of creating ambiguous fields", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    addUriLink(pdf, 0, markerUri(markerToken, "0", false));
    addUriLink(pdf, 0, markerUri(markerToken, "0", true), [120, 200, 134, 214]);

    await expect(
      addInteractiveTaskCheckboxes(await pdf.save(), {
        markerToken,
        expectedCount: 2,
      }),
    ).rejects.toThrow("duplicate PDF task checkbox marker 0");
  });

  it("converts only the current token and preserves a foreign marker-like link", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    addUriLink(pdf, 0, markerUri("abc123", "0", false));
    addUriLink(
      pdf,
      0,
      markerUri("other-token", "0", true),
      [120, 200, 134, 214],
    );

    const output = await addInteractiveTaskCheckboxes(await pdf.save(), {
      markerToken: "abc123",
      expectedCount: 1,
    });
    const result = await PDFDocument.load(output);
    expect(
      result
        .getForm()
        .getFields()
        .map((field) => field.getName()),
    ).toEqual(["markdownMint.taskCheckbox.0"]);
    expect(pageLinkUris(result)).toEqual([markerUri("other-token", "0", true)]);
  });

  it("preserves a user-authored reserved-looking URL as a normal link", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    addUriLink(pdf, 0, markerUri(markerToken, "0", false));
    addUriLink(pdf, 0, reservedLookingUri, [120, 200, 134, 214]);

    const output = await addInteractiveTaskCheckboxes(await pdf.save(), {
      markerToken,
      expectedCount: 1,
    });
    const result = await PDFDocument.load(output);
    expect(
      result
        .getForm()
        .getFields()
        .map((field) => field.getName()),
    ).toEqual(["markdownMint.taskCheckbox.0"]);
    expect(pageLinkUris(result)).toEqual([reservedLookingUri]);
  });

  it("creates exactly the expected marker ID set", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    for (const identifier of ["0", "1", "2"])
      addUriLink(
        pdf,
        0,
        markerUri(markerToken, identifier, identifier !== "0"),
        [
          100 + Number(identifier) * 20,
          200,
          114 + Number(identifier) * 20,
          214,
        ],
      );

    const output = await addInteractiveTaskCheckboxes(await pdf.save(), {
      markerToken,
      expectedCount: 3,
    });
    const result = await PDFDocument.load(output);
    expect(
      result
        .getForm()
        .getFields()
        .map((field) => field.getName())
        .sort(),
    ).toEqual([
      "markdownMint.taskCheckbox.0",
      "markdownMint.taskCheckbox.1",
      "markdownMint.taskCheckbox.2",
    ]);
  });

  it("removes only validated marker annotations and keeps unrelated links", async () => {
    const bytes = await makePdfWithAnnotations();
    const before = await PDFDocument.load(bytes);
    const oldMarkerRef = before.getPages()[0]?.node.Annots()?.asArray()[0];
    expect(oldMarkerRef).toBeInstanceOf(PDFRef);

    const output = await addInteractiveTaskCheckboxes(bytes, {
      markerToken,
      expectedCount: 2,
    });
    const pdf = await PDFDocument.load(output);
    expect(pageLinkUris(pdf)).toEqual(["https://example.com/"]);
    expect(Buffer.from(output).toString("latin1")).not.toContain(
      markerUri(markerToken, "0", false),
    );
  });
});
