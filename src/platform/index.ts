// Thin seam between the UI and whatever is hosting it: the Tauri shell
// (Windows, iOS, iPadOS, also macOS/Linux) or a plain browser (dev / PWA).
import { invoke as tauriInvoke } from "@tauri-apps/api/core";

export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>);

export type OS = "windows" | "macos" | "linux" | "ios" | "android" | "web";

export interface PlatformInfo {
  os: OS;
  desktop: boolean;
  mobile: boolean;
  hostname: string;
  dataDir: string;
  documentsDir: string;
  homeDir: string;
  desktopDir: string;
  downloadsDir: string;
  /** Windows/macOS: the iCloud Drive folder if iCloud is set up on this machine */
  icloudDrive?: string;
  /** iOS/macOS: the app's own iCloud container (null when iCloud is off or not entitled) */
  icloudContainer?: string;
  /** screenshots + mouse/keyboard are compiled in */
  canControlScreen: boolean;
  /** bundle identifier of the app */
  identifier: string;
}

let info: PlatformInfo = {
  os: "web",
  desktop: false,
  mobile: false,
  hostname: "browser",
  dataDir: "",
  documentsDir: "",
  homeDir: "",
  desktopDir: "",
  downloadsDir: "",
  canControlScreen: false,
  identifier: "",
};

export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) return Promise.reject(new Error(`${cmd} needs the installed app (not available in a browser)`));
  return tauriInvoke<T>(cmd, args);
}

export async function initPlatform(): Promise<PlatformInfo> {
  if (isTauri) {
    try {
      info = await tauriInvoke<PlatformInfo>("platform_info");
    } catch (e) {
      console.error("platform_info failed", e);
    }
  }
  return info;
}

export function platform(): PlatformInfo {
  return info;
}

/** Join path segments using the separator of the host OS. */
export function joinPath(...parts: string[]): string {
  const sep = info.os === "windows" ? "\\" : "/";
  return parts
    .filter((p) => p !== "")
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, "") : p.replace(/^[\\/]+|[\\/]+$/g, "")))
    .join(sep);
}
