// Markdown -> a small neutral block model, shared by the PDF and Word writers.
import { marked, type Token, type Tokens } from "marked";

export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  link?: string;
}

export type Block =
  | { t: "heading"; level: number; runs: Run[] }
  | { t: "para"; runs: Run[] }
  | { t: "list"; ordered: boolean; items: { runs: Run[]; children: Block[] }[] }
  | { t: "table"; header: Run[][]; rows: Run[][][] }
  | { t: "code"; text: string }
  | { t: "quote"; blocks: Block[] }
  | { t: "rule" };

function unescape(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function inline(tokens: Token[] | undefined, style: Omit<Run, "text"> = {}): Run[] {
  const out: Run[] = [];
  for (const tok of tokens ?? []) {
    switch (tok.type) {
      case "strong":
        out.push(...inline((tok as Tokens.Strong).tokens, { ...style, bold: true }));
        break;
      case "em":
        out.push(...inline((tok as Tokens.Em).tokens, { ...style, italic: true }));
        break;
      case "del":
        out.push(...inline((tok as Tokens.Del).tokens, { ...style, strike: true }));
        break;
      case "codespan":
        out.push({ ...style, code: true, text: unescape((tok as Tokens.Codespan).text) });
        break;
      case "link":
        out.push(...inline((tok as Tokens.Link).tokens, { ...style, link: (tok as Tokens.Link).href }));
        break;
      case "image":
        out.push({ ...style, text: `[${(tok as Tokens.Image).text || "image"}]` });
        break;
      case "br":
        out.push({ ...style, text: "\n" });
        break;
      case "text": {
        const t = tok as Tokens.Text;
        if (t.tokens?.length) out.push(...inline(t.tokens, style));
        else out.push({ ...style, text: unescape(t.text) });
        break;
      }
      default:
        if ("text" in tok && typeof tok.text === "string") out.push({ ...style, text: unescape(tok.text) });
    }
  }
  return out;
}

function blocks(tokens: Token[]): Block[] {
  const out: Block[] = [];
  for (const tok of tokens) {
    switch (tok.type) {
      case "heading":
        out.push({ t: "heading", level: (tok as Tokens.Heading).depth, runs: inline((tok as Tokens.Heading).tokens) });
        break;
      case "paragraph":
        out.push({ t: "para", runs: inline((tok as Tokens.Paragraph).tokens) });
        break;
      case "text":
        out.push({ t: "para", runs: inline([tok]) });
        break;
      case "code":
        out.push({ t: "code", text: (tok as Tokens.Code).text });
        break;
      case "blockquote":
        out.push({ t: "quote", blocks: blocks((tok as Tokens.Blockquote).tokens) });
        break;
      case "hr":
        out.push({ t: "rule" });
        break;
      case "list": {
        const list = tok as Tokens.List;
        out.push({
          t: "list",
          ordered: !!list.ordered,
          items: list.items.map((item) => {
            const runs: Run[] = [];
            const children: Block[] = [];
            for (const child of item.tokens) {
              if (child.type === "text" || child.type === "paragraph") {
                if (runs.length) runs.push({ text: "\n" });
                runs.push(...inline((child as Tokens.Text).tokens ?? [child]));
              } else {
                children.push(...blocks([child]));
              }
            }
            if (item.task) runs.unshift({ text: item.checked ? "☑ " : "☐ " });
            return { runs, children };
          }),
        });
        break;
      }
      case "table": {
        const table = tok as Tokens.Table;
        out.push({
          t: "table",
          header: table.header.map((c) => inline(c.tokens)),
          rows: table.rows.map((r) => r.map((c) => inline(c.tokens))),
        });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

export function parseMarkdown(md: string): Block[] {
  return blocks(marked.lexer(md, { gfm: true }));
}
