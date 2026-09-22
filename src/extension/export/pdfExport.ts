import puppeteer, { type Browser, type Page } from "puppeteer-core";

export const PDF_EXPORT_TIMEOUT_MS = 30_000;

export interface PdfExportOptions {
  readonly executablePath: string;
  readonly timeoutMs?: number;
}

function documentResourcesScript(timeoutMs: number): string {
  return `(() => {
    const timeout = ${Math.floor(timeoutMs)};
    const withTimeout = (promise, label) => Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        window.setTimeout(() => reject(new Error("Timed out waiting for " + label + ".")), timeout);
      }),
    ]);
    return (async () => {
      await withTimeout(document.fonts.ready, "KaTeX fonts");
      const images = Array.from(document.images).filter((image) => {
        const source = image.getAttribute("src") || "";
        return !/^https?:\\/\\//i.test(source);
      });
      await withTimeout(Promise.all(images.map(async (image) => {
        if (!image.complete) {
          await new Promise((resolve, reject) => {
            image.addEventListener("load", () => resolve(), { once: true });
            image.addEventListener("error", () => reject(new Error("An embedded or local image failed to load.")), { once: true });
          });
        }
        if (image.naturalWidth === 0) throw new Error("An embedded or local image failed to load.");
        if (typeof image.decode === "function") await image.decode();
      })), "local images");
    })();
  })()`;
}

const mermaidReadinessExpression = `Array.from(document.querySelectorAll('[data-mm-mermaid="true"]')).every((diagram) => ["rendered", "failed"].includes(diagram.dataset.mmMermaidState || ""))`;
const failedMermaidCountExpression = `Array.from(document.querySelectorAll('[data-mm-mermaid="true"]')).filter((diagram) => diagram.dataset.mmMermaidState !== "rendered").length`;

async function waitForDocumentResources(
  page: Page,
  timeoutMs: number,
): Promise<void> {
  try {
    // Puppeteer serializes the expression itself. Keeping browser code as a
    // string prevents esbuild's keepNames wrappers from capturing Node helpers.
    await page.evaluate(documentResourcesScript(timeoutMs));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "A document resource failed.";
    throw new Error(
      `PDF export could not prepare document resources: ${message}`,
      {
        cause: error,
      },
    );
  }
}

async function waitForMermaid(page: Page, timeoutMs: number): Promise<void> {
  try {
    await page.waitForFunction(mermaidReadinessExpression, {
      timeout: timeoutMs,
    });
  } catch (error) {
    throw new Error(
      `Timed out waiting for Mermaid diagrams to render within ${timeoutMs} ms.`,
      { cause: error },
    );
  }

  const failedCount = (await page.evaluate(
    failedMermaidCountExpression,
  )) as number;
  if (failedCount > 0)
    throw new Error(
      `${failedCount} Mermaid ${failedCount === 1 ? "diagram" : "diagrams"} could not be rendered for PDF export.`,
    );
}

/** Render the standalone HTML through Chromium's print engine. */
export async function renderPdf(
  html: string,
  options: PdfExportOptions,
): Promise<Uint8Array> {
  const timeoutMs = options.timeoutMs ?? PDF_EXPORT_TIMEOUT_MS;
  let browser: Browser | undefined;
  let pdf: Uint8Array | undefined;
  let failure: unknown;
  let failed = false;
  try {
    browser = await puppeteer.launch({
      executablePath: options.executablePath,
      headless: true,
      timeout: timeoutMs,
    });
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(timeoutMs);
    page.setDefaultTimeout(timeoutMs);
    try {
      await page.setContent(html, {
        waitUntil: "load",
        timeout: timeoutMs,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "The document did not load.";
      if (/timed out|timeout/i.test(message))
        throw new Error(
          `Timed out waiting for the export document to load within ${timeoutMs} ms.`,
          { cause: error },
        );
      throw error;
    }
    await page.emulateMediaType("print");
    await waitForDocumentResources(page, timeoutMs);
    await waitForMermaid(page, timeoutMs);
    pdf = Uint8Array.from(
      await page.pdf({
        format: "A4",
        landscape: false,
        printBackground: true,
        preferCSSPageSize: true,
        timeout: timeoutMs,
      }),
    );
  } catch (error) {
    failure = error;
    failed = true;
  }

  if (browser) {
    try {
      await browser.close();
    } catch (error) {
      if (!failed) {
        failure = new Error("Chromium could not be closed after PDF export.", {
          cause: error,
        });
        failed = true;
      }
    }
  }

  if (failed) throw failure;
  if (!pdf) throw new Error("Chromium did not return a PDF document.");
  return pdf;
}
