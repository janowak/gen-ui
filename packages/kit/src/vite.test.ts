import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";
import { afterAll, describe, expect, it } from "vitest";
import { defineComponent, toManifest, z } from "./index.js";
import { genui } from "./vite.js";

describe("toManifest", () => {
  it("publishes props as JSON Schema with the contract version", () => {
    const manifest = toManifest(
      defineComponent({
        name: "pay_range",
        version: "1.0.0",
        description: "Show a pay band.",
        props: z.object({ min: z.number().describe("Band minimum."), max: z.number(), currency: z.string().default("EUR") }),
      }),
    );
    expect(manifest).toMatchObject({ name: "pay_range", version: "1.0.0", tools: [], contract: 1 });
    expect(manifest.props).toMatchObject({
      type: "object",
      properties: { min: { type: "number", description: "Band minimum." }, currency: { type: "string", default: "EUR" } },
      required: ["min", "max"],
    });
    expect(manifest.props).not.toHaveProperty("$schema");
  });

  it("rejects names that cannot become render_<name>", () => {
    const bad = defineComponent({ name: "Pay-Range", version: "1.0.0", description: "x", props: z.object({}) });
    expect(() => toManifest(bad)).toThrow(/name: lowercase letters/);
  });
});

describe("genui() Vite plugin", () => {
  const root = resolve(import.meta.dirname, "../test/fixture");
  let outDir: string;
  afterAll(() => rm(outDir, { recursive: true, force: true }));

  it("builds one self-contained HTML file plus the generated manifest", async () => {
    outDir = await mkdtemp(join(tmpdir(), "genui-kit-"));
    await build({ root, configFile: false, logLevel: "silent", plugins: [genui()], build: { outDir, emptyOutDir: true } });

    expect((await readdir(outDir)).sort()).toEqual(["genui.component.json", "index.html"]);
    const html = await readFile(join(outDir, "index.html"), "utf8");
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).toContain("fixture_badge");

    const manifest = JSON.parse(await readFile(join(outDir, "genui.component.json"), "utf8"));
    expect(manifest).toMatchObject({ name: "fixture_badge", version: "2.1.0", title: "Badge", tools: ["lookup"], contract: 1, bundle: "index.html" });
    expect(manifest.props.required).toEqual(["label"]);
  }, 60_000);
});
