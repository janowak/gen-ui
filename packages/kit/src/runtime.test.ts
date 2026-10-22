import { PREVIEW_META_KEY, THEME_META_KEY, VIEW_ID_META_KEY } from "@genui/format";
import { App } from "@modelcontextprotocol/ext-apps";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { createRuntime, defineComponent, themeVariables, z, type StateStorage } from "./index.js";

const rating = defineComponent({
  name: "rating",
  version: "1.0.0",
  description: "Rate something.",
  props: z.object({ question: z.string(), max: z.number().int().min(3).optional() }),
  tools: ["save_rating"],
});

function memoryStorage(): StateStorage {
  const items = new Map<string, string>();
  return { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => void items.set(key, value) };
}

type CallToolResult = Awaited<ReturnType<NonNullable<AppBridge["oncalltool"]>>>;

/** A component runtime connected to a real AppBridge host over an in-memory transport. */
async function host(options: { storage?: StateStorage; tool?: () => CallToolResult } = {}) {
  const app = new App({ name: "test-view", version: "1.0.0" }, {}, { autoResize: false });
  const changes = vi.fn();
  const runtime = createRuntime(app, rating, changes, { storage: options.storage ?? memoryStorage() });

  const bridge = new AppBridge(
    null,
    { name: "test-host", version: "1.0.0" },
    { serverTools: {}, updateModelContext: { text: {} }, message: { text: {} } },
    { hostContext: { theme: "dark" } },
  );
  const calls: { name: string; arguments?: Record<string, unknown> }[] = [];
  const context: string[] = [];
  const messages: string[] = [];
  const text = (content: { type: string; text?: string }[] | undefined) => content?.map((c) => c.text ?? "").join("") ?? "";
  bridge.oncalltool = async (params) => {
    calls.push(params);
    return options.tool?.() ?? { content: [{ type: "text", text: '{"saved":true}' }] };
  };
  bridge.onupdatemodelcontext = async (params) => {
    context.push(text(params.content));
    return {};
  };
  bridge.onmessage = async (params) => {
    messages.push(text(params.content));
    return {};
  };

  const initialized = new Promise<void>((resolve) => (bridge.oninitialized = () => resolve()));
  const [hostTransport, viewTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([bridge.connect(hostTransport), app.connect(viewTransport)]);
  await initialized;
  return { ctx: runtime.context, runtime, bridge, calls, context, messages, changes };
}

const result = (meta: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: "Showing Star rating." }], _meta: meta });

describe("component runtime", () => {
  it("shows partial props while streaming, then validated props", async () => {
    const { ctx, bridge, changes } = await host();
    expect(ctx.status).toBe("waiting");

    await bridge.sendToolInputPartial({ arguments: { question: "How was" } });
    await vi.waitFor(() => expect(ctx.status).toBe("streaming"));
    expect(ctx.partial?.question).toBe("How was");
    expect(ctx.props).toBeUndefined();

    await bridge.sendToolInput({ arguments: { question: "How was it?", max: 5 } });
    await vi.waitFor(() => expect(ctx.status).toBe("ready"));
    expect(ctx.props).toEqual({ question: "How was it?", max: 5 });
    expect(ctx.theme).toBe("dark");
    expect(changes).toHaveBeenCalled();
  });

  it("rejects invalid props and tells the model why", async () => {
    const { ctx, bridge, context } = await host();
    await bridge.sendToolInput({ arguments: { max: 2 } });
    await vi.waitFor(() => expect(ctx.status).toBe("error"));
    expect(ctx.error).toContain("question");
    await vi.waitFor(() => expect(context[0]).toContain("Invalid props for rating"));
    expect(context[0]).toContain("call render_rating again");
  });

  it("waits for the render result, then calls tools", async () => {
    const { ctx, bridge, calls } = await host();
    await bridge.sendToolInput({ arguments: { question: "Q" } });

    const saved = ctx.tools.call("save_rating", { stars: 4 });
    expect(calls).toEqual([]);
    await bridge.sendToolResult(result({}));

    expect(await saved).toEqual({ ok: true, data: { saved: true }, text: '{"saved":true}' });
    expect(calls).toEqual([expect.objectContaining({ name: "save_rating", arguments: { stars: 4 } })]);
    expect(await ctx.tools.available("save_rating")).toBe(true);
  });

  it("calls no tools in registry previews", async () => {
    const { ctx, bridge, calls } = await host();
    await bridge.sendToolInput({ arguments: { question: "Q" } });
    await bridge.sendToolResult(result({ [PREVIEW_META_KEY]: true }));

    expect(await ctx.tools.call("save_rating", { stars: 4 })).toMatchObject({ ok: false, unavailable: true });
    expect(await ctx.tools.available("save_rating")).toBe(false);
    expect(calls).toEqual([]);
  });

  it("turns isError tool results into ok: false", async () => {
    const { ctx, bridge } = await host({ tool: () => ({ isError: true, content: [{ type: "text", text: "Rating service down" }] }) });
    await bridge.sendToolInput({ arguments: { question: "Q" } });
    await bridge.sendToolResult(result({}));
    expect(await ctx.tools.call("save_rating")).toMatchObject({ ok: false, unavailable: false, error: "Rating service down" });
  });

  it("keeps state per view id, so a re-rendered message comes back as left", async () => {
    const storage = memoryStorage();
    const first = await host({ storage });
    await first.bridge.sendToolInput({ arguments: { question: "Q" } });
    first.ctx.state.set({ stars: 4 }); // before the view id arrives: kept, then saved
    await first.bridge.sendToolResult(result({ [VIEW_ID_META_KEY]: "view-1" }));
    await vi.waitFor(() => expect(storage.getItem("genui:rating:view-1")).toBe('{"stars":4}'));

    const replay = await host({ storage });
    await replay.bridge.sendToolInput({ arguments: { question: "Q" } });
    await replay.bridge.sendToolResult(result({ [VIEW_ID_META_KEY]: "view-1" }));
    await vi.waitFor(() => expect(replay.ctx.state.get()).toEqual({ stars: 4 }));

    const other = await host({ storage });
    await other.bridge.sendToolInput({ arguments: { question: "Q" } });
    await other.bridge.sendToolResult(result({ [VIEW_ID_META_KEY]: "view-2" }));
    await vi.waitFor(() => expect(other.changes).toHaveBeenCalledTimes(2));
    expect(other.ctx.state.get()).toBeUndefined();
  });

  it("reads the workspace theme and reports cancellation", async () => {
    const { ctx, runtime, bridge } = await host();
    await bridge.sendToolInput({ arguments: { question: "Q" } });
    await bridge.sendToolResult(result({ [THEME_META_KEY]: { light: { primary: "#16a34a" } } }));
    await vi.waitFor(() => expect(runtime.workspaceTheme()).toEqual({ light: { primary: "#16a34a" } }));

    const cancelled = await host();
    await cancelled.bridge.sendToolCancelled({ reason: "user" });
    await vi.waitFor(() => expect(cancelled.ctx.status).toBe("cancelled"));
    expect(await cancelled.ctx.tools.available("save_rating")).toBe(false);
    expect(ctx.status).toBe("ready");
  });

  it("posts messages and updates model context", async () => {
    const { ctx, context, messages } = await host();
    expect(await ctx.model.send("The user rated 4/5.")).toBe(true);
    expect(await ctx.model.update("Saved.")).toBe(true);
    expect(messages).toEqual(["The user rated 4/5."]);
    expect(context).toEqual(["Saved."]);
  });
});

describe("themeVariables", () => {
  it("maps only the tokens the workspace sets, per color scheme", () => {
    const theme = { radius: "0.5rem", light: { primary: "#111", chart: ["#a", "#b"] }, dark: { primary: "#eee" } };
    expect(themeVariables(theme, "light")).toEqual({
      "--genui-primary": "#111",
      "--genui-radius": "0.5rem",
      "--genui-chart-1": "#a",
      "--genui-chart-2": "#b",
    });
    expect(themeVariables(theme, "dark")).toEqual({ "--genui-primary": "#eee", "--genui-radius": "0.5rem" });
    expect(themeVariables(undefined, "light")).toEqual({});
  });
});
