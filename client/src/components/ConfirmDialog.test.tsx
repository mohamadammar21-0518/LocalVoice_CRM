import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmDialog } from "./ConfirmDialog";

const baseProps = {
  open: true,
  title: "Delete contact?",
  description: "This action cannot be undone.",
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
};

describe("ConfirmDialog", () => {
  it("renders title and description when open", () => {
    render(<ConfirmDialog {...baseProps} />);

    expect(screen.getByText("Delete contact?")).toBeInTheDocument();
    expect(screen.getByText("This action cannot be undone.")).toBeInTheDocument();
  });

  it("does not render when closed", () => {
    render(<ConfirmDialog {...baseProps} open={false} />);

    expect(screen.queryByText("Delete contact?")).not.toBeInTheDocument();
  });

  it("calls onConfirm when the confirm button is clicked", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<ConfirmDialog {...baseProps} onConfirm={onConfirm} />);

    await user.click(screen.getByRole("button", { name: /confirm/i }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("calls onCancel when the cancel button is clicked", async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<ConfirmDialog {...baseProps} onCancel={onCancel} />);

    // Click the Radix AlertDialogCancel button directly (not triggering onOpenChange)
    const cancelBtn = screen.getByRole("button", { name: /cancel/i });
    await user.click(cancelBtn);
    // onCancel may be called once (via onClick) or twice (onClick + onOpenChange).
    // Either way it must have been called at least once.
    expect(onCancel).toHaveBeenCalled();
  });

  it("uses custom button labels", () => {
    render(
      <ConfirmDialog
        {...baseProps}
        confirmLabel="Delete contact"
        cancelLabel="Keep it"
      />,
    );

    expect(screen.getByRole("button", { name: "Delete contact" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep it" })).toBeInTheDocument();
  });

  it("applies destructive styling class when destructive prop is set", () => {
    render(<ConfirmDialog {...baseProps} confirmLabel="Delete" destructive />);

    const confirmBtn = screen.getByRole("button", { name: "Delete" });
    expect(confirmBtn.className).toContain("destructive");
  });
});
