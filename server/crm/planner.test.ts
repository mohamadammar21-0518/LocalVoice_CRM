import { expect, it } from "vitest";
import { bindStudioSelection } from "../../shared/training";

it("binds updates and deletes to the caller's exact selection", () => {
  for (const operation of ["update", "delete"])
    expect(bindStudioSelection({ operation, values: {} }, "selected-id")).toEqual({ operation, values: {}, recordId: "selected-id" });
});
it("never substitutes conflicting model IDs or invents a missing selection", () => {
  const conflicting = { operation: "update", recordId: "wrong-id" };
  expect(bindStudioSelection(conflicting, "selected-id")).toBe(conflicting);
  const missing = { operation: "delete" };
  expect(bindStudioSelection(missing)).toBe(missing);
  const create = { operation: "create", values: {} };
  expect(bindStudioSelection(create, "selected-id")).toBe(create);
  expect(bindStudioSelection(null, "selected-id")).toBeNull();
});
