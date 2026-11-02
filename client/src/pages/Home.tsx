/**
 * Home — workspace shell and navigation.
 *
 * This component owns only the outer chrome: sidebar, header, tab selection,
 * and the error banner. Each tab's queries, mutations, and UI live in their
 * own component under src/components/tabs/.
 */
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Redirect } from "wouter";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  ChevronRight,
  Clock3,
  Command,
  Mic,
  Plus,
  Settings,
  Sparkles,
  Target,
  Users,
  X,
  Zap,
} from "lucide-react";

import { WorkspaceLoading } from "@/components/WorkspaceShared";
import { OverviewTab } from "@/components/tabs/OverviewTab";
import { ContactsTab } from "@/components/tabs/ContactsTab";
import { TasksTab } from "@/components/tabs/TasksTab";
import { AdminTab } from "@/components/tabs/AdminTab";
import type { Tab, TaskWithContact, DashboardData } from "@/types";

// Heavy tabs are code-split so they don't bloat the initial bundle.
const VoiceWorkspace = lazy(() => import("@/components/VoiceWorkspace"));
const SalesforceWorkspace = lazy(() => import("@/components/SalesforceWorkspace"));
const HubSpotWorkspace = lazy(() => import("@/components/HubSpotWorkspace"));
const HubSpotPanel = lazy(() => import("@/components/HubSpotPanel"));
const CrmStudio = lazy(() => import("@/components/CrmStudio"));

// ── Navigation definition ─────────────────────────────────────────────────────

const NAV_ITEMS: { id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "overview", label: "Overview", icon: Target },
  { id: "studio", label: "Templates & Studio", icon: Sparkles },
  { id: "contacts", label: "Contacts", icon: Users },
  { id: "tasks", label: "Follow-ups", icon: Clock3 },
  { id: "voice", label: "Voice", icon: Mic },
  { id: "salesforce", label: "Salesforce", icon: Users },
  { id: "hubspot", label: "HubSpot", icon: Users },
];

const TAB_IDS: Tab[] = ["overview", "studio", "contacts", "tasks", "voice", "salesforce", "hubspot", "admin"];

function tabFromLocation(): Tab {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("tab");
  if (requested && TAB_IDS.includes(requested as Tab)) return requested as Tab;
  // Keep the Salesforce OAuth return URL backwards compatible.
  return params.has("salesforce") ? "salesforce" : "overview";
}

// ── Home ──────────────────────────────────────────────────────────────────────

export default function Home() {
  const { user, loading, logout } = useAuth();

  // Initialise to the Salesforce tab when the URL carries ?salesforce
  const [tab, setTab] = useState<Tab>(tabFromLocation);

  const navigateTo = useCallback((next: Tab) => {
    if (next === tab) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("salesforce");
    if (next === "overview") url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    window.history.pushState({ tab: next }, "", `${url.pathname}${url.search}${url.hash}`);
    setTab(next);
  }, [tab]);

  useEffect(() => {
    const onPopState = () => setTab(tabFromLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Ctrl/Cmd+K shortcut → Voice tab
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (user && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        navigateTo("voice");
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [user, navigateTo]);

  // Queries needed at the shell level (dashboard counts for the nav badge,
  // HubSpot status for the sidebar pill, overview data)
  const dashboard = trpc.dashboard.get.useQuery(undefined, {
    enabled: Boolean(user),
    retry: false,
  });
  const hubspotStatus = trpc.integrations.hubspotStatus.useQuery(undefined, {
    enabled: Boolean(user),
    retry: false,
  });
  // Overview tasks (open only, first page)
  const overviewTasks = trpc.tasks.list.useQuery(
    { filter: "open", limit: 50, offset: 0 },
    { enabled: Boolean(user) && tab === "overview", retry: false },
  );

  // ── Loading / auth gates ───────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <div className="brand-mark">
            <Sparkles className="h-4 w-4" />
          </div>
          <p className="eyebrow">LocalVoice CRM</p>
          <h1>Preparing your workspace.</h1>
          <p>Gathering your private contacts and follow-ups.</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Redirect to="/login" replace />;
  }

  // Build nav with admin entry when applicable
  const nav = [
    ...NAV_ITEMS,
    ...(user.role === "admin"
      ? [{ id: "admin" as Tab, label: "Users", icon: Settings }]
      : []),
  ];

  const overdueCount = dashboard.data?.overdueCount ?? 0;
  const hubspotConnected = Boolean(hubspotStatus.data?.configured);
  const initials = (user.name || "Your workspace")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0])
    .join("")
    .toUpperCase();

  // ── Header subtitle per tab ───────────────────────────────────────────────

  const headerSubtitle = (() => {
    if (tab === "overview") return "A gentle overview of what deserves your attention.";
    if (tab === "voice") return "Speak naturally. Review every action. Stay in control.";
    if (tab === "studio") return "Build from a template, customize your fields, and connect your CRM.";
    if (tab === "salesforce") return "Connect your account and manage Salesforce records in one place.";
    if (tab === "contacts") return "Find your contacts and keep their details up to date.";
    if (tab === "tasks") return "Keep track of the next step in every relationship.";
    return "Your relationships, held with intention.";
  })();

  return (
    <div className="workspace-shell">
      {/* Sidebar */}
      <aside className="workspace-sidebar">
        <div className="brand-lockup">
          <div className="brand-mark">
            <Sparkles className="h-4 w-4" />
          </div>
          <div>
            <p className="brand-name">LocalVoice</p>
            <p className="brand-caption">Command centre</p>
          </div>
        </div>
        <div className="sidebar-rule" />
        <p className="eyebrow sidebar-eyebrow">Your workspace</p>
        <nav className="workspace-nav" aria-label="Primary navigation">
          {nav.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${tab === item.id ? "active" : ""}`}
              aria-current={tab === item.id ? "page" : undefined}
              onClick={() => navigateTo(item.id)}
            >
              <item.icon className="h-4 w-4" />
              <span>{item.label}</span>
              {item.id === "tasks" && overdueCount > 0 ? (
                <span className="nav-count">{overdueCount}</span>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <div className="bracket bracket-top" />
          <p className="eyebrow">Workspace builder</p>
          <p>Start from a template, speak an update, then review every change before it is saved.</p>
          <button className="text-action" onClick={() => navigateTo("studio")}>Browse CRM templates →</button>
          <div className="integration-pill">
            <span className={`integration-dot ${hubspotConnected ? "connected" : "local"}`} />
            {hubspotConnected ? "HubSpot connected" : "Local CRM mode"}
          </div>
          <div className="bracket bracket-bottom" />
        </div>
        <div className="sidebar-footer">
          <div className="avatar avatar-soft">{initials || "ME"}</div>
          <div>
            <p className="profile-name">{user.name || "Your workspace"}</p>
            <button
              type="button"
              className="text-action"
              onClick={() => void logout().then(() => window.location.replace("/login")).catch(() => toast.error("Sign out failed. Please try again."))}
            >
              Sign out
            </button>
          </div>
          <ChevronRight className="h-4 w-4 ml-auto text-muted-foreground" />
        </div>
        <button
          type="button"
          className="mobile-signout"
          onClick={() => void logout().then(() => window.location.replace("/login")).catch(() => toast.error("Sign out failed. Please try again."))}
        >
          Sign out
        </button>
      </aside>

      {/* Main content */}
      <main className="workspace-main">
        <header className="workspace-header">
          <div>
            <p className="eyebrow header-kicker">
              <span className="header-kicker-dot" />
              {new Date().toLocaleDateString(undefined, {
                weekday: "long",
                month: "long",
                day: "numeric",
                year: "numeric",
              })}
            </p>
            <h1>
              {tab === "overview"
                ? "Your workspace, at a glance."
                : nav.find((item) => item.id === tab)?.label}
            </h1>
            <p className="header-subtitle">{headerSubtitle}</p>
            <p className="mode-note">
              {hubspotConnected
                ? "HubSpot available · sync records explicitly"
                : "Private local workspace · HubSpot ready when you are"}
            </p>
          </div>
          <div className="header-actions">
            <button className="command-hint" onClick={() => navigateTo("voice")}>
              <Zap className="h-3.5 w-3.5" />
              Voice command <kbd>Ctrl / ⌘ K</kbd>
            </button>
            <Button
              className="primary-button"
              onClick={() => {
                // Navigate to contacts tab and open the new contact dialog
                navigateTo("contacts");
              }}
            >
              <Plus className="h-4 w-4" />
              Open contacts
            </Button>
          </div>
        </header>

        {/* Global error banner */}
        {(dashboard.error || hubspotStatus.error) && (
          <div className="query-alert">
            <X className="h-4 w-4" />
            <span>
              Some workspace data could not be loaded. Refresh the page and try again.
            </span>
          </div>
        )}

        {/* Tab content */}
        {tab === "overview" && <section className="workspace-launchpad" aria-label="Workspace shortcuts">
          <button onClick={() => navigateTo("studio")}><span className="launch-icon launch-template"><Sparkles size={19} /></span><span><small>01 · Build</small><strong>Design your CRM</strong><em>Templates, fields and integrations</em></span><ChevronRight size={18} /></button>
          <button onClick={() => navigateTo("voice")}><span className="launch-icon launch-voice"><Mic size={19} /></span><span><small>02 · Command</small><strong>Work by voice</strong><em>Speak, review and confirm changes</em></span><ChevronRight size={18} /></button>
          <button onClick={() => navigateTo("salesforce")}><span className="launch-icon launch-connect"><Users size={19} /></span><span><small>03 · Connect</small><strong>Open Salesforce</strong><em>Search records and complete tasks</em></span><ChevronRight size={18} /></button>
        </section>}
        {tab === "overview" && (
          <OverviewTab
            dashboard={dashboard.data as DashboardData | undefined}
            tasks={(overviewTasks.data as TaskWithContact[]) ?? undefined}
            dashboardLoading={dashboard.isLoading}
            tasksLoading={overviewTasks.isLoading}
            onTab={navigateTo}
            onSelectContact={(id) => {
              // Switch to contacts tab — ContactsTab manages its own selected state
              // so we store the desired contact id in sessionStorage for it to pick up
              sessionStorage.setItem("openContactId", String(id));
              navigateTo("contacts");
            }}
          />
        )}

        {tab === "contacts" && (
          <>
            <ContactsTab hubspotConnected={hubspotConnected} />
            {hubspotConnected && (
              <Suspense fallback={<WorkspaceLoading />}>
                <HubSpotPanel />
              </Suspense>
            )}
          </>
        )}

        {tab === "tasks" && <TasksTab hubspotConnected={hubspotConnected} />}

        {tab === "voice" && (
          <Suspense fallback={<WorkspaceLoading />}>
            <VoiceWorkspace />
          </Suspense>
        )}

        {tab === "salesforce" && (
          <Suspense fallback={<WorkspaceLoading />}>
            <SalesforceWorkspace />
          </Suspense>
        )}

        {tab === "hubspot" && <Suspense fallback={<WorkspaceLoading />}><HubSpotWorkspace /></Suspense>}

        {tab === "studio" && <Suspense fallback={<WorkspaceLoading />}><CrmStudio /></Suspense>}
        {tab === "admin" && <AdminTab />}
      </main>
    </div>
  );
}
