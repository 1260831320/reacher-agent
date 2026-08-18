import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export const extractPdfText = async (paper, { signal, maxBytes, maxChars }) => {
  const response = await fetch(paper.pdfUrl, {
    signal,
    headers: { 'User-Agent': 'personal-ai-research-agent/0.2 (academic evidence extraction)' }
  });
  if (!response.ok) throw new Error(`PDF request failed: HTTP ${response.status}`);
  const declaredSize = Number(response.headers.get('content-length') || 0);
  if (declaredSize > maxBytes) throw new Error(`PDF exceeds ${maxBytes} bytes`);
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.byteLength > maxBytes) throw new Error(`PDF exceeds ${maxBytes} bytes`);

  const loadingTask = getDocument({ data, isEvalSupported: false, useSystemFonts: true });
  const document = await loadingTask.promise;
  const pages = [];
  let chars = 0;
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages && chars < maxChars; pageNumber += 1) {
      if (signal.aborted) throw signal.reason || new Error('PDF extraction aborted');
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items.map((item) => item.str || '').join(' ').replace(/[ \t]+/g, ' ').trim();
      if (text) {
        pages.push(`\n[Page ${pageNumber}]\n${text}`);
        chars += text.length;
      }
      page.cleanup();
    }
  } finally {
    await document.destroy();
  }
  const text = pages.join('\n');
  return { text: text.slice(0, maxChars), pdfBytes: data.byteLength, truncated: chars > maxChars };
};
