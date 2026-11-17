// File-creation tools. Everything is produced on the device - no server, no
// sandbox - so it works the same on iPhone, iPad and Windows with any model
// that can call tools.
import { mimeFromName, safeFileName, utf8 } from "../util/bytes";
import { parseMarkdown, type Block, type Run } from "./markdown";
import type { Tool, ToolOutput } from "./types";

const never = () => false;

function done(ref: { name: string; size: number }, what: string): string {
  return `Created ${what} "${ref.name}" (${ref.size} bytes). It is shown to the user under this message, where they can open, preview and save it.`;
}

// ---------- plain files ----------

const createFile: Tool = {
  group: "files",
  title: "Create file",
  spec: {
    name: "create_file",
    description:
      "Create a text-based file for the user: Markdown, CSV, JSON, HTML, SVG, source code, plain text and so on. " +
      "Use the dedicated tools for .xlsx, .pdf, .docx and .pptx instead of this one. HTML and SVG files can be previewed in the app.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "File name with extension, e.g. report.md or page.html" },
        content: { type: "string", description: "Full text content of the file" },
      },
      required: ["filename", "content"],
    },
  },
  needsApproval: never,
  summarize: (i) => `Create ${String(i.filename)}`,
  async run(input, ctx): Promise<ToolOutput> {
    const name = safeFileName(String(input.filename), "txt");
    if (/\.(xlsx|pdf|docx|pptx)$/i.test(name)) {
      return { isError: true, text: `Use the dedicated tool for ${name.split(".").pop()} files; create_file only writes text files.` };
    }
    const ref = await ctx.saveBlob(utf8.encode(String(input.content)), mimeFromName(name, "text/plain"), name);
    return { text: done(ref, "file"), artifacts: [ref] };
  },
};

// ---------- spreadsheets ----------

type Cell = string | number | boolean | null;

export async function buildXlsx(sheets: { name?: string; rows: Cell[][]; header?: boolean; column_widths?: number[] }[]): Promise<Uint8Array> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "Meridian";
  wb.created = new Date();
  const used = new Set<string>();
  sheets.forEach((sheet, i) => {
    let name = (sheet.name || `Sheet${i + 1}`).replace(/[\\/*?:[\]]/g, " ").slice(0, 31) || `Sheet${i + 1}`;
    while (used.has(name.toLowerCase())) name = `${name.slice(0, 28)} ${i + 1}`;
    used.add(name.toLowerCase());
    const ws = wb.addWorksheet(name);
    const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
    const widths: number[] = [];
    rows.forEach((row, r) => {
      const cells = Array.isArray(row) ? row : [row as Cell];
      const xr = ws.getRow(r + 1);
      cells.forEach((value, c) => {
        const cell = xr.getCell(c + 1);
        if (typeof value === "string" && value.startsWith("=") && value.length > 1) {
          cell.value = { formula: value.slice(1) } as never;
        } else if (value !== null && value !== undefined) {
          cell.value = value;
        }
        const len = value == null ? 0 : String(value).length;
        widths[c] = Math.max(widths[c] ?? 0, Math.min(len, 60));
      });
      xr.commit();
    });
    const header = sheet.header !== false && rows.length > 0;
    if (header) {
      ws.getRow(1).font = { bold: true };
      ws.views = [{ state: "frozen", ySplit: 1 }];
    }
    widths.forEach((w, c) => {
      ws.getColumn(c + 1).width = sheet.column_widths?.[c] ?? Math.max(8, w + 2);
    });
  });
  if (!sheets.length) wb.addWorksheet("Sheet1");
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

const createSpreadsheet: Tool = {
  group: "files",
  title: "Create spreadsheet",
  spec: {
    name: "create_spreadsheet",
    description:
      "Create an Excel workbook (.xlsx) with one or more sheets. Each sheet is a grid of rows. " +
      'A string cell that starts with "=" is written as a live formula (e.g. "=SUM(B2:B10)"); prefer formulas over pre-computed totals so the sheet stays editable. ' +
      "Numbers must be JSON numbers, not strings. The first row is treated as a header unless header is false.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "e.g. budget.xlsx" },
        sheets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Sheet tab name (max 31 characters)" },
              rows: {
                type: "array",
                description: "Rows from top to bottom; each row is an array of cells",
                items: { type: "array", items: { type: ["string", "number", "boolean", "null"] } },
              },
              header: { type: "boolean", description: "Style and freeze the first row. Default true." },
              column_widths: { type: "array", items: { type: "number" }, description: "Optional widths in characters" },
            },
            required: ["rows"],
          },
        },
      },
      required: ["filename", "sheets"],
    },
  },
  needsApproval: never,
  summarize: (i) => `Create spreadsheet ${String(i.filename)}`,
  async run(input, ctx) {
    const name = safeFileName(String(input.filename).replace(/\.(xls|csv)$/i, ".xlsx"), "xlsx");
    const bytes = await buildXlsx(input.sheets as never);
    const ref = await ctx.saveBlob(bytes, mimeFromName("x.xlsx"), name);
    return { text: done(ref, "spreadsheet"), artifacts: [ref] };
  },
};

// ---------- PDF ----------

type PdfNode = Record<string, unknown> | string;

function pdfRuns(runs: Run[]): PdfNode[] {
  if (!runs.length) return [""];
  return runs.map((r) => ({
    text: r.text,
    bold: r.bold || undefined,
    italics: r.italic || undefined,
    decoration: r.strike ? "lineThrough" : r.link ? "underline" : undefined,
    link: r.link,
    color: r.link ? "#1a56b8" : undefined,
    background: r.code ? "#f0f0f0" : undefined,
  }));
}

function pdfBlocks(blocks: Block[]): PdfNode[] {
  const out: PdfNode[] = [];
  for (const b of blocks) {
    switch (b.t) {
      case "heading":
        out.push({ text: pdfRuns(b.runs), style: `h${Math.min(b.level, 4)}` });
        break;
      case "para":
        out.push({ text: pdfRuns(b.runs), margin: [0, 0, 0, 8] });
        break;
      case "code":
        out.push({
          table: { widths: ["*"], body: [[{ text: b.text, fontSize: 9, preserveLeadingSpaces: true, margin: [6, 4, 6, 4] }]] },
          layout: { fillColor: () => "#f5f5f5", hLineWidth: () => 0, vLineWidth: () => 0 },
          margin: [0, 2, 0, 10],
        });
        break;
      case "quote":
        out.push({ stack: pdfBlocks(b.blocks), margin: [14, 0, 0, 6], color: "#555555", italics: true });
        break;
      case "rule":
        out.push({ canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.6, lineColor: "#bbbbbb" }], margin: [0, 6, 0, 10] });
        break;
      case "list": {
        const items = b.items.map((it) => (it.children.length ? { stack: [{ text: pdfRuns(it.runs) }, ...pdfBlocks(it.children)] } : { text: pdfRuns(it.runs) }));
        out.push({ [b.ordered ? "ol" : "ul"]: items, margin: [0, 0, 0, 8] });
        break;
      }
      case "table": {
        const cols = Math.max(b.header.length, ...b.rows.map((r) => r.length), 1);
        const pad = (cells: Run[][], bold: boolean) =>
          Array.from({ length: cols }, (_, i) => ({ text: pdfRuns(cells[i] ?? []), bold: bold || undefined, fontSize: 10 }));
        out.push({
          table: { headerRows: 1, widths: Array(cols).fill("auto"), body: [pad(b.header, true), ...b.rows.map((r) => pad(r, false))] },
          layout: "lightHorizontalLines",
          margin: [0, 2, 0, 10],
        });
        break;
      }
    }
  }
  return out;
}

export async function buildPdf(markdown: string, opts: { title?: string; landscape?: boolean; pageSize?: string } = {}): Promise<Uint8Array> {
  const [{ default: pdfMake }, { default: vfs }] = await Promise.all([import("pdfmake/build/pdfmake"), import("pdfmake/build/vfs_fonts")]);
  pdfMake.addVirtualFileSystem(vfs);
  const content = pdfBlocks(parseMarkdown(markdown));
  const doc = {
    info: { title: opts.title ?? "Document", creator: "Meridian" },
    pageSize: opts.pageSize === "LETTER" ? "LETTER" : "A4",
    pageOrientation: opts.landscape ? "landscape" : "portrait",
    pageMargins: [40, 48, 40, 48],
    content: content.length ? content : [""],
    footer: (page: number, pages: number) => ({ text: `${page} / ${pages}`, alignment: "center", fontSize: 8, color: "#888888", margin: [0, 16, 0, 0] }),
    defaultStyle: { fontSize: 11, lineHeight: 1.25 },
    styles: {
      h1: { fontSize: 22, bold: true, margin: [0, 6, 0, 10] },
      h2: { fontSize: 17, bold: true, margin: [0, 10, 0, 8] },
      h3: { fontSize: 14, bold: true, margin: [0, 8, 0, 6] },
      h4: { fontSize: 12, bold: true, margin: [0, 6, 0, 4] },
    },
  };
  return new Uint8Array(await pdfMake.createPdf(doc).getBuffer());
}

const createPdf: Tool = {
  group: "files",
  title: "Create PDF",
  spec: {
    name: "create_pdf",
    description:
      "Create a PDF document from Markdown. Supports headings, paragraphs, bold/italic, links, bullet and numbered lists, tables, code blocks, quotes and horizontal rules. " +
      "Start the document with a # heading for the title. Latin, Greek and Cyrillic text is supported.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "e.g. report.pdf" },
        markdown: { type: "string", description: "Document body as Markdown" },
        title: { type: "string", description: "Document title for the PDF metadata" },
        landscape: { type: "boolean" },
        page_size: { type: "string", enum: ["A4", "LETTER"] },
      },
      required: ["filename", "markdown"],
    },
  },
  needsApproval: never,
  summarize: (i) => `Create PDF ${String(i.filename)}`,
  async run(input, ctx) {
    const name = safeFileName(String(input.filename), "pdf").replace(/\.[^.]+$/, ".pdf");
    const bytes = await buildPdf(String(input.markdown), {
      title: input.title as string | undefined,
      landscape: input.landscape === true,
      pageSize: input.page_size as string | undefined,
    });
    const ref = await ctx.saveBlob(bytes, "application/pdf", name);
    return { text: done(ref, "PDF"), artifacts: [ref] };
  },
};

// ---------- Word ----------

export async function buildDocx(markdown: string, opts: { title?: string } = {}): Promise<Uint8Array> {
  const d = await import("docx");
  const HEADINGS = [d.HeadingLevel.HEADING_1, d.HeadingLevel.HEADING_2, d.HeadingLevel.HEADING_3, d.HeadingLevel.HEADING_4, d.HeadingLevel.HEADING_5, d.HeadingLevel.HEADING_6];

  const runs = (rs: Run[]) =>
    rs.flatMap((r) => {
      const lines = r.text.split("\n");
      return lines.map((line, i) => {
        const run = new d.TextRun({
          text: line,
          bold: r.bold,
          italics: r.italic,
          strike: r.strike,
          break: i > 0 ? 1 : undefined,
          font: r.code ? "Consolas" : undefined,
          color: r.link ? "1A56B8" : undefined,
          underline: r.link ? {} : undefined,
        });
        return r.link ? new d.ExternalHyperlink({ link: r.link, children: [run] }) : run;
      });
    });

  type Child = InstanceType<typeof d.Paragraph> | InstanceType<typeof d.Table>;
  const render = (blocks: Block[], level = 0): Child[] => {
    const out: Child[] = [];
    for (const b of blocks) {
      switch (b.t) {
        case "heading":
          out.push(new d.Paragraph({ heading: HEADINGS[Math.min(b.level, 6) - 1], children: runs(b.runs) }));
          break;
        case "para":
          out.push(new d.Paragraph({ children: runs(b.runs), spacing: { after: 160 } }));
          break;
        case "code":
          for (const line of b.text.split("\n")) {
            out.push(
              new d.Paragraph({
                children: [new d.TextRun({ text: line || " ", font: "Consolas", size: 18 })],
                shading: { type: d.ShadingType.CLEAR, fill: "F3F3F3", color: "auto" },
                spacing: { after: 0 },
              }),
            );
          }
          out.push(new d.Paragraph({ children: [] }));
          break;
        case "quote":
          for (const q of b.blocks) {
            if (q.t === "para") out.push(new d.Paragraph({ children: runs(q.runs.map((r) => ({ ...r, italic: true }))), indent: { left: 480 } }));
            else out.push(...render([q], level));
          }
          break;
        case "rule":
          out.push(new d.Paragraph({ children: [], border: { bottom: { style: d.BorderStyle.SINGLE, size: 6, color: "BBBBBB", space: 1 } } }));
          break;
        case "list":
          for (const item of b.items) {
            out.push(
              new d.Paragraph({
                children: runs(item.runs),
                ...(b.ordered ? { numbering: { reference: "ordered", level: Math.min(level, 4) } } : { bullet: { level: Math.min(level, 4) } }),
              }),
            );
            if (item.children.length) out.push(...render(item.children, level + 1));
          }
          break;
        case "table": {
          const cols = Math.max(b.header.length, ...b.rows.map((r) => r.length), 1);
          const row = (cells: Run[][], bold: boolean) =>
            new d.TableRow({
              tableHeader: bold,
              children: Array.from(
                { length: cols },
                (_, i) =>
                  new d.TableCell({
                    children: [new d.Paragraph({ children: runs((cells[i] ?? []).map((r) => ({ ...r, bold: bold || r.bold }))) })],
                    shading: bold ? { type: d.ShadingType.CLEAR, fill: "EFEFEF", color: "auto" } : undefined,
                  }),
              ),
            });
          out.push(new d.Table({ width: { size: 100, type: d.WidthType.PERCENTAGE }, rows: [row(b.header, true), ...b.rows.map((r) => row(r, false))] }));
          out.push(new d.Paragraph({ children: [] }));
          break;
        }
      }
    }
    return out;
  };

  const doc = new d.Document({
    creator: "Meridian",
    title: opts.title,
    numbering: {
      config: [
        {
          reference: "ordered",
          levels: [0, 1, 2, 3, 4].map((lvl) => ({
            level: lvl,
            format: d.LevelFormat.DECIMAL,
            text: `%${lvl + 1}.`,
            alignment: d.AlignmentType.START,
            style: { paragraph: { indent: { left: 720 * (lvl + 1), hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [{ children: render(parseMarkdown(markdown)) }],
  });
  const blob = await d.Packer.toBlob(doc);
  return new Uint8Array(await blob.arrayBuffer());
}

const createDocument: Tool = {
  group: "files",
  title: "Create Word document",
  spec: {
    name: "create_document",
    description:
      "Create a Word document (.docx) from Markdown. Supports headings, paragraphs, bold/italic/strikethrough, links, bullet and numbered lists (nested), tables, code blocks and quotes.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "e.g. proposal.docx" },
        markdown: { type: "string", description: "Document body as Markdown" },
        title: { type: "string" },
      },
      required: ["filename", "markdown"],
    },
  },
  needsApproval: never,
  summarize: (i) => `Create document ${String(i.filename)}`,
  async run(input, ctx) {
    const name = safeFileName(String(input.filename), "docx").replace(/\.[^.]+$/, ".docx");
    const bytes = await buildDocx(String(input.markdown), { title: input.title as string | undefined });
    const ref = await ctx.saveBlob(bytes, mimeFromName("x.docx"), name);
    return { text: done(ref, "Word document"), artifacts: [ref] };
  },
};

// ---------- PowerPoint ----------

interface SlideSpec {
  title?: string;
  subtitle?: string;
  bullets?: string[];
  text?: string;
  table?: (string | number)[][];
  notes?: string;
}

export async function buildPptx(slides: SlideSpec[], opts: { title?: string } = {}): Promise<Uint8Array> {
  const PptxGenJS = (await import("pptxgenjs")).default;
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE"; // 13.33 x 7.5 in
  if (opts.title) pptx.title = opts.title;
  slides.forEach((s, index) => {
    const slide = pptx.addSlide();
    const isTitleSlide = index === 0 && !s.bullets?.length && !s.text && !s.table;
    if (isTitleSlide) {
      slide.addText(s.title ?? opts.title ?? "", { x: 0.8, y: 2.4, w: 11.7, h: 1.4, fontSize: 40, bold: true, align: "center", valign: "middle" });
      if (s.subtitle) slide.addText(s.subtitle, { x: 0.8, y: 3.9, w: 11.7, h: 0.9, fontSize: 20, color: "666666", align: "center" });
    } else {
      if (s.title) slide.addText(s.title, { x: 0.6, y: 0.35, w: 12.1, h: 0.9, fontSize: 28, bold: true, valign: "middle" });
      let y = s.title ? 1.4 : 0.6;
      if (s.subtitle) {
        slide.addText(s.subtitle, { x: 0.6, y, w: 12.1, h: 0.5, fontSize: 16, color: "666666" });
        y += 0.6;
      }
      if (s.text) {
        const h = s.bullets?.length || s.table ? 1.3 : 7.0 - y;
        slide.addText(s.text, { x: 0.6, y, w: 12.1, h, fontSize: 18, valign: "top" });
        y += h + 0.1;
      }
      if (s.bullets?.length) {
        const h = s.table ? 2.2 : 7.0 - y;
        slide.addText(
          s.bullets.map((b) => ({ text: String(b), options: { bullet: true, breakLine: true } })),
          { x: 0.6, y, w: 12.1, h, fontSize: s.bullets.length > 7 ? 16 : 20, valign: "top", paraSpaceAfter: 8 },
        );
        y += h + 0.1;
      }
      if (s.table?.length) {
        const rows = s.table.map((row, r) =>
          row.map((cell) => ({ text: String(cell ?? ""), options: r === 0 ? { bold: true, fill: { color: "EFEFEF" } } : {} })),
        );
        slide.addTable(rows as never, { x: 0.6, y, w: 12.1, fontSize: 14, border: { type: "solid", color: "CCCCCC", pt: 0.75 } });
      }
    }
    if (s.notes) slide.addNotes(s.notes);
  });
  if (!slides.length) pptx.addSlide();
  const out = await pptx.write({ outputType: "uint8array" });
  return out as Uint8Array;
}

const createPresentation: Tool = {
  group: "files",
  title: "Create presentation",
  spec: {
    name: "create_presentation",
    description:
      "Create a PowerPoint deck (.pptx). Each slide has a title and any of: subtitle, bullets, a short text paragraph, a table (first row is the header), and speaker notes. " +
      "A first slide with only a title (and subtitle) becomes the title slide. Keep slides light: at most ~6 bullets each.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "e.g. kickoff.pptx" },
        title: { type: "string", description: "Deck title" },
        slides: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              subtitle: { type: "string" },
              bullets: { type: "array", items: { type: "string" } },
              text: { type: "string" },
              table: { type: "array", items: { type: "array", items: { type: ["string", "number"] } } },
              notes: { type: "string", description: "Speaker notes" },
            },
          },
        },
      },
      required: ["filename", "slides"],
    },
  },
  needsApproval: never,
  summarize: (i) => `Create presentation ${String(i.filename)}`,
  async run(input, ctx) {
    const name = safeFileName(String(input.filename), "pptx").replace(/\.[^.]+$/, ".pptx");
    const bytes = await buildPptx(input.slides as SlideSpec[], { title: input.title as string | undefined });
    const ref = await ctx.saveBlob(bytes, mimeFromName("x.pptx"), name);
    return { text: done(ref, "presentation"), artifacts: [ref] };
  },
};

export const fileTools: Tool[] = [createFile, createSpreadsheet, createPdf, createDocument, createPresentation];
