import { open } from 'node:fs/promises';
import { basename } from 'node:path';

async function processor() {
  try { return await import('../../dist/model/inputs.js'); }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') throw Error('Run npm ci and npm run build in the repository before using document inputs.');
    throw error;
  }
}
export async function inputTypes() { return (await processor()).inputCapabilities; }
export async function filePrompt(prompt, files, signal = new AbortController().signal) {
  if (!Array.isArray(files) || files.length > 4) throw Error('Attach up to four files.');
  if (!files.length) return prompt;
  const { prepareAttachments, inputPrompt, inputCapabilities } = await processor();
  const uploads = [];
  for (const path of files) {
    signal.throwIfAborted();
    const handle = await open(path, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > inputCapabilities.maxFileBytes || info.size === 0) throw Error('Attachments must be nonempty regular files up to 2 MB.');
      const bytes = Buffer.alloc(inputCapabilities.maxFileBytes + 1); let offset = 0;
      while (offset < bytes.length) {
        signal.throwIfAborted();
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset > inputCapabilities.maxFileBytes) throw Error('Attachment grew beyond the 2 MB limit.');
      uploads.push({ name: basename(path), data: bytes.subarray(0, offset).toString('base64') });
    } finally { await handle.close(); }
  }
  const prepared = await prepareAttachments(uploads, signal);
  if (prompt.includes('[INST]')) {
    const end = prompt.lastIndexOf('[/INST]');
    if (end < 0 || prompt.slice(end + 7).trim()) throw Error('For file inputs, end the prompt at [/INST] or pass a plain-text prompt.');
    return prompt.slice(0, end) + inputPrompt('', prepared) + prompt.slice(end);
  }
  return inputPrompt(prompt, prepared);
}
