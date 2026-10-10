// Turns an uploaded file into text.
//   - images (PNG, JPG, WebP): OCR with tesseract.js
//   - PDFs: the text layer when there is one, otherwise each page is drawn to an image and OCR'd
// Language data ships in ocr/ so nothing is downloaded at run time.
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createWorker, PSM } from 'tesseract.js';

const LANG_DIR = fileURLToPath(new URL('../ocr/', import.meta.url));
const MAX_PDF_PAGES = 4;
const MIN_TEXT_PER_PAGE = 40; // fewer characters than this and the page is treated as a scan

let workerPromise = null;
function worker() {
  workerPromise ??= createWorker('eng', 1, {
    langPath: LANG_DIR,
    gzip: false,
    cachePath: tmpdir(), // tesseract.js would otherwise drop a copy of the language file in the working directory
  }).then(async (w) => {
    await w.setParameters({ tessedit_pageseg_mode: PSM.AUTO, preserve_interword_spaces: '1' });
    return w;
  });
  return workerPromise;
}

async function ocrImage(buf) {
  const w = await worker();
  const { data } = await w.recognize(buf);
  return { text: data.text ?? '', confidence: Math.round(data.confidence ?? 0) };
}

// pdf.js hands back text in runs; start a new line whenever the baseline moves.
function linesOf(items) {
  const lines = [];
  let y = null;
  let cur = '';
  for (const it of items) {
    if (!('str' in it)) continue;
    const ny = Math.round(it.transform[5]);
    if (y !== null && Math.abs(ny - y) > 3) { lines.push(cur); cur = ''; }
    cur += (cur && !cur.endsWith(' ') && !it.str.startsWith(' ') ? ' ' : '') + it.str;
    y = ny;
    if (it.hasEOL) { lines.push(cur); cur = ''; y = null; }
  }
  if (cur) lines.push(cur);
  return lines.map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
}

async function readPdf(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: false, isEvalSupported: false, verbosity: 0 }).promise;
  const pages = Math.min(doc.numPages, MAX_PDF_PAGES);
  const parts = [];
  let method = 'pdf-text';
  let conf = null;
  for (let n = 1; n <= pages; n++) {
    const page = await doc.getPage(n);
    const text = linesOf((await page.getTextContent()).items);
    if (text.replace(/\s/g, '').length >= MIN_TEXT_PER_PAGE) { parts.push(text); continue; }
    // no usable text layer: this page is a picture of a page
    const { createCanvas } = await import('@napi-rs/canvas');
    // draw at about 2x, but never let an oversized page (a huge MediaBox) ask for gigabytes of canvas
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(2.2, Math.sqrt(12e6 / (base.width * base.height))) });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvasContext: canvas.getContext('2d'), viewport, canvas }).promise;
    const r = await ocrImage(canvas.toBuffer('image/png'));
    parts.push(r.text);
    method = method === 'pdf-text' && n === 1 ? 'ocr' : 'mixed';
    conf = conf === null ? r.confidence : Math.round((conf + r.confidence) / 2);
  }
  return { text: parts.join('\n\n'), method, confidence: conf, pages: doc.numPages, truncated: doc.numPages > MAX_PDF_PAGES };
}

/** @returns {{text:string, method:'pdf-text'|'ocr'|'mixed', confidence:number|null, pages:number, truncated?:boolean}} */
export async function extractText(buf, mime) {
  if (mime === 'application/pdf') return readPdf(buf);
  const r = await ocrImage(buf);
  return { text: r.text, method: 'ocr', confidence: r.confidence, pages: 1 };
}

export async function shutdownOcr() {
  if (!workerPromise) return;
  const w = await workerPromise;
  workerPromise = null;
  await w.terminate();
}
