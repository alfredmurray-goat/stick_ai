# Files and model input capabilities

Both bundled Stellan models currently take **text**. Documents are converted locally to text before inference. Images can be attached so Stellan can **add them to your project** (a logo, an icon, a photo for a web page), but the models don't see what's in them yet: there is no vision, audio or video encoder in the shipped app. See [Images](#images) and the vision plan in [HANDOVER.md](../HANDOVER.md).

| Input | Lite | Max | What is sent to the model |
| --- | --- | --- | --- |
| Text and code | Yes | Yes | Decoded UTF-8/UTF-16 text |
| Markdown, CSV, JSON, XML, HTML | Yes | Yes | Source text; no script execution |
| SVG | Source only | Source only | XML code, not rendered pixels |
| PDF | Text layer only | Text layer only | Extracted text with page labels |
| DOCX | Body text only | Body text only | Extracted paragraphs and table text |
| PNG, JPEG, GIF, WebP, ICO, BMP, AVIF | Name and size only | Name and size only | File name, format, pixel size and file size. The bytes stay in the app and are copied into the project with `save_image` after you approve |
| Scanned/image-only PDF | No OCR | No OCR | Rejected when a page has no readable text |
| Audio and video | No | No | Rejected |

Lite's pinned supplied file is a Mamba2 text model. Its exact base-model provenance remains unresolved; do not infer vision capability from another model's marketing name. See [MODEL_LICENSE.md](../MODEL_LICENSE.md) for the pinned architecture and provenance limitations. Max's declared base, [Devstral Small 2505](https://huggingface.co/mistralai/Devstral-Small-2505/blob/main/README.md), is explicitly text-only: Mistral removed the vision encoder before fine-tuning. The shipped Stellan files and Stellan-Run provide no separate image projector, speech encoder or video decoder.

## App

Use **Attach** beside the message field, drop files onto the composer, or paste files. Review/remove the queued files, then send a message. Up to four files are accepted: 2 MiB each, 4 MiB combined, 24,000 extracted UTF-8 bytes per file and 32,000 combined. Large documents are rejected with a request for a smaller section; text is not silently cut off. PDFs are limited to 50 pages and password-protected files must be unlocked first.

PDF/DOCX parsing runs in a short-lived local worker with a 15-second timeout and bounded JavaScript heap. PDF scripts, macros, image rendering and external resource fetching are not enabled. Files are not copied into the project or uploaded to an external extraction service. Extracted text stays in the current in-memory conversation and is sent to the selected local model, subject to the app's normal history limits. User-enabled hooks and tools retain their existing approval and privacy behavior. Nothing is rendered as raw HTML.

Document layout, charts, embedded images, DOCX headers/footnotes and visual meaning are not interpreted. Export a readable text excerpt or use a separate trusted OCR tool when needed; OCR output is still text, not native vision. Attachments remain untrusted source material and do not approve tool actions.

## Images

Attach an image the same way as a document (Attach, drag and drop, or paste). The app checks that the file really is the image type its name says, reads its width and height from the file header, and keeps the bytes in memory for this conversation only. Nothing is decoded, rendered or sent anywhere.

Stellan is told the image's name, format, pixel size and file size, and that it can't see the picture. To use it, Stellan looks at the project's folders and calls `save_image` with a path that fits (for example `public/logo.png`). The app then shows **Add this image to your project?** with a preview, the exact path and whether it replaces an existing file. Nothing is written until you press **Add image**. Then Stellan updates the code to use that path.

This covers "here's our logo, put it in the header". It doesn't cover "what's in this screenshot?": that needs the vision encoder planned for the next training. Same limits as other attachments: up to four files, 2 MB each, 4 MB in total. Images are forgotten when you start a new conversation or switch project.

## Stellan-Run

Build the shared input processor once with `npm ci` and `npm run build`. Inspect the capabilities:

```sh
node experimental/stellan-runtime/run.mjs --capabilities
```

Add up to four `--file /path/to/file` flags to the existing launcher command. For example, add `--file ./notes.pdf` to a verified Lite command whose `--prompt` ends at `[/INST]`. The extracted file block is inserted before that closing instruction token. Alternatively, `filePrompt` in `experimental/stellan-runtime/inputs.mjs` prepares a plain-text request for a caller to format. It refuses ambiguous partially generated prompt layouts.

The app and runner use the same validation, extraction and size limits. Only text/token IDs reach the C++ engine. This upload support does not mean Stellan-Run has already replaced the production app's inference engine.
