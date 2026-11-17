// Desktop: keep running in the tray when the window is closed, so automations
// fire on time. The Rust side owns the tray icon; this tells it the setting.
import { useApp } from "../state/store";
import { invoke, isTauri, platform } from "./index";

export function startBackground() {
  if (!isTauri || !platform().desktop) return;
  let last: boolean | null = null;
  const apply = (on: boolean) => {
    if (on === last) return;
    last = on;
    void invoke("set_background", { enabled: on }).catch(() => undefined);
  };
  apply(useApp.getState().settings.runInBackground);
  useApp.subscribe((s) => apply(s.settings.runInBackground));
}
