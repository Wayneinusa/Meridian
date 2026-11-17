export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const utf8 = {
  encode: (s: string) => new TextEncoder().encode(s),
  decode: (b: Uint8Array) => new TextDecoder().decode(b),
};

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const MIME_BY_EXT: Record<string, string> = {
  txt: "text/plain", md: "text/markdown", csv: "text/csv", tsv: "text/tab-separated-values",
  json: "application/json", html: "text/html", htm: "text/html", xml: "application/xml",
  svg: "image/svg+xml", css: "text/css", js: "text/javascript", ts: "text/typescript",
  py: "text/x-python", yaml: "text/yaml", yml: "text/yaml", sql: "application/sql",
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", zip: "application/zip",
};

export function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  return m ? m[1].toLowerCase() : "";
}

export function mimeFromName(name: string, fallback = "application/octet-stream"): string {
  return MIME_BY_EXT[extOf(name)] ?? fallback;
}

/** Keep a model-supplied file name from escaping a directory or tripping the OS. */
export function safeFileName(name: string, fallbackExt = ""): string {
  let n = (name || "").split(/[\\/]/).pop() ?? "";
  n = n.replace(/[<>:"|?*\u0000-\u001f]/g, "_").replace(/^\.+/, "").trim();
  if (!n) n = "file";
  if (fallbackExt && !extOf(n)) n += "." + fallbackExt;
  return n.slice(0, 120);
}

export function isTextLike(mime: string, name: string): boolean {
  if (mime.startsWith("text/")) return true;
  if (/(json|xml|yaml|javascript|typescript|sql|x-sh|toml)/.test(mime)) return true;
  return /^(txt|md|markdown|csv|tsv|json|jsonl|html?|xml|svg|css|scss|jsx?|tsx?|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|ps1|bat|ya?ml|toml|ini|cfg|conf|log|sql|tex|r|lua|dart|vue)$/.test(
    extOf(name),
  );
}
