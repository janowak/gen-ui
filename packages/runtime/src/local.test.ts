import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_BUNDLE_BYTES } from "@genui/format";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localCatalog, parseWorkflowFile, readComponentDir, readWorkflowDir } from "./local.js";
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
  const workflow = (description: string, params = "") => `---\ndescription: ${description}\n${params}---\nSteps for ${description}\n`;
  const withParam = "params:\n  - name: email\n    description: Email\n";

  it("serves components, workflows next to them, theme and instructions from files", async () => {
    await component("rating", "rating", "1.0.0");
    await write("rating/workflows/signup.workflow.md", workflow("Sign up.", withParam));
    await write("rating/feedback.workflow.md", workflow("After an order."));
    await write("rating/notes.md", "ignored");
    await write("flows/contact.workflow.md", workflow("Contact us.", withParam));
    await write("theme.json", { light: { primary: "#4f46e5" } });
    await write("instructions.md", "Help with orders.\n");
    const catalog = await localCatalog({
      dirs: [join(dir, "rating"), join(dir, "flows")],
      theme: join(dir, "theme.json"),
      instructions: join(dir, "instructions.md"),
    });

    const snapshot = (await catalog.snapshot("prod"))!;
    expect(snapshot.catalog.components.map((c) => `${c.name}@${c.version}`)).toEqual(["rating@1.0.0"]);
    expect(snapshot.bundles[snapshot.catalog.components[0]!.hash]).toBe("<p>rating 1.0.0</p>");
    expect(snapshot.catalog.theme).toEqual({ light: { primary: "#4f46e5" } });
    expect(snapshot.catalog.workflows.map((w) => w.name)).toEqual(["contact", "feedback", "signup"]);
    expect(snapshot.catalog.instructions).toBe("Help with orders.");
    expect(catalog.instructions()).toMatch(
      /^Help with orders\.\n\n## Workflows[\s\S]*### feedback\nWhen: After an order\.\nSteps for After an order\.$/,
    );
    expect(catalog.problems()).toEqual([]);
  });

  it("skips what doesn't load, reports it, and tries again on reload", async () => {
    await component("rating", "rating", "1.0.0");
    await write("theme.json", "{ broken");
    const catalog = await localCatalog({ dirs: [join(dir, "rating"), join(dir, "poll")], theme: join(dir, "theme.json") });
    expect(catalog.components().map((c) => c.manifest.name)).toEqual(["rating"]);
    expect(catalog.problems().map((p) => p.message)).toEqual([
      expect.stringContaining("no genui.component.json"),
      expect.stringContaining("invalid JSON"),
    ]);

    await component("poll", "poll", "0.1.0");
    const reload = await catalog.reload();
    expect(reload.changed).toBe(true);
    expect(reload.lines).toEqual(["poll@0.1.0 added (" + contentHash("<p>poll 0.1.0</p>") + ")"]);
    expect(catalog.components().map((c) => c.manifest.name)).toEqual(["rating", "poll"]);
    expect(catalog.problems()).toHaveLength(1);
  });

  it("serves a component and a workflow name once", async () => {
    await component("a", "rating", "1.0.0");
    await component("b", "rating", "2.0.0");
    await write("a/signup.workflow.md", workflow("Sign up."));
    await write("b/signup.workflow.md", workflow("Sign up again."));
    const catalog = await localCatalog({ dirs: [join(dir, "a"), join(dir, "b")] });
    expect(catalog.components().map((c) => c.manifest.version)).toEqual(["1.0.0"]);
    expect((await catalog.snapshot("prod"))!.catalog.workflows.map((w) => w.description)).toEqual(["Sign up."]);
    expect(catalog.problems().map((p) => p.message)).toEqual([
      expect.stringContaining('"signup" is defined twice'),
      expect.stringContaining('"rating" is already served'),
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

describe("workflow files", () => {
  const file = (front: string, body: string) => `---\n${front}\n---\n${body}\n`;

  it("reads frontmatter and takes the body as instructions; the name defaults to the file name", () => {
    const workflow = parseWorkflowFile(
      file(
        "title: New order\ndescription: Create an order.\nparams:\n  - name: customer\n    description: Customer name\n    required: true",
        "1. Look up.\n2. Show the form.",
      ),
      "/repo/create_order.workflow.md",
    );
    expect(workflow).toEqual({
      name: "create_order",
      title: "New order",
      description: "Create an order.",
      instructions: "1. Look up.\n2. Show the form.",
      params: [{ name: "customer", description: "Customer name", required: true }],
    });
  });

  it("explains what is wrong", () => {
    expect(() => parseWorkflowFile("no frontmatter", "/repo/x.workflow.md")).toThrow(/frontmatter/);
    expect(() => parseWorkflowFile(file("title: x", "Steps."), "/repo/x_y.workflow.md")).toThrow(/description/);
  });

  it("finds workflows next to a component and in its workflows/, and rejects duplicate names", async () => {
    const dir = await mkdtemp(join(tmpdir(), "genui-workflows-"));
    await mkdir(join(dir, "workflows"));
    await writeFile(join(dir, "feedback.workflow.md"), file("description: After an order.", "Ask for a rating."));
    await writeFile(join(dir, "workflows", "create_order.workflow.md"), file("description: Create an order.", "Show the form."));
    await writeFile(join(dir, "README.md"), "not a workflow");
    expect((await readWorkflowDir(dir)).map((f) => f.workflow.name)).toEqual(["create_order", "feedback"]);

    await writeFile(join(dir, "workflows", "other.workflow.md"), file("name: feedback\ndescription: Again.", "Steps."));
    await expect(readWorkflowDir(dir)).rejects.toThrow(/two workflows are named feedback/);
    await rm(dir, { recursive: true, force: true });
  });
});
