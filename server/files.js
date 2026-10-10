// Checks an uploaded file before anything reads or stores it. The browser's idea of the file type
// is not trusted: the first bytes have to match, and images cannot be absurdly large.
export const FILE_TYPES = { 'application/pdf': 'PDF', 'image/png': 'image', 'image/jpeg': 'image', 'image/webp': 'image' };
export const MAX_BYTES = 3 * 1024 * 1024;
const MAX_PIXELS = 24e6; // an image this size would take far more memory to read than its file size suggests

export class UploadError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function sniff(b) {
  if (b.length >= 5 && b.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
  if (b.length >= 8 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function pixels(b, mime) {
  try {
    if (mime === 'image/png') return b.readUInt32BE(16) * b.readUInt32BE(20);
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const marker = b[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return b.readUInt16BE(i + 5) * b.readUInt16BE(i + 7);
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
    if (mime === 'image/webp' && b.toString('latin1', 12, 16) === 'VP8X') {
      return (1 + (b[24] | (b[25] << 8) | (b[26] << 16))) * (1 + (b[27] | (b[28] << 8) | (b[29] << 16)));
    }
  } catch { /* unreadable header: the reader will reject it */ }
  return 0;
}

/** @param {{mime?:string, name?:string, base64?:string}} file as sent by the browser */
export function decodeUpload(file) {
  if (!file || typeof file !== 'object') throw new UploadError('Choose a file first.');
  const mime = String(file.mime ?? '');
  if (!FILE_TYPES[mime]) throw new UploadError('Only PDF, PNG, JPG or WebP files can be added.');
  const buf = Buffer.from(String(file.base64 ?? ''), 'base64');
  if (!buf.length) throw new UploadError('The file looks empty.');
  if (buf.length > MAX_BYTES) throw new UploadError('Files can be up to 3 MB.');
  if (sniff(buf) !== mime) throw new UploadError(`That does not look like a real ${FILE_TYPES[mime] === 'PDF' ? 'PDF' : 'image'} file. Try saving or exporting it again.`);
  if (pixels(buf, mime) > MAX_PIXELS) throw new UploadError('That image is too large to read. Take the photo at a lower resolution.');
  return { mime, name: String(file.name ?? 'file').slice(0, 100), buf };
}
