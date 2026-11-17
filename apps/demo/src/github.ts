/**
 * Public GitHub data for the "Roast my GitHub" demo, without auth. GitHub allows 60 unauthenticated
 * requests an hour per IP and a roast takes up to 6, so responses are cached in memory for a while and
 * a used-up limit says when it resets. GITHUB_TOKEN, if set, raises the limit to 5000.
 */

const USERNAME = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
const TUTORIAL =
  /tutorial|course|learn|bootcamp|100-?days|todo|clone|starter|boilerplate|example|exercise|practice|playground|udemy|freecodecamp|odin|hello-?world/i;
const YEAR = 365 * 24 * 3600 * 1000;

export class GithubError extends Error {
  constructor(
    readonly code: "invalid" | "not_found" | "rate_limited" | "unavailable",
    message: string,
  ) {
    super(message);
  }
}

interface Repo {
  name: string;
  fork: boolean;
  description: string | null;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  pushed_at: string | null;
  created_at: string;
  archived: boolean;
  homepage: string | null;
  topics?: string[];
  default_branch: string;
}

interface User {
  login: string;
  name: string | null;
  avatar_url: string;
  html_url: string;
  bio: string | null;
  company: string | null;
  blog: string | null;
  public_repos: number;
  public_gists: number;
  followers: number;
  following: number;
  created_at: string;
}

interface Event {
  type: string;
  created_at: string;
  repo: { name: string };
  payload?: { size?: number; commits?: { message: string }[] };
}

export interface GithubClientOptions {
  fetch?: typeof fetch;
  token?: string;
  /** How long a response is reused. Default 10 minutes; unknown users are remembered for 1 minute. */
  ttlMs?: number;
  now?: () => number;
}

export type RoastStats = Awaited<ReturnType<ReturnType<typeof createGithubClient>["roastStats"]>>;

export function createGithubClient(options: GithubClientOptions = {}) {
  const doFetch = options.fetch ?? fetch;
  const ttl = options.ttlMs ?? 10 * 60 * 1000;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { expires: number; value: Promise<unknown> }>();

  async function request<T>(path: string, missing?: T): Promise<T> {
    const response = await doFetch(`https://api.github.com${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "app-mcp-roast-demo",
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
    }).catch(() => {
      throw new GithubError("unavailable", "Couldn't reach GitHub. Try again in a moment.");
    });
    if (response.status === 404 && missing !== undefined) return missing;
    if (response.status === 404) throw new GithubError("not_found", "not found");
    if ((response.status === 403 || response.status === 429) && response.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      const at = Number.isFinite(reset) && reset > 0 ? ` after ${new Date(reset * 1000).toISOString().slice(11, 16)} UTC` : " in an hour";
      throw new GithubError(
        "rate_limited",
        `GitHub's hourly limit for unauthenticated requests is used up. Try again${at}, or set GITHUB_TOKEN on the server.`,
      );
    }
    if (!response.ok) throw new GithubError("unavailable", `GitHub answered ${response.status}. Try again in a moment.`);
    return (await response.json()) as T;
  }

  /** One request per path per TTL, shared by concurrent callers. Failures aren't kept, except unknown users. */
  function cached<T>(path: string, missing?: T): Promise<T> {
    const hit = cache.get(path);
    if (hit && hit.expires > now()) return hit.value as Promise<T>;
    const value = request<T>(path, missing);
    cache.set(path, { expires: now() + ttl, value });
    value.catch((error: unknown) => {
      if (error instanceof GithubError && error.code === "not_found") cache.set(path, { expires: now() + Math.min(ttl, 60_000), value });
      else if (cache.get(path)?.value === value) cache.delete(path);
    });
    if (cache.size > 1000) cache.delete(cache.keys().next().value!);
    return value;
  }

  async function roastStats(username: string) {
    const login = username.trim().replace(/^@/, "");
    if (!USERNAME.test(login)) throw new GithubError("invalid", `"${username}" isn't a valid GitHub username.`);
    const user = await cached<User>(`/users/${login}`).catch((error: unknown) => {
      if (error instanceof GithubError && error.code === "not_found")
        throw new GithubError("not_found", `There's no GitHub user named "${login}".`);
      throw error;
    });
    const [repos, events] = await Promise.all([
      cached<Repo[]>(`/users/${user.login}/repos?per_page=100&sort=pushed`),
      cached<Event[]>(`/users/${user.login}/events/public?per_page=100`, []),
    ]);
    const own = repos.filter((r) => !r.fork);
    const forks = repos.filter((r) => r.fork);
    // README checks cost a request each: only the three most recently pushed repos of their own.
    const checked = own.slice(0, 3);
    const readmes = await Promise.all(
      checked.map((r) => cached<{ name?: string } | null>(`/repos/${user.login}/${r.name}/readme`, null).catch(() => undefined)),
    );

    const t = now();
    const languages = new Map<string, number>();
    for (const r of own) if (r.language) languages.set(r.language, (languages.get(r.language) ?? 0) + 1);
    const topLanguages = [...languages]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([language, repos]) => ({ language, repos }));
    const stars = own.reduce((sum, r) => sum + r.stargazers_count, 0);

    const pushes = events.filter((e) => e.type === "PushEvent");
    const hours = Array.from({ length: 24 }, () => 0);
    let weekend = 0;
    for (const e of pushes) {
      const d = new Date(e.created_at);
      hours[d.getUTCHours()]!++;
      if (d.getUTCDay() === 0 || d.getUTCDay() === 6) weekend++;
    }
    const messages = pushes.flatMap((e) => e.payload?.commits?.map((c) => c.message.split("\n")[0]!) ?? []);
    const lazy = messages.filter((m) => /^(fix|update|wip|test|asdf|changes?|stuff|\.|minor|commit|initial commit)\.?$/i.test(m.trim()));
    const peak = hours.indexOf(Math.max(...hours));
    const share = (n: number, of: number) => (of ? Math.round((n / of) * 100) : 0);

    return {
      profile: {
        username: user.login,
        name: user.name ?? undefined,
        avatar_url: user.avatar_url,
        url: user.html_url,
        bio: user.bio ?? undefined,
        company: user.company ?? undefined,
        blog: user.blog || undefined,
        account_age_years: Math.floor((t - Date.parse(user.created_at)) / YEAR),
      },
      /** The numbers the card shows along the bottom. */
      summary: {
        repos: user.public_repos,
        stars,
        followers: user.followers,
        top_language: topLanguages[0]?.language,
        since: new Date(user.created_at).getUTCFullYear(),
      },
      social: { followers: user.followers, following: user.following, gists: user.public_gists },
      repos: {
        public: user.public_repos,
        looked_at: repos.length,
        own: own.length,
        forks: forks.length,
        tutorial_like_forks: forks
          .filter((r) => TUTORIAL.test(r.name))
          .map((r) => r.name)
          .slice(0, 10),
        tutorial_like_own: own
          .filter((r) => TUTORIAL.test(r.name))
          .map((r) => r.name)
          .slice(0, 10),
        without_description: own.filter((r) => !r.description).length,
        zero_stars: own.filter((r) => r.stargazers_count === 0).length,
        untouched_2y: own.filter((r) => r.pushed_at && t - Date.parse(r.pushed_at) > 2 * YEAR).length,
        archived: own.filter((r) => r.archived).length,
        readme_checked: checked.length,
        without_readme: checked.filter((_, i) => readmes[i] === null).map((r) => r.name),
        top: [...own]
          .sort((a, b) => b.stargazers_count - a.stargazers_count)
          .slice(0, 5)
          .map((r) => ({
            name: r.name,
            stars: r.stargazers_count,
            language: r.language ?? undefined,
            description: r.description ?? undefined,
          })),
        last_push: repos[0]?.pushed_at ?? undefined,
      },
      languages: topLanguages,
      activity: {
        window: "GitHub's public events from the last 90 days (up to 100), hours in UTC",
        events: events.length,
        pushes: pushes.length,
        peak_hour_utc: pushes.length ? peak : undefined,
        after_midnight_share: share(
          hours.slice(0, 5).reduce((a, b) => a + b, 0),
          pushes.length,
        ),
        weekend_share: share(weekend, pushes.length),
        lazy_commit_messages: lazy.slice(0, 5),
        sample_commit_messages: messages.slice(0, 8),
      },
    };
  }

  return { roastStats };
}
