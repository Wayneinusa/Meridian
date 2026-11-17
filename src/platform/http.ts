import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { isTauri } from "./index";

/**
 * fetch() that goes through the native HTTP client inside the app (no CORS,
 * works against localhost model servers) and through the browser otherwise.
 */
export const httpFetch: typeof fetch = (input, init) => {
  if (isTauri) return tauriFetch(input as RequestInfo, init as RequestInit);
  return globalThis.fetch(input, init);
};

export async function readError(res: Response): Promise<string> {
  let body = "";
  try {
    body = await res.text();
  } catch {
    /* ignore */
  }
  try {
    const j = JSON.parse(body);
    const msg = j?.error?.message ?? j?.error ?? j?.message;
    if (typeof msg === "string") return `${res.status}: ${msg}`;
  } catch {
    /* not json */
  }
  return `${res.status} ${res.statusText}${body ? `: ${body.slice(0, 400)}` : ""}`;
}
