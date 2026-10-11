import { ArrowUpRight, Clock3, Inbox, Sparkles, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, prettyTime } from "@/components/WorkspaceShared";
import type { DashboardData, TaskWithContact, InteractionWithContact } from "@/types";
import type { Tab } from "@/types";

// ── Metric card ───────────────────────────────────────────────────────────────

interface MetricProps {
  label: string;
  value: number;
  detail: string;
  icon: React.ComponentType<{ className?: string }>;
  tint: "lavender" | "mint" | "blush";
  loading: boolean;
}

function Metric({ label, value, detail, icon: Icon, tint, loading }: MetricProps) {
  return (
    <div className={`metric-card tint-${tint}`}>
      <div className="metric-top">
        <span>{label}</span>
        <Icon className="h-4 w-4" />
      </div>
      <div className="metric-value">{loading ? "…" : value}</div>
      <p>{detail}</p>
    </div>
  );
}

// ── Overview tab ──────────────────────────────────────────────────────────────

interface OverviewTabProps {
  dashboard: DashboardData | undefined;
  tasks: TaskWithContact[] | undefined;
  dashboardLoading: boolean;
  tasksLoading: boolean;
  onTab: (tab: Tab) => void;
  onSelectContact: (id: number) => void;
}

export function OverviewTab({
  dashboard,
  tasks,
  dashboardLoading,
  tasksLoading,
  onTab,
  onSelectContact,
}: OverviewTabProps) {
  return (
    <div className="content-stack">
      {/* Hero ---------------------------------------------------------------- */}
      <section className="hero-panel">
        <div className="hero-copy">
          <div className="hero-kicker">
            <span className="live-dot" /> Your private CRM, in focus
          </div>
          <h2>
            Make room for the
            <br />
            <em>conversations that matter.</em>
          </h2>
          <p>
            One calm place for the people, context, and small promises that move
            your work forward.
          </p>
          <Button className="hero-button" onClick={() => onTab("voice")}>
            Try a voice update <ArrowUpRight className="h-4 w-4" />
          </Button>
        </div>
        <div className="hero-art">
          <div className="orb orb-large" />
          <div className="orb orb-small" />
          <div className="line-art line-one" />
          <div className="line-art line-two" />
          <span className="hero-art-label">L / 01</span>
        </div>
      </section>

      {/* Metrics ------------------------------------------------------------- */}
      <section className="metric-grid">
        <Metric
          label="People in your orbit"
          value={dashboard?.contactCount ?? 0}
          detail="contacts"
          icon={Users}
          tint="lavender"
          loading={dashboardLoading}
        />
        <Metric
          label="Open follow-ups"
          value={dashboard?.openTaskCount ?? 0}
          detail="to keep close"
          icon={Clock3}
          tint="mint"
          loading={dashboardLoading}
        />
        <Metric
          label="Needs attention"
          value={dashboard?.overdueCount ?? 0}
          detail="overdue"
          icon={Inbox}
          tint="blush"
          loading={dashboardLoading}
        />
      </section>

      {/* Cards grid ---------------------------------------------------------- */}
      <div className="overview-grid">
        {/* Recent interactions */}
        <Card className="surface-card">
          <CardHeader className="section-heading">
            <div>
              <p className="eyebrow">Activity thread</p>
              <CardTitle>Recent interactions</CardTitle>
            </div>
            <button className="text-action" onClick={() => onTab("contacts")}>
              View contacts <ArrowUpRight className="h-3.5 w-3.5" />
            </button>
          </CardHeader>
          <CardContent>
            {dashboardLoading ? (
              <div className="loading-state">
                <Sparkles className="h-4 w-4 animate-pulse" />
                Gathering recent activity...
              </div>
            ) : dashboard?.recentInteractions?.length ? (
              <div className="activity-list">
                {dashboard.recentInteractions.map((row: InteractionWithContact) => (
                  <div className="activity-row" key={row.interaction.id}>
                    <div className="activity-icon">
                      <Sparkles className="h-4 w-4" />
                    </div>
                    <div className="activity-copy">
                      <p>
                        <strong>
                          {row.contact?.firstName} {row.contact?.lastName}
                        </strong>{" "}
                        · {row.interaction.kind}
                      </p>
                      <p className="muted-clamp">{row.interaction.body}</p>
                      <span>{prettyTime(row.interaction.occurredAt)}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                title="Your activity will gather here"
                text="Add a note or use a voice update to start the thread."
              />
            )}
          </CardContent>
        </Card>

        {/* Upcoming tasks */}
        <Card className="surface-card">
          <CardHeader className="section-heading">
            <div>
              <p className="eyebrow">Next up</p>
              <CardTitle>Upcoming follow-ups</CardTitle>
            </div>
            <button className="text-action" onClick={() => onTab("tasks")}>
              See all <ArrowUpRight className="h-3.5 w-3.5" />
            </button>
          </CardHeader>
          <CardContent>
            {tasksLoading ? (
              <div className="loading-state">
                <Sparkles className="h-4 w-4 animate-pulse" />
                Gathering upcoming follow-ups...
              </div>
            ) : tasks?.length ? (
              <div className="task-list">
                {tasks.slice(0, 4).map((row: TaskWithContact) => (
                  <button
                    className="task-row"
                    key={row.task.id}
                    onClick={() => onSelectContact(row.task.contactId)}
                  >
                    <div className="task-date">
                      <span>
                        {new Date(row.task.dueAt).toLocaleDateString(undefined, {
                          month: "short",
                        })}
                      </span>
                      <strong>
                        {new Date(row.task.dueAt).toLocaleDateString(undefined, {
                          day: "numeric",
                        })}
                      </strong>
                    </div>
                    <div>
                      <p>{row.task.title}</p>
                      <span>
                        {row.contact?.firstName} {row.contact?.lastName} ·{" "}
                        {row.contact?.company}
                      </span>
                    </div>
                    <ArrowUpRight className="h-4 w-4 ml-auto" />
                  </button>
                ))}
              </div>
            ) : (
              <EmptyState
                title="Nothing urgent"
                text="A little breathing room is good."
              />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
