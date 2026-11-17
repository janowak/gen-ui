import { describe, expect, it } from "vitest";
import wrapped, { WrappedData } from "./component";
import { toManifest } from "@app-mcp/kit";
import { sample } from "./sample";
import { decodeShare, encodeShare, hostLabel, shareUrl } from "./share";
import { slidesFor } from "./slides";

describe("props", () => {
  it("accepts the sample", () => {
    expect(WrappedData.parse(sample)).toEqual(sample);
  });

  it("rejects a Wrapped without topics or with a phrase said once", () => {
    expect(WrappedData.safeParse({ ...sample, topics: [] }).success).toBe(false);
    expect(WrappedData.safeParse({ ...sample, phrase: { text: "hi", count: 1 } }).success).toBe(false);
  });

  it("publishes as render_wrapped with a JSON Schema the model can fill", () => {
    const manifest = toManifest(wrapped);
    expect(manifest.name).toBe("wrapped");
    expect(manifest.tools).toEqual([]);
    expect((manifest.props as { required: string[] }).required).toEqual(
      expect.arrayContaining(["year", "topics", "phrase", "themes", "personality", "summary"]),
    );
  });
});

describe("slides", () => {
  it("has seven cards with headline numbers and six without", () => {
    expect(slidesFor(sample)).toEqual(["intro", "stats", "topics", "themes", "phrase", "personality", "summary"]);
    expect(slidesFor({ ...sample, stats: undefined })).not.toContain("stats");
    expect(slidesFor({ ...sample, stats: {} })).toHaveLength(6);
  });
});

describe("share links", () => {
  const payload = { v: 1, host: "Claude", data: sample };

  it("round-trip the cards through the fragment", async () => {
    const hash = await encodeShare(payload);
    expect(hash).toMatch(/^#d=[A-Za-z0-9_-]+$/);
    expect(await decodeShare(hash)).toEqual(payload);
  });

  it("put the data in the fragment of the share page, short enough to paste", async () => {
    const url = new URL(await shareUrl("https://app-mcp.com/wrapped/", payload));
    expect(url.origin + url.pathname).toBe("https://app-mcp.com/wrapped/");
    expect(url.search).toBe("");
    expect(url.href.length).toBeLessThan(1500);
    expect(await decodeShare(url.hash)).toEqual(payload);
  });

  it("decode to undefined when the link is missing data or damaged", async () => {
    expect(await decodeShare("")).toBeUndefined();
    expect(await decodeShare("#other")).toBeUndefined();
    expect(await decodeShare("#d=not-deflate")).toBeUndefined();
    const hash = await encodeShare(payload);
    expect(await decodeShare(hash.slice(0, hash.length / 2))).toBeUndefined();
  });

  it("name the chat the cards were made in", () => {
    expect(hostLabel("Claude Desktop")).toBe("Claude");
    expect(hostLabel("chatgpt-web")).toBe("ChatGPT");
    expect(hostLabel(undefined)).toBe("Claude");
  });
});
