// PDF resume parser — extracts plain text from a user-uploaded PDF.
//
// We use pdfjs-dist with the worker bundled by Vite (via `?url` import). The
// worker file gets copied into dist/ at build time and pdfjs loads it from
// chrome-extension://<id>/assets/pdf.worker-*.mjs at runtime.
//
// Text extraction is line-aware: we group runs of items that share a Y
// coordinate, then join with newlines. This preserves resume structure
// (section headers, bullet points) better than naive concatenation.

import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type ParseResult = {
  text: string;
  pages: number;
  bytes: number;
};

export async function parsePdf(file: File): Promise<ParseResult> {
  if (file.type && file.type !== "application/pdf") {
    throw new Error(`Not a PDF (got ${file.type}). Use a .pdf file.`);
  }
  if (file.size > 8 * 1024 * 1024) {
    throw new Error("PDF is over 8 MB. Resumes should be under 2 MB ideally.");
  }

  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;

  const lines: string[] = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    lines.push(...groupByLine(content.items as Array<{ str: string; transform?: number[] }>));
    if (pageNum < doc.numPages) lines.push(""); // page break
  }
  await doc.cleanup();

  const text = lines.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text, pages: doc.numPages, bytes: file.size };
}

// pdf.js returns each text "item" as a positioned chunk. Group items that
// share the same Y coordinate (within 2px) into a single line.
function groupByLine(items: Array<{ str: string; transform?: number[] }>): string[] {
  const buckets = new Map<number, string[]>();
  for (const it of items) {
    if (!it.str) continue;
    // transform = [scaleX, skewX, skewY, scaleY, translateX, translateY]
    const y = it.transform ? Math.round(it.transform[5]) : 0;
    // Bucket by quantized Y so 122 / 123 / 124 group together
    const bucket = Math.round(y / 2) * 2;
    const arr = buckets.get(bucket) ?? [];
    arr.push(it.str);
    buckets.set(bucket, arr);
  }
  // Sort buckets top-to-bottom (PDF Y axis goes UP from bottom-left)
  const sorted = [...buckets.entries()].sort((a, b) => b[0] - a[0]);
  return sorted.map(([, parts]) => parts.join(" ").replace(/\s+/g, " ").trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Blob storage helpers — we save the PDF bytes (base64) in chrome.storage so
// the content script can re-create a File and drop it into LinkedIn upload
// fields. chrome.storage doesn't accept Blobs directly, hence the encoding.
// ---------------------------------------------------------------------------

export async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
    reader.onload = () => {
      const result = reader.result as string;
      // result looks like "data:application/pdf;base64,JVBERi0xLjcKJ..."
      const idx = result.indexOf(",");
      resolve(idx === -1 ? result : result.slice(idx + 1));
    };
    reader.readAsDataURL(file);
  });
}

export function base64ToBlob(base64: string, mime = "application/pdf"): Blob {
  const bin = atob(base64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export function base64ToFile(base64: string, filename = "resume.pdf", mime = "application/pdf"): File {
  return new File([base64ToBlob(base64, mime)], filename, { type: mime });
}
