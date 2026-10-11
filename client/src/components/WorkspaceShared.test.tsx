import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Paging, EmptyState, initials, prettyDate, prettyTime } from "./WorkspaceShared";

// ── Paging ────────────────────────────────────────────────────────────────────

describe("Paging", () => {
  it("shows the current page number", () => {
    render(<Paging page={0} setPage={vi.fn()} hasNext={true} />);
    expect(screen.getByText("Page 1")).toBeInTheDocument();
  });

  it("disables the Previous button on the first page", () => {
    render(<Paging page={0} setPage={vi.fn()} hasNext={true} />);
    expect(screen.getByRole("button", { name: /previous/i })).toBeDisabled();
  });

  it("enables the Previous button on subsequent pages", () => {
    render(<Paging page={2} setPage={vi.fn()} hasNext={false} />);
    expect(screen.getByRole("button", { name: /previous/i })).toBeEnabled();
  });

  it("disables the Next button when hasNext is false", () => {
    render(<Paging page={0} setPage={vi.fn()} hasNext={false} />);
    expect(screen.getByRole("button", { name: /next/i })).toBeDisabled();
  });

  it("enables the Next button when hasNext is true", () => {
    render(<Paging page={0} setPage={vi.fn()} hasNext={true} />);
    expect(screen.getByRole("button", { name: /next/i })).toBeEnabled();
  });

  it("calls setPage with page - 1 when Previous is clicked", async () => {
    const setPage = vi.fn();
    const user = userEvent.setup();
    render(<Paging page={3} setPage={setPage} hasNext={true} />);

    await user.click(screen.getByRole("button", { name: /previous/i }));
    expect(setPage).toHaveBeenCalledWith(2);
  });

  it("calls setPage with page + 1 when Next is clicked", async () => {
    const setPage = vi.fn();
    const user = userEvent.setup();
    render(<Paging page={1} setPage={setPage} hasNext={true} />);

    await user.click(screen.getByRole("button", { name: /next/i }));
    expect(setPage).toHaveBeenCalledWith(2);
  });

  it("does not allow navigating to a negative page", async () => {
    const setPage = vi.fn();
    render(<Paging page={0} setPage={setPage} hasNext={false} />);

    // Both buttons disabled — clicking should not fire
    expect(screen.getByRole("button", { name: /previous/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /next/i })).toBeDisabled();
    expect(setPage).not.toHaveBeenCalled();
  });
});

// ── EmptyState ────────────────────────────────────────────────────────────────

describe("EmptyState", () => {
  it("renders title and text", () => {
    render(<EmptyState title="Nothing here" text="Add something to get started." />);

    expect(screen.getByText("Nothing here")).toBeInTheDocument();
    expect(screen.getByText("Add something to get started.")).toBeInTheDocument();
  });
});

// ── Helper functions ──────────────────────────────────────────────────────────

describe("initials", () => {
  it("returns uppercase initials from first and last name", () => {
    expect(initials("maya", "chen")).toBe("MC");
  });

  it("handles empty strings gracefully", () => {
    expect(initials("", "")).toBe("");
    expect(initials("maya", "")).toBe("M");
    expect(initials("", "chen")).toBe("C");
  });

  it("handles undefined gracefully", () => {
    expect(initials(undefined, undefined)).toBe("");
  });
});

describe("prettyDate", () => {
  it("returns — for null/undefined", () => {
    expect(prettyDate(null)).toBe("—");
    expect(prettyDate(undefined)).toBe("—");
  });

  it("returns a formatted date string for a valid date", () => {
    const result = prettyDate(new Date("2026-06-15T12:00:00Z"));
    // Should contain month abbreviation and day
    expect(result).toMatch(/Jun|15/);
  });
});

describe("prettyTime", () => {
  it("returns — for null/undefined", () => {
    expect(prettyTime(null)).toBe("—");
    expect(prettyTime(undefined)).toBe("—");
  });

  it("returns a formatted time string for a valid date", () => {
    const result = prettyTime(new Date("2026-06-15T14:30:00Z"));
    expect(result).toBeTruthy();
    expect(result).not.toBe("—");
  });
});
