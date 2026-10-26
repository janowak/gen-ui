import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_BUNDLE_BYTES } from "@genui/format";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localCatalog, readComponentDir } from "./local.js";
import { contentHash } from "./views.js";

const manifest = { name: "rating", version: "1.2.0", description: "Ask the user to rate something.", props: { type: "object" } };
const html = "<!doctype html><p>rating</p>";

describe("readComponentDir", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "genui-component-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const write = async (path: string, content: string) => {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), content);
  };

  it("reads the manifest @genui/kit/vite generates into dist/, with its bundle next to it", async () => {
    await write("dist/genui.component.json", JSON.stringify({ ...manifest, bundle: "index.html" }));
    await write("dist/index.html", html);
    const component = await readComponentDir(dir);
    expect(component.manifest).toMatchObject({ name: "rating", version: "1.2.0", tools: [] });
    expect(component.html).toBe(html);
    expect(component.hash).toBe(contentHash(html));
    expect(component.bundlePath).toBe(join(dir, "dist/index.html"));
  });

  it("prefers a hand-written manifest next to the sources, with the bundle in dist/index.html by default", async () => {
    await write("genui.component.json", JSON.stringify({ ...manifest, version: "2.0.0" }));
    await write("dist/genui.component.json", JSON.stringify(manifest));
    await write("dist/index.html", html);
    const component = await readComponentDir(dir);
    expect(component.manifest.version).toBe("2.0.0");
    expect(component.manifestPath).toBe(join(dir, "genui.component.json"));
  });

  it("says what is missing or wrong", async () => {
    await expect(readComponentDir(dir)).rejects.toThrow("no genui.component.json");
    await write("genui.component.json", "{ nope");
    await expect(readComponentDir(dir)).rejects.toThrow("invalid JSON");
    await write("genui.component.json", JSON.stringify({ ...manifest, name: "form" }));
    await expect(readComponentDir(dir)).rejects.toThrow(/invalid manifest[\s\S]*name: reserved/);
    await write("genui.component.json", JSON.stringify(manifest));
    await expect(readComponentDir(dir)).rejects.toThrow("bundle not found");
    await write("dist/index.html", "x".repeat(MAX_BUNDLE_BYTES + 1));
    await expect(readComponentDir(dir)).rejects.toThrow("the registry accepts up to");
  });
});

describe("localCatalog", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "genui-local-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const write = async (path: string, content: unknown) => {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), typeof content === "string" ? content : JSON.stringify(content));
  };
  const component = async (path: string, name: string, version: string, body = `<p>${name} ${version}</p>`) => {
    await write(`${path}/dist/genui.component.json`, { ...manifest, name, version, bundle: "index.html" });
    await write(`${path}/dist/index.html`, body);
  };
  const recipe = (name: string) => ({ name, when: `The user wants ${name}.`, form: { title: name, fields: [{ name: "email", label: "Email", type: "email" }] } });

  it("serves components, theme, recipes and guide from files", async () => {
    await component("rating", "rating", "1.0.0");
    await write("theme.json", { light: { primary: "#4f46e5" } });
    await write("recipes/a.json", recipe("signup"));
    await write("recipes/b.json", recipe("contact"));
    await write("recipes/notes.txt", "ignored");
    await write("guide.json", { instructions: "Help with orders.", prompts: [{ name: "returns", description: "Return an order.", prompt: "Use signup." }] });
    const catalog = await localCatalog({ dirs: [join(dir, "rating")], theme: join(dir, "theme.json"), recipes: join(dir, "recipes"), guide: join(dir, "guide.json") });

    const snapshot = (await catalog.snapshot("prod"))!;
    expect(snapshot.catalog.components.map((c) => `${c.name}@${c.version}`)).toEqual(["rating@1.0.0"]);
    expect(snapshot.bundles[snapshot.catalog.components[0]!.hash]).toBe("<p>rating 1.0.0</p>");
    expect(snapshot.catalog.theme).toEqual({ light: { primary: "#4f46e5" } });
    expect(snapshot.catalog.recipes.map((r) => r.name)).toEqual(["signup", "contact"]);
    expect(snapshot.catalog.prompts.map((p) => p.name)).toEqual(["returns"]);
    expect(catalog.instructions()).toBe("Help with orders.");
    expect(catalog.problems()).toEqual([]);
  });

  it("skips what doesn't load, reports it, and tries again on reload", async () => {
    await component("rating", "rating", "1.0.0");
    await write("theme.json", "{ broken");
    const catalog = await localCatalog({ dirs: [join(dir, "rating"), join(dir, "poll")], theme: join(dir, "theme.json") });
    expect(catalog.components().map((c) => c.manifest.name)).toEqual(["rating"]);
    expect(catalog.problems().map((p) => p.message)).toEqual([expect.stringContaining("no genui.component.json"), expect.stringContaining("invalid JSON")]);

    await component("poll", "poll", "0.1.0");
    const reload = await catalog.reload();
    expect(reload.changed).toBe(true);
    expect(reload.lines).toEqual(["poll@0.1.0 added (" + contentHash("<p>poll 0.1.0</p>") + ")"]);
    expect(catalog.components().map((c) => c.manifest.name)).toEqual(["rating", "poll"]);
    expect(catalog.problems()).toHaveLength(1);
  });

  it("serves a component name once, and skips duplicate recipes and prompts with a recipe's name", async () => {
    await component("a", "rating", "1.0.0");
    await component("b", "rating", "2.0.0");
    await write("recipes/a.json", recipe("signup"));
    await write("recipes/b.json", recipe("signup"));
    await write("guide.json", { prompts: [{ name: "signup", description: "Clash.", prompt: "x" }] });
    const catalog = await localCatalog({ dirs: [join(dir, "a"), join(dir, "b")], recipes: join(dir, "recipes"), guide: join(dir, "guide.json") });
    expect(catalog.components().map((c) => c.manifest.version)).toEqual(["1.0.0"]);
    const snapshot = (await catalog.snapshot("prod"))!;
    expect(snapshot.catalog.recipes).toHaveLength(1);
    expect(snapshot.catalog.prompts).toEqual([]);
    expect(catalog.problems().map((p) => p.message)).toEqual([
      expect.stringContaining('"rating" is already served'),
      expect.stringContaining('"signup" is defined twice'),
      expect.stringContaining("has a recipe's name"),
    ]);
  });

  it("moves the revision only when what's served changes, and keeps old bundles by hash", async () => {
    await component("rating", "rating", "1.0.0");
    const catalog = await localCatalog({ dirs: [join(dir, "rating")] });
    const first = catalog.components()[0]!.hash;
    expect(catalog.revision()).toBe(1);

    expect(await catalog.reload()).toEqual({ changed: false, lines: [] });
    expect(catalog.revision()).toBe(1);

    await component("rating", "rating", "1.0.1");
    const reload = await catalog.reload();
    expect(reload.changed).toBe(true);
    expect(reload.lines[0]).toMatch(/^rating@1\.0\.1 reloaded/);
    expect(catalog.revision()).toBe(2);
    expect(await catalog.bundle(first)).toBe("<p>rating 1.0.0</p>");
    expect(await catalog.bundle(catalog.components()[0]!.hash)).toBe("<p>rating 1.0.1</p>");
  });
});
