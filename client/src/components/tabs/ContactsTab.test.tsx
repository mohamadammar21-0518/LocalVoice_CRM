import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContactFormDialog } from "./ContactsTab";
import type { ContactFormValues } from "@/types";

const emptyContact: ContactFormValues = {
  firstName: "",
  lastName: "",
  company: "",
  role: "",
  email: "",
  phone: "",
};

describe("ContactFormDialog — new contact", () => {
  it("renders all form fields", () => {
    render(
      <ContactFormDialog
        value={emptyContact}
        setValue={vi.fn()}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByPlaceholderText("First name")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Last name")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Company")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Role")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Email")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Phone")).toBeInTheDocument();
  });

  it("disables the save button when first or last name is empty", () => {
    render(
      <ContactFormDialog
        value={emptyContact}
        setValue={vi.fn()}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /create contact/i })).toBeDisabled();
  });

  it("enables the save button when first and last name are provided", () => {
    render(
      <ContactFormDialog
        value={{ ...emptyContact, firstName: "Maya", lastName: "Chen" }}
        setValue={vi.fn()}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /create contact/i })).toBeEnabled();
  });

  it("calls setValue when a field is changed", async () => {
    const setValue = vi.fn();
    const user = userEvent.setup();
    render(
      <ContactFormDialog
        value={emptyContact}
        setValue={setValue}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    await user.type(screen.getByPlaceholderText("First name"), "M");
    expect(setValue).toHaveBeenCalledWith({ ...emptyContact, firstName: "M" });
  });

  it("calls onClose when the close button is clicked", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <ContactFormDialog
        value={emptyContact}
        setValue={vi.fn()}
        onClose={onClose}
        onSave={vi.fn()}
      />,
    );

    // The ✕ close button
    await user.click(screen.getByRole("button", { name: "" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onSave when save button is clicked and names are present", async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(
      <ContactFormDialog
        value={{ ...emptyContact, firstName: "Maya", lastName: "Chen" }}
        setValue={vi.fn()}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );

    await user.click(screen.getByRole("button", { name: /create contact/i }));
    expect(onSave).toHaveBeenCalledOnce();
  });

  it("shows pending state when pending prop is true", () => {
    render(
      <ContactFormDialog
        value={{ ...emptyContact, firstName: "Maya", lastName: "Chen" }}
        setValue={vi.fn()}
        onClose={vi.fn()}
        onSave={vi.fn()}
        pending
      />,
    );

    expect(screen.getByRole("button", { name: /create contact/i })).toBeDisabled();
  });
});

describe("ContactFormDialog — edit contact", () => {
  it("shows edit labels when editing prop is true", () => {
    render(
      <ContactFormDialog
        value={{ ...emptyContact, firstName: "Maya", lastName: "Chen" }}
        setValue={vi.fn()}
        onClose={vi.fn()}
        onSave={vi.fn()}
        editing
      />,
    );

    expect(screen.getByText(/edit contact/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save changes/i })).toBeInTheDocument();
  });

  it("pre-populates fields with existing contact values", () => {
    render(
      <ContactFormDialog
        value={{
          firstName: "Maya",
          lastName: "Chen",
          company: "Northstar",
          role: "Director",
          email: "maya@northstar.studio",
          phone: "+1 555 0100",
        }}
        setValue={vi.fn()}
        onClose={vi.fn()}
        onSave={vi.fn()}
        editing
      />,
    );

    expect(screen.getByDisplayValue("Maya")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Chen")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Northstar")).toBeInTheDocument();
    expect(screen.getByDisplayValue("maya@northstar.studio")).toBeInTheDocument();
  });
});
