/** Fill {{arg}} and {{settings.KEY}}; `mode` decides how values are escaped. */
export function fillTemplate(tpl: string, args: Record<string, unknown>, settings: Record<string, string>, mode: "url" | "json" | "text"): string {
  // a quoted placeholder in JSON becomes a proper JSON value ("{{n}}" -> 5, "{{tags}}" -> ["a"])
  if (mode === "json") {
    tpl = tpl.replace(/"\{\{\s*([\w.]+)\s*\}\}"/g, (_m, key: string) => {
      const v = key.startsWith("settings.") ? settings[key.slice(9)] : args[key];
      return v === undefined ? "null" : JSON.stringify(v);
    });
  }
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
    const v = key.startsWith("settings.") ? settings[key.slice(9)] : args[key];
    if (v === undefined || v === null) return "";
    const s = typeof v === "string" ? v : JSON.stringify(v);
    if (mode === "url") return encodeURIComponent(s);
    if (mode === "json") return JSON.stringify(s).slice(1, -1);
    return s;
  });
}
