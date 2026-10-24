import { readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { genui } from "../vite.js";

const root = resolve(import.meta.dirname, "../../test/fixture");
let server: ViteDevServer;
let base: string;

beforeAll(async () => {
  server = await createServer({ root, configFile: false, logLevel: "silent", plugins: [genui()], server: { port: 0 } });
  await server.listen();
  base = `http://localhost:${(server.httpServer!.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

describe("genui dev server", () => {
  it("serves the host page at / and the component at /?genui-view", async () => {
    const host = await (await fetch(`${base}/`)).text();
    expect(host).toContain('<script type="module" src="/__genui/harness.js">');
    expect(host).toContain('data-view-url="/?genui-view"');

    const view = await (await fetch(`${base}/?genui-view`)).text();
    expect(view).toContain('<p id="out">');
    expect(view).toContain("/@vite/client"); // served through Vite, so modules transform on the fly
    expect(view).toContain("window.openai = {"); // the saved-state shim, run before the view's modules

    const harness = await fetch(`${base}/__genui/harness.js`);
    expect(harness.status).toBe(200);
    expect(harness.headers.get("content-type")).toContain("javascript");
  });

  it("serves the manifest fresh from the component definition", async () => {
    const res = await fetch(`${base}/__genui/component.json`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "fixture_badge", version: "2.1.0", tools: ["lookup"], contract: 1 });
  });

  it("pushes file changes to the host page instead of letting Vite reload the view", async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/__genui/events`, { signal: controller.signal });
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    expect((await reader.read()).value).toContain(": connected");

    const file = resolve(root, "src/main.ts");
    const source = await readFile(file, "utf8");
    await writeFile(file, source); // same content: only the change event matters

    let received = "";
    while (!received.includes("\n\n")) received += (await reader.read()).value;
    expect(received).toBe(`event: reload\ndata: {"file":"src/main.ts"}\n\n`);
    controller.abort();
  });
});
