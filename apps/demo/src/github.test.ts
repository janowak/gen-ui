import { describe, expect, it } from "vitest";
import { createGithubClient, GithubError } from "./github.js";

const NOW = Date.parse("2026-11-17T12:00:00Z");

function repo(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    fork: false,
    description: "a thing",
    language: "TypeScript",
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    pushed_at: "2026-11-01T00:00:00Z",
    created_at: "2020-01-01T00:00:00Z",
    archived: false,
    homepage: null,
    default_branch: "main",
    ...extra,
  };
}

const USER = {
  login: "octocat",
  name: "The Octocat",
  avatar_url: "https://avatars.githubusercontent.com/u/583231?v=4",
  html_url: "https://github.com/octocat",
  bio: null,
  company: null,
  blog: "",
  public_repos: 4,
  public_gists: 8,
  followers: 100,
  following: 9,
  created_at: "2011-01-25T18:44:36Z",
};

const ROUTES: Record<string, unknown> = {
  "/users/octocat": USER,
  "/users/octocat/repos?per_page=100&sort=pushed": [
    repo("hello-world", { stargazers_count: 10, description: null }),
    repo("spoon-knife", { stargazers_count: 5, language: "HTML" }),
    repo("react-tutorial", { fork: true }),
    repo("old", { pushed_at: "2019-01-01T00:00:00Z", stargazers_count: 0 }),
  ],
  "/users/octocat/events/public?per_page=100": [
    {
      type: "PushEvent",
      created_at: "2026-11-14T03:10:00Z",
      repo: { name: "octocat/hello-world" },
      payload: { commits: [{ message: "fix" }] },
    },
    {
      type: "PushEvent",
      created_at: "2026-11-12T15:00:00Z",
      repo: { name: "octocat/hello-world" },
      payload: { commits: [{ message: "Add parser\n\nlong" }] },
    },
    { type: "WatchEvent", created_at: "2026-11-12T15:00:00Z", repo: { name: "x/y" } },
  ],
  "/repos/octocat/hello-world/readme": { name: "README.md" },
};

function fakeGithub(routes: Record<string, unknown> = ROUTES) {
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const path = String(input).replace("https://api.github.com", "");
    calls.push(path);
    if (!(path in routes)) return new Response("{}", { status: 404 });
    return Response.json(routes[path]);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("roastStats", () => {
  it("turns public GitHub data into roastable numbers", async () => {
    const { fetch } = fakeGithub();
    const stats = await createGithubClient({ fetch, now: () => NOW }).roastStats("@octocat");
    expect(stats.profile).toMatchObject({ username: "octocat", account_age_years: 15 });
    expect(stats.summary).toEqual({ repos: 4, stars: 15, followers: 100, top_language: "TypeScript", since: 2011 });
    expect(stats.repos).toMatchObject({
      own: 3,
      forks: 1,
      tutorial_like_forks: ["react-tutorial"],
      without_description: 1,
      zero_stars: 1,
      untouched_2y: 1,
      readme_checked: 3,
      without_readme: ["spoon-knife", "old"],
    });
    expect(stats.repos.top[0]).toMatchObject({ name: "hello-world", stars: 10 });
    expect(stats.activity).toMatchObject({ pushes: 2, peak_hour_utc: 3, after_midnight_share: 50, weekend_share: 50 });
    expect(stats.activity.lazy_commit_messages).toEqual(["fix"]);
  });

  it("caches responses, so a second roast makes no requests", async () => {
    const { fetch, calls } = fakeGithub();
    let now = NOW;
    const github = createGithubClient({ fetch, now: () => now, ttlMs: 60_000 });
    await github.roastStats("octocat");
    const first = calls.length;
    expect(first).toBe(6);
    await github.roastStats("octocat");
    expect(calls.length).toBe(first);
    now += 61_000;
    await github.roastStats("octocat");
    expect(calls.length).toBe(first * 2);
  });

  it("says clearly when a user doesn't exist, and remembers it briefly", async () => {
    const { fetch, calls } = fakeGithub();
    const github = createGithubClient({ fetch, now: () => NOW });
    await expect(github.roastStats("nobody-here")).rejects.toThrow('There\'s no GitHub user named "nobody-here".');
    await expect(github.roastStats("nobody-here")).rejects.toMatchObject({ code: "not_found" });
    expect(calls).toEqual(["/users/nobody-here"]);
  });

  it("rejects invalid usernames without calling GitHub", async () => {
    const { fetch, calls } = fakeGithub();
    await expect(createGithubClient({ fetch }).roastStats("../etc/passwd")).rejects.toMatchObject({ code: "invalid" });
    expect(calls).toEqual([]);
  });

  it("explains a used-up rate limit with the reset time, and doesn't cache it", async () => {
    let limited = true;
    const calls: string[] = [];
    const fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      if (limited)
        return new Response("{}", {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Date.parse("2026-11-17T13:05:00Z") / 1000) },
        });
      return Response.json(USER);
    }) as typeof globalThis.fetch;
    const github = createGithubClient({ fetch, now: () => NOW });
    const error = await github.roastStats("octocat").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GithubError);
    expect((error as GithubError).code).toBe("rate_limited");
    expect((error as GithubError).message).toContain("after 13:05 UTC");
    limited = false;
    await github.roastStats("octocat").catch(() => undefined);
    expect(calls.filter((c) => c.endsWith("/users/octocat"))).toHaveLength(2);
  });
});
