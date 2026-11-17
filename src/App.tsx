import { useEffect, useState } from "react";
import { init, useApp } from "./state/store";
import { Chat } from "./ui/Chat";
import { PermissionDialog, PreviewDialog, Toasts } from "./ui/Dialogs";
import { SettingsModal } from "./ui/SettingsModal";
import { Sidebar } from "./ui/Sidebar";

let started = false;

export function App() {
  const ready = useApp((s) => s.ready);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const settingsTab = useApp((s) => s.settingsTab);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (started) return;
    started = true;
    init().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) {
    return (
      <div className="empty">
        <div>
          <h1>Meridian could not start</h1>
          <p>{error}</p>
        </div>
      </div>
    );
  }
  if (!ready) return <div className="empty"><div className="spinner" aria-label="Loading" /></div>;

  return (
    <div className="app">
      <Sidebar />
      {sidebarOpen && <button className="backdrop" aria-label="Close sidebar" onClick={() => useApp.setState({ sidebarOpen: false })} />}
      <Chat />
      {settingsTab && <SettingsModal />}
      <PreviewDialog />
      <PermissionDialog />
      <Toasts />
    </div>
  );
}
