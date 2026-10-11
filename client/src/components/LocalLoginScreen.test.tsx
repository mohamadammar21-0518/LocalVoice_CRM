import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LocalLoginScreen } from "./LocalLoginScreen";

// Mock the login helper so we don't hit the network
vi.mock("@/const", () => ({
  startLogin: vi.fn(),
}));

import { startLogin } from "@/const";

const mockStartLogin = vi.mocked(startLogin);

describe("LocalLoginScreen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the login form with all required elements", () => {
    render(<LocalLoginScreen />);

    expect(screen.getByPlaceholderText("Username")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /enter your workspace/i })).toBeInTheDocument();
    expect(screen.getByText(/lumen personal crm/i)).toBeInTheDocument();
  });

  it("disables the submit button when fields are empty", () => {
    render(<LocalLoginScreen />);

    const button = screen.getByRole("button", { name: /enter your workspace/i });
    expect(button).toBeDisabled();
  });

  it("enables the submit button when both fields have values", async () => {
    const user = userEvent.setup();
    render(<LocalLoginScreen />);

    await user.type(screen.getByPlaceholderText("Username"), "admin");
    await user.type(screen.getByPlaceholderText("Password"), "password123");

    expect(screen.getByRole("button", { name: /enter your workspace/i })).toBeEnabled();
  });

  it("shows an error message on failed login", async () => {
    mockStartLogin.mockResolvedValue({ ok: false, error: "Invalid credentials" });
    const user = userEvent.setup();
    render(<LocalLoginScreen />);

    await user.type(screen.getByPlaceholderText("Username"), "wronguser");
    await user.type(screen.getByPlaceholderText("Password"), "wrongpass");
    await user.click(screen.getByRole("button", { name: /enter your workspace/i }));

    await waitFor(() => {
      expect(screen.getByText("Invalid credentials")).toBeInTheDocument();
    });
  });

  it("shows a fallback error when the server is unreachable", async () => {
    mockStartLogin.mockRejectedValue(new Error("Network error"));
    const user = userEvent.setup();
    render(<LocalLoginScreen />);

    await user.type(screen.getByPlaceholderText("Username"), "admin");
    await user.type(screen.getByPlaceholderText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: /enter your workspace/i }));

    await waitFor(() => {
      expect(screen.getByText(/login failed/i)).toBeInTheDocument();
    });
  });

  it("calls startLogin with the correct credentials", async () => {
    mockStartLogin.mockResolvedValue({ ok: false, error: "Invalid credentials" });
    const user = userEvent.setup();
    render(<LocalLoginScreen />);

    await user.type(screen.getByPlaceholderText("Username"), "testuser");
    await user.type(screen.getByPlaceholderText("Password"), "securepass123");
    await user.click(screen.getByRole("button", { name: /enter your workspace/i }));

    await waitFor(() => {
      expect(mockStartLogin).toHaveBeenCalledWith("testuser", "securepass123");
    });
  });

  it("shows loading state while signing in", async () => {
    // Keep the promise pending
    mockStartLogin.mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    render(<LocalLoginScreen />);

    await user.type(screen.getByPlaceholderText("Username"), "admin");
    await user.type(screen.getByPlaceholderText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: /enter your workspace/i }));

    expect(screen.getByText(/signing in/i)).toBeInTheDocument();
    // Button should be disabled while loading
    expect(screen.getByRole("button")).toBeDisabled();
  });
});
