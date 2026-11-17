// Getting files out of the app: save, open with the system, pick a folder.
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { bytesToBase64, extOf, safeFileName } from "../util/bytes";
import { invoke, isTauri, joinPath, platform } from "./index";

function browserDownload(bytes: Uint8Array, name: string, mime: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function uniquePath(dir: string, name: string): Promise<string> {
  const ext = extOf(name);
  const stem = ext ? name.slice(0, -(ext.length + 1)) : name;
  for (let i = 0; i < 500; i++) {
    const candidate = joinPath(dir, i === 0 ? name : `${stem} (${i})${ext ? "." + ext : ""}`);
    if (!(await invoke<boolean>("fs_exists", { path: candidate }))) return candidate;
  }
  return joinPath(dir, `${Date.now()}-${name}`);
}

/** Returns a sentence describing where the file went, or null if the user cancelled. */
export async function saveFile(bytes: Uint8Array, name: string, mime: string): Promise<string | null> {
  const safe = safeFileName(name);
  if (!isTauri) {
    browserDownload(bytes, safe, mime);
    return `Downloaded ${safe}`;
  }
  const p = platform();
  if (p.mobile) {
    // The app's Documents folder is visible in the Files app (On My iPhone / iPad › Meridian).
    const dest = await uniquePath(p.documentsDir, safe);
    await invoke("fs_write_b64", { path: dest, data: bytesToBase64(bytes) });
    return `Saved to Files › On My ${/ipad/i.test(navigator.userAgent) ? "iPad" : "iPhone"} › Meridian`;
  }
  const ext = extOf(safe);
  const dest = await saveDialog({
    defaultPath: joinPath(p.downloadsDir || p.documentsDir, safe),
    filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : undefined,
  });
  if (!dest) return null;
  await invoke("fs_write_b64", { path: dest, data: bytesToBase64(bytes) });
  return `Saved to ${dest}`;
}

/** Open with the default app (desktop). Returns false when the platform cannot do that. */
export async function openWithSystem(bytes: Uint8Array, name: string): Promise<boolean> {
  if (!isTauri || !platform().desktop) return false;
  const dest = joinPath(platform().dataDir, "opened", safeFileName(name));
  await invoke("fs_write_b64", { path: dest, data: bytesToBase64(bytes) });
  await invoke("open_target", { target: dest });
  return true;
}

export async function openExternal(url: string): Promise<void> {
  if (isTauri) await invoke("open_target", { target: url });
  else window.open(url, "_blank", "noopener,noreferrer");
}

export async function pickFolder(): Promise<string | null> {
  if (!isTauri) return null;
  const r = await openDialog({ directory: true, multiple: false });
  return typeof r === "string" ? r : null;
}
