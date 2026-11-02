import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createStudioMcp } from "./mcp";
import { crmTemplates } from "../../shared/crm";
import type { TrpcContext } from "../_core/context";
vi.mock("./store", () => ({
  studioStore: {
    read: vi.fn(async () => ({
      workspace: {
        blueprint: crmTemplates[0].blueprint,
        provider: "local",
        mappings: {},
        proposals: [],
      },
      role: "owner",
    })),
  },
}));
describe("MCP interoperability", () => {
  it("negotiates with the official client, serves schema, and never exposes execution", async () => {
    const server = createStudioMcp(
      { user: { id: 1 } } as TrpcContext,
      "test-workspace",
      true
    );
    const client = new Client({ name: "test", version: "1.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map(t => t.name)).toContain("crm_create_action_draft");
      expect(
        tools.tools
          .map(t => t.name)
          .some(name => /execute|confirm|delete/.test(name))
      ).toBe(false);
      const result = await client.callTool({
        name: "crm_describe_schema",
        arguments: {},
      });
      expect(result.isError).not.toBe(true);
      const resources = await client.listResources();
      expect(resources.resources).toHaveLength(1);
      const schema = await client.readResource({
        uri: resources.resources[0].uri,
      });
      expect(schema.contents[0].text).toContain("Sales CRM");
    } finally {
      await client.close();
      await server.close();
    }
  });
  it("does not advertise drafting for read-only tokens", async () => {
    const server = createStudioMcp(
      { user: { id: 1 } } as TrpcContext,
      "test",
      false
    );
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      expect((await client.listTools()).tools.map(t => t.name)).not.toContain(
        "crm_create_action_draft"
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});
