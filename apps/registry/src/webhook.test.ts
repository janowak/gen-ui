import { describe, expect, it } from "vitest";
import { signature, validateWithWebhook, webhookUrlError } from "./webhook.js";

const recipe = {
  name: "quote",
  when: "The user wants a quote.",
  form: { fields: [{ name: "email", label: "Email", type: "email" as const }] },
  validate: { url: "https://hooks.acme.test/validate" },
};

/** A fetch that answers with `status` and `body`, and records what was sent. */
function fakeFetch(status: number, body: unknown) {
  const sent: { url: string; init: RequestInit }[] = [];
  const doFetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { doFetch, sent };
}

const call = (doFetch: typeof fetch) => validateWithWebhook({ recipe, values: { email: "a@b.co" }, workspaceId: "ws-1", secret: "whsec_test", fetch: doFetch });

describe("webhook URLs", () => {
  it("allows public https only", () => {
    expect(webhookUrlError("https://hooks.acme.com/validate")).toBeUndefined();
    expect(webhookUrlError("http://hooks.acme.com/validate")).toMatch(/https/);
    for (const url of ["https://localhost/x", "https://127.0.0.1/x", "https://10.0.0.5/x", "https://169.254.169.254/latest", "https://192.168.1.1/x", "https://[::1]/x", "https://[::ffff:127.0.0.1]/x"]) {
      expect(webhookUrlError(url), url).toMatch(/public/);
    }
  });

  it("allows http and private addresses when the registry permits them", () => {
    expect(webhookUrlError("http://127.0.0.1:9000/x", true)).toBeUndefined();
    expect(webhookUrlError("ftp://127.0.0.1/x", true)).toMatch(/http/);
  });
});

describe("validateWithWebhook", () => {
  it("posts signed values and returns the webhook's answer", async () => {
    const { doFetch, sent } = fakeFetch(200, { ok: true, message: "Looks good." });
    expect(await call(doFetch)).toEqual({ ok: true, message: "Looks good." });

    const { url, init } = sent[0]!;
    expect(url).toBe("https://hooks.acme.test/validate");
    expect(init.redirect).toBe("manual");
    expect(JSON.parse(String(init.body))).toEqual({ type: "recipe.validate", workspace: "ws-1", recipe: "quote", values: { email: "a@b.co" } });
    const header = (init.headers as Record<string, string>)["x-genui-signature"]!;
    const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header)!;
    expect(v1).toBe(signature("whsec_test", Number(t), String(init.body)));
  });

  it("passes field errors through, also on a 4xx", async () => {
    const { doFetch } = fakeFetch(422, { ok: false, fieldErrors: { email: "Already a customer." } });
    expect(await call(doFetch)).toEqual({ ok: false, fieldErrors: { email: "Already a customer." } });
  });

  it("asks the user to try again when the webhook fails or answers something else", async () => {
    const tryAgain = { ok: false, formError: expect.stringContaining("try again") };
    expect(await call(fakeFetch(500, "oops").doFetch)).toEqual(tryAgain);
    expect(await call(fakeFetch(500, { ok: true }).doFetch)).toEqual(tryAgain);
    expect(await call(fakeFetch(302, "").doFetch)).toEqual(tryAgain);
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await call(down)).toEqual(tryAgain);
  });

  it("never calls a URL the policy rejects", async () => {
    const { doFetch, sent } = fakeFetch(200, { ok: true });
    const result = await validateWithWebhook({ recipe: { ...recipe, validate: { url: "https://127.0.0.1/x" } }, values: {}, workspaceId: "ws-1", secret: "s", fetch: doFetch });
    expect(result.ok).toBe(false);
    expect(sent).toEqual([]);
  });
});
