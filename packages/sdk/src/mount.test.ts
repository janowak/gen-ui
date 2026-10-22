import { THEME_META_KEY } from "@genui/format";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { beforeAll, describe, expect, it } from "vitest";
import { ALLOWED_TOOLS_META_KEY, mountGenUI } from "./index.js";

async function connect() {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  await mountGenUI(server, {
    allowTools: { sources: ["search_customers", "get_revenue"], submit: ["create_order"] },
    theme: { light: { primary: "#4f46e5" } },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const form = {
  title: "New order",
  fields: [
    { name: "customer", label: "Customer", type: "resource_select", source: { toolName: "search_customers", searchParam: "query", labelPath: "name" } },
    { name: "notes", label: "Notes", type: "textarea" },
  ],
  submit: { toolName: "create_order" },
};

describe("mountGenUI", () => {
  let client: Client;
  beforeAll(async () => {
    client = await connect();
  });

  it("registers render tools linked to content-hashed ui:// resources", async () => {
    const { tools } = await client.listTools();
    const formTool = tools.find((t) => t.name === "render_form");
    const chartTool = tools.find((t) => t.name === "render_chart");
    const uri = (formTool?._meta as { ui?: { resourceUri?: string } })?.ui?.resourceUri;
    expect(uri).toMatch(/^ui:\/\/genui\/form\/[0-9a-f]{16}$/);
    expect(chartTool).toBeDefined();
    expect(formTool?.description).toContain("Allowed submit tools: create_order");

    const resource = await client.readResource({ uri: uri! });
    const content = resource.contents[0] as { mimeType?: string; text?: string };
    expect(content.mimeType).toBe("text/html;profile=mcp-app");
    expect(content.text).toContain("<html");
  });

  it("accepts allowlisted tools and returns theme + allowed tools in _meta", async () => {
    const result = await client.callTool({ name: "render_form", arguments: form });
    expect(result.isError).toBeFalsy();
    expect(result._meta?.[ALLOWED_TOOLS_META_KEY]).toEqual(["search_customers", "create_order"]);
    expect(result._meta?.[THEME_META_KEY]).toEqual({ light: { primary: "#4f46e5" } });
  });

  it("rejects tools that are not allowlisted", async () => {
    const result = await client.callTool({
      name: "render_form",
      arguments: { ...form, submit: { toolName: "delete_account" } },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Submit tool \\"delete_account\\" is not allowed');

    const chart = await client.callTool({
      name: "render_chart",
      arguments: { type: "bar", data: { source: { toolName: "export_users" } }, x: "m", series: [{ path: "v" }] },
    });
    expect(chart.isError).toBe(true);
  });

  it("renders inline charts without tool access", async () => {
    const result = await client.callTool({
      name: "render_chart",
      arguments: { type: "pie", data: { categories: ["A", "B"], series: [{ name: "n", values: [1, 2] }] } },
    });
    expect(result.isError).toBeFalsy();
    expect(result._meta?.[ALLOWED_TOOLS_META_KEY]).toEqual([]);
  });
});
