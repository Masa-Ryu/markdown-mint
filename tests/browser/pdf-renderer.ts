import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

declare global {
  interface Window {
    pdfjsLib: typeof pdfjs;
  }
}

pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.mjs";
window.pdfjsLib = pdfjs;
