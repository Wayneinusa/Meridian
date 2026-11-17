// Pull readable text out of an uploaded document, on the device. Used when the
// chosen model cannot open the file type itself (Word, Excel, PowerPoint, or a
// PDF sent to a model without PDF support).
import { unzipSync } from "fflate";
import { extOf, isTextLike, utf8 } from "../util/bytes";

/** Above this, the text is cut and the user is told. */
export const MAX_EXTRACT_CHARS = 1_500_000;

export interface Extracted {
  text: string | null;
  truncated: boolean;
  note?: string;
}

function cap(text: string): Extracted {
  if (text.length > MAX_EXTRACT_CHARS) {
    return { text: text.slice(0, MAX_EXTRACT_CHARS) + "\n\n[The document continues; only the first part is included.]", truncated: true };
  }
  return { text, truncated: false };
}

export async function extractText(bytes: Uint8Array, name: string, mime: string): Promise<Extracted> {
  const ext = extOf(name);
  try {
    if (mime === "application/pdf" || ext === "pdf") return cap(await pdfText(bytes));
    if (ext === "docx") {
      const mammoth = (await import("mammoth/mammoth.browser")).default;
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      return cap((await mammoth.extractRawText({ arrayBuffer: buf })).value);
    }
    if (ext === "xlsx" || ext === "xlsm") return cap(await xlsxText(bytes));
    if (ext === "pptx") return cap(pptxText(bytes));
    if (isTextLike(mime, name)) return cap(utf8.decode(bytes));
  } catch (e) {
    return { text: null, truncated: false, note: `Could not read ${name}: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { text: null, truncated: false };
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  }
  // pdf.js takes ownership of the buffer, so hand it a copy
  const task = pdfjs.getDocument({ data: bytes.slice() });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let line = "";
    const lines: string[] = [];
    for (const item of content.items as { str?: string; hasEOL?: boolean }[]) {
      line += item.str ?? "";
      if (item.hasEOL) {
        lines.push(line);
        line = "";
      }
    }
    if (line) lines.push(line);
    pages.push(`[page ${i}]\n${lines.join("\n")}`);
  }
  await task.destroy();
  return pages.join("\n\n");
}

async function xlsxText(bytes: Uint8Array): Promise<string> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const out: string[] = [];
  wb.eachSheet((ws) => {
    const rows: string[] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        const v = cell.value as unknown;
        let s = "";
        if (v == null) s = "";
        else if (typeof v === "object" && "formula" in (v as object)) {
          const f = v as { formula: string; result?: unknown };
          s = f.result != null ? `${String(f.result)} (=${f.formula})` : `=${f.formula}`;
        } else if (v instanceof Date) s = v.toISOString().slice(0, 10);
        else if (typeof v === "object" && "richText" in (v as object)) s = (v as { richText: { text: string }[] }).richText.map((r) => r.text).join("");
        else if (typeof v === "object" && "text" in (v as object)) s = String((v as { text: unknown }).text);
        else s = String(v);
        cells.push(/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
      });
      rows.push(cells.join(","));
    });
    out.push(`[sheet "${ws.name}"]\n${rows.join("\n")}`);
  });
  return out.join("\n\n");
}

function pptxText(bytes: Uint8Array): string {
  const files = unzipSync(bytes, { filter: (f) => /^ppt\/(slides|notesSlides)\/[^/]+\.xml$/.test(f.name) });
  const num = (n: string) => Number(/(\d+)\.xml$/.exec(n)?.[1] ?? 0);
  const grab = (xml: string) =>
    xml
      .split(/<\/a:p>/)
      .map((p) => [...p.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)].map((m) => m[1]).join(""))
      .map((s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'"))
      .filter((s) => s.trim())
      .join("\n");
  const slides = Object.keys(files).filter((n) => n.startsWith("ppt/slides/")).sort((a, b) => num(a) - num(b));
  return slides
    .map((name) => {
      const notes = files[`ppt/notesSlides/notesSlide${num(name)}.xml`];
      const body = grab(utf8.decode(files[name]));
      return `[slide ${num(name)}]\n${body}${notes ? `\n[notes]\n${grab(utf8.decode(notes))}` : ""}`;
    })
    .join("\n\n");
}
