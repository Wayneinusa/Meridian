// Knowledge files for projects and agents. Small collections are given to the
// model in full; larger ones are searched with BM25 over overlapping chunks,
// either by the model (search_knowledge tool) or automatically for models
// that cannot call tools.
import type { KnowledgeFile } from "../types";

export const FULL_CONTEXT_CHARS = 60_000;
const CHUNK = 1_200;
const OVERLAP = 200;

export interface Chunk {
  file: string;
  index: number;
  text: string;
}

export function chunkText(file: string, text: string): Chunk[] {
  const out: Chunk[] = [];
  const clean = text.replace(/\r\n/g, "\n");
  let start = 0;
  let index = 0;
  while (start < clean.length) {
    let end = Math.min(clean.length, start + CHUNK);
    if (end < clean.length) {
      // prefer to break at a paragraph or sentence
      const window = clean.slice(start + CHUNK * 0.6, end);
      const br = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf(". "), window.lastIndexOf("\n"));
      if (br > 0) end = start + Math.floor(CHUNK * 0.6) + br + 1;
    }
    out.push({ file, index: index++, text: clean.slice(start, end).trim() });
    if (end >= clean.length) break;
    start = Math.max(end - OVERLAP, start + 1);
  }
  return out.filter((c) => c.text);
}

const STOP = new Set("a an and are as at be by for from has have i in is it its of on or that the this to was were will with you your we our they their not but can do does".split(" "));

export function tokenize(s: string): string[] {
  return (s.toLowerCase().normalize("NFKD").match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 1 && !STOP.has(t)).map((t) => (t.length > 4 ? t.replace(/(ing|ed|es|s)$/, "") : t));
}

export class Bm25 {
  private docs: { chunk: Chunk; tf: Map<string, number>; len: number }[] = [];
  private df = new Map<string, number>();
  private avg = 0;

  constructor(chunks: Chunk[]) {
    let total = 0;
    for (const chunk of chunks) {
      const tf = new Map<string, number>();
      const toks = tokenize(chunk.text);
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.docs.push({ chunk, tf, len: toks.length });
      total += toks.length;
    }
    this.avg = this.docs.length ? total / this.docs.length : 0;
  }

  search(query: string, k = 6): { chunk: Chunk; score: number }[] {
    const q = [...new Set(tokenize(query))];
    const N = this.docs.length;
    const k1 = 1.4;
    const b = 0.75;
    const scored = this.docs.map((d) => {
      let score = 0;
      for (const t of q) {
        const f = d.tf.get(t);
        if (!f) continue;
        const n = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        score += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * d.len) / (this.avg || 1)));
      }
      return { chunk: d.chunk, score };
    });
    return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
  }
}

export interface LoadedKnowledge {
  files: { name: string; text: string }[];
  totalChars: number;
}

export async function loadKnowledge(files: KnowledgeFile[], loadText: (blobId: string) => Promise<string | null>): Promise<LoadedKnowledge> {
  const out: { name: string; text: string }[] = [];
  let total = 0;
  for (const f of files) {
    if (!f.textBlobId) continue;
    const text = await loadText(f.textBlobId);
    if (!text) continue;
    out.push({ name: f.name, text });
    total += text.length;
  }
  return { files: out, totalChars: total };
}

const indexCache = new Map<string, Bm25>();

export function indexFor(k: LoadedKnowledge): Bm25 {
  const key = k.files.map((f) => `${f.name}:${f.text.length}`).join("|");
  let idx = indexCache.get(key);
  if (!idx) {
    idx = new Bm25(k.files.flatMap((f) => chunkText(f.name, f.text)));
    indexCache.set(key, idx);
    if (indexCache.size > 20) indexCache.delete(indexCache.keys().next().value as string);
  }
  return idx;
}

export function formatHits(hits: { chunk: Chunk; score: number }[]): string {
  if (!hits.length) return "No matching passages.";
  return hits.map((h) => `<passage file="${h.chunk.file}" part="${h.chunk.index + 1}">\n${h.chunk.text}\n</passage>`).join("\n\n");
}
