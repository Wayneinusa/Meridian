// Ctrl+Alt+Esc (⌃⌥Esc on a Mac), anywhere: stop everything the assistant is
// doing on the computer. Works while Meridian is in the background, because a
// computer-use task usually has another app in front.
import { isTauri, platform } from "./index";

export const KILL_SHORTCUT = "Control+Alt+Escape";

export async function registerKillSwitch(onKill: () => void): Promise<boolean> {
  if (!isTauri || !platform().desktop) return false;
  try {
    const gs = await import("@tauri-apps/plugin-global-shortcut");
    if (await gs.isRegistered(KILL_SHORTCUT)) await gs.unregister(KILL_SHORTCUT);
    await gs.register(KILL_SHORTCUT, (e) => {
      if (e.state === "Pressed") onKill();
    });
    return true;
  } catch {
    // another app owns the shortcut: Stop and Esc still work
    return false;
  }
}
