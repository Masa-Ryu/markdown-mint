import { beforeEach, describe, expect, it, vi } from "vitest";

const puppeteerMocks = vi.hoisted(() => ({
  launch: vi.fn(),
  page: {
    setDefaultNavigationTimeout: vi.fn(),
    setDefaultTimeout: vi.fn(),
    setContent: vi.fn(async () => undefined),
    emulateMediaType: vi.fn(async () => undefined),
    evaluate: vi.fn(),
    waitForFunction: vi.fn(async () => undefined),
    pdf: vi.fn(async () => new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55])),
  },
  browser: {
    newPage: vi.fn(),
    close: vi.fn(async () => undefined),
  },
}));

vi.mock("puppeteer-core", () => ({
  default: { launch: puppeteerMocks.launch },
}));

import {
  PDF_EXPORT_TIMEOUT_MS,
  renderPdf,
} from "../../../src/extension/export/pdfExport";

beforeEach(() => {
  vi.clearAllMocks();
  puppeteerMocks.launch.mockResolvedValue(puppeteerMocks.browser);
  puppeteerMocks.browser.newPage.mockResolvedValue(puppeteerMocks.page);
  puppeteerMocks.page.evaluate
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(0);
  puppeteerMocks.page.pdf.mockResolvedValue(
    new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]),
  );
});

describe("renderPdf", () => {
  it("uses the supplied standalone HTML and explicit A4 print settings", async () => {
    const pdf = await renderPdf("<!doctype html><title>Guide</title>", {
      executablePath: "/usr/bin/google-chrome",
    });

    expect(puppeteerMocks.launch).toHaveBeenCalledWith({
      executablePath: "/usr/bin/google-chrome",
      headless: true,
      timeout: PDF_EXPORT_TIMEOUT_MS,
    });
    expect(puppeteerMocks.page.setContent).toHaveBeenCalledWith(
      "<!doctype html><title>Guide</title>",
      { waitUntil: "load", timeout: PDF_EXPORT_TIMEOUT_MS },
    );
    expect(puppeteerMocks.page.emulateMediaType).toHaveBeenCalledWith("print");
    expect(puppeteerMocks.page.pdf).toHaveBeenCalledWith({
      format: "A4",
      landscape: false,
      printBackground: true,
      preferCSSPageSize: true,
      timeout: PDF_EXPORT_TIMEOUT_MS,
    });
    expect(Array.from(pdf)).toEqual([37, 80, 68, 70, 45, 49, 46, 55]);
    expect(puppeteerMocks.browser.close).toHaveBeenCalledOnce();
  });

  it("waits for Mermaid completion and rejects failed diagrams", async () => {
    puppeteerMocks.page.evaluate
      .mockReset()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(1);

    await expect(
      renderPdf('<div data-mm-mermaid="true"></div>', {
        executablePath: "/chrome",
      }),
    ).rejects.toThrow("1 Mermaid diagram could not be rendered");
    expect(puppeteerMocks.page.waitForFunction).toHaveBeenCalledWith(
      expect.any(Function),
      { timeout: PDF_EXPORT_TIMEOUT_MS },
    );
    expect(puppeteerMocks.page.pdf).not.toHaveBeenCalled();
    expect(puppeteerMocks.browser.close).toHaveBeenCalledOnce();
  });

  it("reports resource timeouts with a concrete error and closes Chromium", async () => {
    puppeteerMocks.page.evaluate
      .mockReset()
      .mockRejectedValueOnce(new Error("Timed out waiting for KaTeX fonts."));

    await expect(
      renderPdf("<html></html>", { executablePath: "/chrome", timeoutMs: 25 }),
    ).rejects.toThrow("PDF export could not prepare document resources");
    expect(puppeteerMocks.browser.close).toHaveBeenCalledOnce();
  });

  it("closes Chromium when page setup or PDF generation fails", async () => {
    puppeteerMocks.page.pdf.mockRejectedValueOnce(new Error("print failed"));

    await expect(
      renderPdf("<html></html>", { executablePath: "/chrome" }),
    ).rejects.toThrow("print failed");
    expect(puppeteerMocks.browser.close).toHaveBeenCalledOnce();
  });

  it("reports launch errors without attempting later PDF work", async () => {
    puppeteerMocks.launch.mockRejectedValueOnce(new Error("launch failed"));

    await expect(
      renderPdf("<html></html>", { executablePath: "/bad/chrome" }),
    ).rejects.toThrow("launch failed");
    expect(puppeteerMocks.browser.close).not.toHaveBeenCalled();
    expect(puppeteerMocks.page.setContent).not.toHaveBeenCalled();
  });
});
