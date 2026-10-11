import { describe, expect, it } from "vitest";

describe("HubSpot credential", () => {
  it.skipIf(process.env.RUN_LIVE_HUBSPOT_TESTS !== "1")("authenticates against the CRM contacts endpoint when configured", async () => {
    const token = process.env.HUBSPOT_ACCESS_TOKEN?.trim();
    if (!token) return;
    const response = await fetch("https://api.hubapi.com/crm/v3/objects/contacts?limit=1", { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
    expect(response.status).toBe(200);
  }, 15000);
});
