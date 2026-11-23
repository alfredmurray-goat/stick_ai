import { parentPort, workerData } from 'node:worker_threads';
import { unzipSync } from 'fflate';

const maxTextBytes = 24000;
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
function bounded(text) {
  if (Buffer.byteLength(text, 'utf8') > maxTextBytes) throw Error('This document has too much text. Attach a smaller section (up to 24 KB of extracted text).');
  if (!text.trim()) throw Error('No readable text was found. Scanned pages and images need OCR before attaching.');
  return text;
}
function entities(text) {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (_, value) => {
    if (value.startsWith('#')) {
      const point = value[1].toLowerCase() === 'x' ? parseInt(value.slice(2), 16) : Number(value.slice(1));
      if (!Number.isInteger(point) || point < 1 || point > 0x10ffff || point >= 0xd800 && point <= 0xdfff) throw Error('Invalid document character.');
      return String.fromCodePoint(point);
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[value.toLowerCase()];
  });
}
async function extract() {
  // No external resources, embedded scripts, macros or image rendering are used.
  globalThis.fetch = async () => { throw Error('External document resources are disabled.'); };
  const bytes = new Uint8Array(workerData.bytes);
  if (workerData.kind === 'docx') {
    let entries = 0;
    const files = unzipSync(bytes, { filter: file => {
      if (++entries > 1024) throw Error('The document contains too many ZIP entries.');
      if (file.name !== 'word/document.xml') return false;
      if (file.originalSize > 4 * 1024 ** 2) throw Error('The expanded document is too large.');
      return true;
    } });
    if (!files['word/document.xml']) throw Error('This is not a readable DOCX document.');
    const xml = decode(files['word/document.xml']);
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw Error('External XML entities are unsupported.');
    const clean = xml.replace(/<!--[\s\S]*?-->/g, '');
    let text = '';
    for (const match of clean.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(tab|br)\b[^>]*\/>|<\/w:(p|tr)>|<\/w:tc>/g)) {
      text += match[1] !== undefined ? entities(match[1]) : match[2] === 'tab' || match[0] === '</w:tc>' ? '\t' : '\n';
      if (Buffer.byteLength(text) > maxTextBytes) bounded(text);
    }
    return bounded(text.trim());
  }
  if (workerData.kind === 'pdf') {
    const { getDocumentProxy } = await import('unpdf');
    let pdf;
    try {
      pdf = await getDocumentProxy(bytes, { isEvalSupported: false, useSystemFonts: false, disableFontFace: true,
        useWasm: false, useWorkerFetch: false, maxImageSize: 0, isOffscreenCanvasSupported: false,
        isImageDecoderSupported: false, disableAutoFetch: true, verbosity: 0 });
      if (pdf.numPages > 50) throw Error('Attach a PDF section of 50 pages or fewer.');
      let text = '';
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        const content = await page.getTextContent();
        text += `\n[Page ${n}]\n`;
        let readable = '';
        for (const item of content.items) {
          if (typeof item.str === 'string') readable += item.str + (item.hasEOL ? '\n' : ' ');
          if (Buffer.byteLength(text) + Buffer.byteLength(readable) > maxTextBytes) throw Error('This PDF has too much text. Attach a smaller section.');
        }
        if (!readable.trim()) throw Error(`Page ${n} has no readable text. Scanned or image-only pages need OCR first.`);
        text += readable;
        page.cleanup();
      }
      return bounded(text.trim());
    } catch (error) {
      if (error?.name === 'PasswordException') throw Error('Unlock the password-protected PDF before attaching it.');
      throw error;
    } finally { if (pdf) await pdf.loadingTask.destroy(); }
  }
  throw Error('Unsupported document type.');
}
try { parentPort.postMessage({ text: await extract() }); }
catch (error) { parentPort.postMessage({ error: error instanceof Error ? error.message : 'The document could not be read.' }); }
