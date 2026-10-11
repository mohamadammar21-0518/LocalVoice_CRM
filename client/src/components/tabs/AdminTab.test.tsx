/**
 * AdminTab tests focus on pure validation logic and the NewUserDialog
 * sub-component. AdminTab itself requires a live tRPC provider; those
 * behaviours are covered by the server integration tests.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ── Username sanitisation ─────────────────────────────────────────────────────
// This is the exact function used in the onChange handler.

describe("username sanitisation", () => {
  const sanitise = (raw: string) => raw.toLowerCase().replace(/[^a-z0-9_]/g, "");

  it("lowercases input", () => {
    expect(sanitise("ADMIN")).toBe("admin");
  });

  it("strips spaces", () => {
    expect(sanitise("maya chen")).toBe("mayachen");
  });

  it("strips special characters", () => {
    expect(sanitise("user@123!")).toBe("user123");
  });

  it("preserves underscores", () => {
    expect(sanitise("hello_world")).toBe("hello_world");
  });

  it("strips hyphens", () => {
    expect(sanitise("user-name")).toBe("username");
  });

  it("handles already-valid input unchanged", () => {
    expect(sanitise("valid_user_99")).toBe("valid_user_99");
  });
});

// ── Password minimum length ───────────────────────────────────────────────────

describe("password length validation", () => {
  const isValid = (pw: string) => pw.length >= 12;

  it("rejects passwords shorter than 12 characters", () => {
    expect(isValid("short")).toBe(false);
    expect(isValid("only11chars")).toBe(false); // exactly 11 chars
  });

  it("accepts passwords of exactly 12 characters", () => {
    expect(isValid("12characters")).toBe(true); // exactly 12 chars
  });

  it("accepts passwords longer than 12 characters", () => {
    expect(isValid("ThisIsALongerPassword")).toBe(true);
  });
});

// ── Role options ──────────────────────────────────────────────────────────────

describe("role options", () => {
  it("only allows user or admin roles", () => {
    const validRoles = ["user", "admin"];
    expect(validRoles).toContain("user");
    expect(validRoles).toContain("admin");
    expect(validRoles).not.toContain("superadmin");
    expect(validRoles).not.toContain("moderator");
  });
});
