/**
 * Small, reusable presentational components shared across workspace tabs.
 * Keeping them here avoids re-declaring them inside each tab file.
 */
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";

// ── Loading placeholder ───────────────────────────────────────────────────────

export function WorkspaceLoading() {
  return (
    <div className="loading-state" role="status" aria-live="polite">
      <Sparkles className="h-4 w-4 animate-pulse" />
      Loading this workspace…
    </div>
  );
}

// ── Empty-state card ──────────────────────────────────────────────────────────

interface EmptyStateProps {
  title: string;
  text: string;
}

export function EmptyState({ title, text }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Sparkles className="h-4 w-4" />
      </div>
      <p className="empty-title">{title}</p>
      <p>{text}</p>
    </div>
  );
}

// ── Pagination strip ──────────────────────────────────────────────────────────

interface PagingProps {
  page: number;
  setPage: (value: number) => void;
  /**
   * Pass `data.length === PAGE_SIZE` here.
   * A full page means a next page likely exists; an under-full page means
   * we've reached the last page. This avoids an extra COUNT(*) query.
   */
  hasNext: boolean;
}

export function Paging({ page, setPage, hasNext }: PagingProps) {
  return (
    <div className="flex gap-3 items-center py-3">
      <Button variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>
        Previous
      </Button>
      <span>Page {page + 1}</span>
      <Button variant="outline" disabled={!hasNext} onClick={() => setPage(page + 1)}>
        Next
      </Button>
    </div>
  );
}

// ── Date formatters (shared across tabs) ─────────────────────────────────────

export const prettyDate = (value: string | Date | null | undefined) =>
  value
    ? new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : "—";

export const prettyTime = (value: string | Date | null | undefined) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "—";

export const initials = (first = "", last = "") =>
  `${first[0] ?? ""}${last[0] ?? ""}`.toUpperCase();
