# PDF.js

Vendored `pdfjs-dist` 6.4.299 from https://www.npmjs.com/package/pdfjs-dist/v/6.4.299
(Mozilla, Apache-2.0; see LICENSE). Browser ES modules and worker only. No CDN,
no Python dependencies. Used with `isEvalSupported: false` and system fonts;
scanned PDFs and common fonts render locally. Documents requiring optional CMaps,
standard font packs or other unsupported features can use the original-file fallback.
Update both module and worker together when upgrading; review upstream security releases.
