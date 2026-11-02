// Local OCR pipeline. Everything runs inside the app (Tesseract compiled to
// WebAssembly + bundled English language data) - no internet needed.
import { createWorker, type Worker } from "tesseract.js";
import * as pdfjs from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import UTIF from "utif";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export const SUPPORTED_EXTENSIONS = ["pdf", "png", "jpg", "jpeg", "tif", "tiff"];
const MAX_PAGES = 10;

export interface RecognitionResult {
  text: string;
  /** mean OCR confidence 0-100 (100 for PDFs with a text layer) */
  confidence: number;
  source: "ocr" | "pdf-text";
  pages: number;
  /** data URL of page 1 for the preview panel */
  preview: string;
}

export type ProgressFn = (fraction: number, label: string) => void;

export function extensionOf(name: string): string {
  return (name.split(".").pop() || "").toLowerCase();
}

export function isSupported(file: File): boolean {
  return SUPPORTED_EXTENSIONS.includes(extensionOf(file.name));
}

// ------------------------------------------------------------ tesseract

let workerPromise: Promise<Worker> | null = null;
let progressSink: ((p: number) => void) | null = null;

function assetUrl(path: string): string {
  return new URL(path, document.baseURI).href;
}

function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await createWorker("eng", 1 /* LSTM engine */, {
        workerPath: assetUrl("ocr/worker.min.js"),
        corePath: assetUrl("ocr/core"),
        langPath: assetUrl("ocr/lang"),
        gzip: true,
        workerBlobURL: false,
        logger: (m) => {
          if (m.status === "recognizing text" && progressSink) progressSink(m.progress);
        },
      });
      await worker.setParameters({ preserve_interword_spaces: "1" });
      return worker;
    })();
    workerPromise.catch(() => (workerPromise = null));
  }
  return workerPromise;
}

/** Warm up the OCR engine in the background so the first file is faster. */
export function preloadOcr(): void {
  getWorker().catch(() => undefined);
}

async function ocrCanvas(canvas: HTMLCanvasElement, onProgress: (p: number) => void) {
  const worker = await getWorker();
  progressSink = onProgress;
  try {
    const { data } = await worker.recognize(canvas);
    return { text: data.text, confidence: data.confidence };
  } finally {
    progressSink = null;
  }
}

// ------------------------------------------------------------ image helpers

/** Grayscale + upscale small images; Tesseract works best around 300 DPI. */
function prepareCanvas(source: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
  const scale = width < 1600 ? Math.min(2.5, 1600 / width) : width > 4000 ? 4000 / width : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function previewOf(canvas: HTMLCanvasElement): string {
  const maxW = 1400;
  if (canvas.width <= maxW) return canvas.toDataURL("image/jpeg", 0.85);
  const c = document.createElement("canvas");
  c.width = maxW;
  c.height = Math.round((canvas.height * maxW) / canvas.width);
  c.getContext("2d")!.drawImage(canvas, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.85);
}

async function loadImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    // keep URL alive until decode finished
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function tiffPages(buffer: ArrayBuffer): HTMLCanvasElement[] {
  const ifds = UTIF.decode(buffer).slice(0, MAX_PAGES);
  const canvases: HTMLCanvasElement[] = [];
  for (const ifd of ifds) {
    UTIF.decodeImage(buffer, ifd);
    const rgba = UTIF.toRGBA8(ifd);
    const c = document.createElement("canvas");
    c.width = ifd.width;
    c.height = ifd.height;
    const ctx = c.getContext("2d")!;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer), ifd.width, ifd.height), 0, 0);
    canvases.push(c);
  }
  return canvases;
}

// ------------------------------------------------------------ pdf helpers

interface TextItemLike {
  str: string;
  transform: number[];
}

/** Rebuild reading-order lines from PDF text items. */
function pdfItemsToText(items: TextItemLike[]): string {
  const rows: { y: number; parts: { x: number; s: string }[] }[] = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const x = it.transform[4], y = it.transform[5];
    let row = rows.find((r) => Math.abs(r.y - y) < 3);
    if (!row) rows.push((row = { y, parts: [] }));
    row.parts.push({ x, s: it.str });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows
    .map((r) => r.parts.sort((a, b) => a.x - b.x).map((p) => p.s.trim()).join("  "))
    .join("\n");
}

async function renderPdfPage(page: pdfjs.PDFPageProxy, scale: number): Promise<HTMLCanvasElement> {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

async function recognizePdf(file: File, onProgress: ProgressFn): Promise<RecognitionResult> {
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  const pageCount = Math.min(doc.numPages, MAX_PAGES);
  const texts: string[] = [];
  const confidences: number[] = [];
  let usedOcr = false;
  let preview = "";

  try {
    for (let p = 1; p <= pageCount; p++) {
      const page = await doc.getPage(p);
      if (p === 1) preview = previewOf(await renderPdfPage(page, 1.6));

      const content = await page.getTextContent();
      const text = pdfItemsToText(content.items as TextItemLike[]);
      if (text.replace(/\s/g, "").length > 40) {
        texts.push(text);
        confidences.push(100);
        onProgress(p / pageCount, `Reading page ${p} of ${pageCount}`);
        continue;
      }
      // Scanned page: render at high resolution and OCR it.
      usedOcr = true;
      const canvas = await renderPdfPage(page, 2.8);
      const prepared = prepareCanvas(canvas, canvas.width, canvas.height);
      const r = await ocrCanvas(prepared, (f) =>
        onProgress((p - 1 + f) / pageCount, `OCR page ${p} of ${pageCount}`),
      );
      texts.push(r.text);
      confidences.push(r.confidence);
    }
  } finally {
    await doc.destroy();
  }

  return {
    text: texts.join("\n"),
    confidence: confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0,
    source: usedOcr ? "ocr" : "pdf-text",
    pages: pageCount,
    preview,
  };
}

// ------------------------------------------------------------ public API

export async function recognizeFile(file: File, onProgress: ProgressFn): Promise<RecognitionResult> {
  const ext = extensionOf(file.name);
  onProgress(0, "Preparing");

  if (ext === "pdf") return recognizePdf(file, onProgress);

  let pages: HTMLCanvasElement[];
  if (ext === "tif" || ext === "tiff") {
    pages = tiffPages(await file.arrayBuffer());
  } else {
    const img = await loadImage(file);
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext("2d")!.drawImage(img, 0, 0);
    pages = [c];
  }
  if (!pages.length) throw new Error("No image found in file");

  onProgress(0.02, "Loading OCR engine");
  const texts: string[] = [];
  const confidences: number[] = [];
  for (let i = 0; i < pages.length; i++) {
    const prepared = prepareCanvas(pages[i], pages[i].width, pages[i].height);
    const r = await ocrCanvas(prepared, (f) =>
      onProgress((i + f) / pages.length, pages.length > 1 ? `OCR page ${i + 1} of ${pages.length}` : "Reading text"),
    );
    texts.push(r.text);
    confidences.push(r.confidence);
  }

  return {
    text: texts.join("\n"),
    confidence: confidences.reduce((a, b) => a + b, 0) / confidences.length,
    source: "ocr",
    pages: pages.length,
    preview: previewOf(pages[0]),
  };
}
