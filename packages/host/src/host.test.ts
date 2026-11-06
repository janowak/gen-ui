import { stripUiResources } from "./request.js";
import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { fakeText } from "@tanstack/ai/testing";
import { createEmbeddedSession, localMcpTransport } from "./server.js";
import { sandboxResponse } from "./sandbox.js";

describe("embedded host", () => {
  it("keeps widget HTML and private metadata out of follow-up requests", () => {
    const body = stripUiResources(
      JSON.stringify({
        threadId: "a",
        messages: [
          {
            role: "assistant",
            content: "An editor",
            _meta: {
              tanstack: { uiResources: [{ resource: { text: "large HTML" }, meta: { result: { _meta: { secret: "private" } } } }] },
            },
          },
        ],
      }),
    );
    expect(body).not.toContain("large HTML");
    expect(body).not.toContain("private");
    expect(body).toContain("An editor");
  });
  it("reuses MCP tools and preserves private widget results without exposing app-only tools to the model", async () => {
    const server = new McpServer({ name: "test", version: "1" });
    let writes = 0;
    server.registerTool("render_editor", { inputSchema: z.object({}), _meta: { ui: { resourceUri: "ui://editor" } } }, async () => ({
      content: [{ type: "text", text: "Editor" }],
      _meta: { viewId: "private-view" },
    }));
    server.registerResource("editor", "ui://editor", {}, async () => ({
      contents: [
        {
          uri: "ui://editor",
          mimeType: "text/html;profile=mcp-app",
          text: "<p>Editor</p>",
          _meta: { ui: { csp: { resourceDomains: ["https://example.com"] } } },
        },
      ],
    }));
    server.registerTool("save", { inputSchema: z.object({}), _meta: { ui: { visibility: ["app"] } } }, async () => {
      writes++;
      return { content: [{ type: "text", text: "saved" }] };
    });
    const session = await createEmbeddedSession({
      transport: await localMcpTransport(server),
      modelTools: ["render_editor", "save"],
      appTools: ["save"],
    });
    const adapter = fakeText();
    adapter.appendResponses([
      (call) => {
        expect(call.request.tools?.map((t) => t.name)).toEqual(["render_editor"]);
        return { toolCalls: [{ name: "render_editor", input: {} }] };
      },
    ]);
    adapter.appendResponses([
      (call) => {
        expect(JSON.stringify(call.request)).not.toContain("private-view");
        return { text: "Ready" };
      },
    ]);
    const chunks = [];
    try {
      for await (const chunk of session.stream({ adapter, threadId: "test", messages: [{ role: "user", content: "Show editor" }] }))
        chunks.push(chunk);
      const widget = chunks.find((c) => c.type === "CUSTOM" && c.name === "ui-resource");
      expect(widget && "value" in widget ? widget.value : null).toMatchObject({
        meta: {
          result: { _meta: { viewId: "private-view" } },
          resourceMeta: { ui: { csp: { resourceDomains: ["https://example.com"] } } },
        },
      });
      const direct = await session.render("render_editor", {});
      expect(direct.meta?.result).toMatchObject({ _meta: { viewId: "private-view" } });
      expect(direct.resource.text).toBe("<p>Editor</p>");
      await session.callTool("save", {});
      expect(writes).toBe(1);
      await expect(session.callTool("render_editor", {})).rejects.toThrow("not allowed");
    } finally {
      await session.close();
      await server.close();
    }
  });
  it("reserves a tool-free answer when the research turn budget is reached", async () => {
    const server = new McpServer({ name: "research", version: "1" });
    let calls = 0;
    server.registerTool("lookup", { inputSchema: z.object({}) }, async () => {
      calls++;
      return { content: [{ type: "text", text: "A sourced fact" }] };
    });
    const session = await createEmbeddedSession({ transport: await localMcpTransport(server), modelTools: ["lookup"], appTools: [] });
    const adapter = fakeText();
    adapter.setResponses([
      { toolCalls: [{ name: "lookup", input: {} }] },
      (call) => {
        expect(call.request.tools ?? []).toHaveLength(0);
        return { text: "Here is the sourced proposal" };
      },
    ]);
    const chunks = [];
    try {
      for await (const chunk of session.stream({
        adapter,
        threadId: "bounded",
        messages: [{ role: "user", content: "Research a proposal" }],
        maxTurns: 2,
      }))
        chunks.push(chunk);
      expect(calls).toBe(1);
      expect(chunks.some((chunk) => chunk.type === "TEXT_MESSAGE_CONTENT")).toBe(true);
      expect(adapter.state.callCount).toBe(2);
    } finally {
      await session.close();
      await server.close();
    }
  });

  it("allows published stylesheets only from declared resource origins", () => {
    const url = new URL("https://widgets.example/sandbox");
    url.searchParams.set("csp", JSON.stringify({ resourceDomains: ["https://assets.app-mcp.com"] }));
    const response = sandboxResponse(new Request(url), ["https://app.example"]);
    const policy = response.headers.get("content-security-policy")!;
    expect(policy).toContain("style-src 'unsafe-inline' https://assets.app-mcp.com;");
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("frame-ancestors https://app.example");
    const withoutResources = sandboxResponse(new Request("https://widgets.example/sandbox"), ["https://app.example"]);
    expect(withoutResources.headers.get("content-security-policy")).not.toContain("https://assets.app-mcp.com");
  });

  it("sets restrictive sandbox CSP and rejects injected origins", () => {
    const response = sandboxResponse(new Request("https://widgets.example/sandbox"), ["https://app.example"]);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors https://app.example");
    expect(response.headers.get("content-security-policy")).toContain("connect-src 'none'");
    const url = new URL("https://widgets.example/sandbox");
    url.searchParams.set("csp", JSON.stringify({ resourceDomains: ["https://example.com; script-src *"] }));
    expect(sandboxResponse(new Request(url), ["https://app.example"]).status).toBe(400);
  });
});
