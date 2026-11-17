// System notifications: finished replies while the app is in the background,
// and automation results.
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { isTauri } from "./index";

let granted: boolean | null = null;

export async function ensureNotifyPermission(): Promise<boolean> {
  if (granted !== null) return granted;
  try {
    if (isTauri) {
      granted = (await isPermissionGranted()) || (await requestPermission()) === "granted";
    } else if (typeof Notification !== "undefined") {
      granted = Notification.permission === "granted" || (await Notification.requestPermission()) === "granted";
    } else granted = false;
  } catch {
    granted = false;
  }
  return granted ?? false;
}

export async function notify(title: string, body: string): Promise<void> {
  if (!(await ensureNotifyPermission())) return;
  try {
    if (isTauri) sendNotification({ title, body: body.slice(0, 240) });
    else new Notification(title, { body: body.slice(0, 240) });
  } catch {
    /* notifications are best effort */
  }
}
