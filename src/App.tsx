import { useEffect, useState } from "react";
import { startAutomations } from "./automations/runner";
import { startBackground } from "./platform/background";
import { init, useApp } from "./state/store";
import { Chat } from "./ui/Chat";
import { PermissionDialog, PreviewDialog, QuestionDialog, Toasts } from "./ui/Dialogs";
import { AgentsPage } from "./ui/pages/Agents";
import { AutomationsPage } from "./ui/pages/Automations";
import { SearchPage, UsagePage } from "./ui/pages/Misc";
import { ProjectPage, ProjectsPage } from "./ui/pages/Projects";
import { PromptsPage } from "./ui/pages/Prompts";
import { Icon } from "./ui/icons";
import { Shortcuts } from "./ui/Shortcuts";
import { SettingsModal } from "./ui/SettingsModal";
import { Sidebar } from "./ui/Sidebar";

let started = false;
startAutomations();

export function App() {
  const ready = useApp((s) => s.ready);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const settingsTab = useApp((s) => s.settingsTab);
  const view = useApp((s) => s.view);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (started) return;
    started = true;
    init()
      .then(() => startBackground())
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
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
      {view.name === "chat" ? (
        <Chat />
      ) : (
        <main className="main">
          {!sidebarOpen && (
            <button className="icon-btn floating-menu" title="Show sidebar" onClick={() => useApp.setState({ sidebarOpen: true })}>
              <Icon.menu />
            </button>
          )}
          {view.name === "agents" && <AgentsPage />}
          {view.name === "projects" && <ProjectsPage />}
          {view.name === "project" && <ProjectPage id={view.id} />}
          {view.name === "prompts" && <PromptsPage />}
          {view.name === "automations" && <AutomationsPage />}
          {view.name === "search" && <SearchPage />}
          {view.name === "usage" && <UsagePage />}
        </main>
      )}
      {settingsTab && <SettingsModal />}
      <PreviewDialog />
      <PermissionDialog />
      <QuestionDialog />
      <Shortcuts />
      <Toasts />
    </div>
  );
}
