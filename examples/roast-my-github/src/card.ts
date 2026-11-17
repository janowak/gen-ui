/**
 * The roast card on its own: no MCP, no zod. The view renders it in the chat and the site's /roast page
 * renders it from a share link, so the two always look the same.
 */

export interface RoastCard {
  username: string;
  name?: string;
  avatar_url?: string;
  heat?: "gentle" | "medium" | "savage";
  score: number;
  headline: string;
  burns: { stat: string; line: string }[];
  compliment: string;
  stats?: { repos?: number; stars?: number; followers?: number; top_language?: string; since?: number };
}

export const LEVELS = [
  { id: "light", label: "Light roast", from: 0 },
  { id: "medium", label: "Medium roast", from: 25 },
  { id: "dark", label: "Dark roast", from: 50 },
  { id: "french", label: "French roast", from: 75 },
] as const;

export function roastLevel(score: number) {
  return [...LEVELS].reverse().find((level) => score >= level.from) ?? LEVELS[0];
}

type Child = Node | string | false | undefined;

function el(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  for (const child of children) if (child !== false && child !== undefined) node.append(child);
  return node;
}

const number = (n: number) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n.toLocaleString("en-US"));

/** Only GitHub's avatar host: anything else in a share link is ignored. */
export function safeAvatar(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "avatars.githubusercontent.com" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

export function renderCard(card: RoastCard): HTMLElement {
  const level = roastLevel(card.score);
  const avatar = safeAvatar(card.avatar_url);
  const stats = card.stats ?? {};
  const facts: [string, string | undefined][] = [
    ["repos", stats.repos === undefined ? undefined : number(stats.repos)],
    ["stars", stats.stars === undefined ? undefined : number(stats.stars)],
    ["followers", stats.followers === undefined ? undefined : number(stats.followers)],
    ["mostly", stats.top_language],
    ["since", stats.since === undefined ? undefined : String(stats.since)],
  ];

  return el(
    "article",
    { class: "roast", "data-level": level.id, "aria-label": `Roast of @${card.username}` },
    el(
      "header",
      { class: "roast-head" },
      avatar
        ? el("img", { class: "roast-avatar", src: avatar, alt: "", width: "56", height: "56" })
        : el("div", { class: "roast-avatar roast-avatar-empty", "aria-hidden": "true" }, card.username.slice(0, 1).toUpperCase()),
      el(
        "div",
        { class: "roast-who" },
        el("h2", { class: "roast-handle" }, `@${card.username}`),
        card.name && card.name !== card.username ? el("p", { class: "roast-name" }, card.name) : undefined,
      ),
      el(
        "div",
        { class: "roast-stamp", role: "img", "aria-label": `Roast score ${card.score} of 100, ${level.label.toLowerCase()}` },
        el("b", {}, String(card.score)),
        el("span", {}, level.label),
      ),
    ),
    el("p", { class: "roast-headline" }, card.headline),
    el(
      "div",
      { class: "roast-meter", "aria-hidden": "true" },
      ...LEVELS.map((l) => el("span", l.id === level.id ? { "data-on": "" } : {}, l.label.replace(" roast", ""))),
    ),
    el(
      "ul",
      { class: "roast-burns" },
      ...card.burns.map((burn) => el("li", {}, el("span", { class: "roast-stat" }, burn.stat), el("p", {}, burn.line))),
    ),
    el("p", { class: "roast-compliment" }, card.compliment),
    facts.some(([, value]) => value)
      ? el(
          "dl",
          { class: "roast-facts" },
          ...facts.filter(([, value]) => value).map(([label, value]) => el("div", {}, el("dt", {}, label), el("dd", {}, value!))),
        )
      : undefined,
  );
}

// Share links carry the card in the URL fragment (base64url JSON): nothing is stored, and the fragment
// never reaches a server.

export function encodeCard(card: RoastCard): string {
  const { username, name, avatar_url, heat, score, headline, burns, compliment, stats } = card;
  const bytes = new TextEncoder().encode(JSON.stringify({ username, name, avatar_url, heat, score, headline, burns, compliment, stats }));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const str = (value: unknown, max: number) => (typeof value === "string" && value.length <= max ? value : undefined);
const int = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined);

/** Reads a share fragment back. Undefined for anything that isn't a well-formed card. */
export function decodeCard(encoded: string): RoastCard | undefined {
  let raw: unknown;
  try {
    const binary = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
    raw = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const username = str(value.username, 39);
  const headline = str(value.headline, 120);
  const compliment = str(value.compliment, 220);
  const score = int(value.score);
  if (!username || !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(username) || !headline || !compliment) return undefined;
  if (score === undefined || score > 100 || !Array.isArray(value.burns)) return undefined;
  const burns = value.burns
    .map((b: unknown) => {
      const burn = (b ?? {}) as Record<string, unknown>;
      const stat = str(burn.stat, 40);
      const line = str(burn.line, 220);
      return stat && line ? { stat, line } : undefined;
    })
    .filter((b) => b !== undefined);
  if (burns.length < 3 || burns.length > 5 || burns.length !== value.burns.length) return undefined;
  const s = (value.stats ?? {}) as Record<string, unknown>;
  const heat = value.heat === "gentle" || value.heat === "medium" || value.heat === "savage" ? value.heat : undefined;
  return {
    username,
    name: str(value.name, 100),
    avatar_url: safeAvatar(str(value.avatar_url, 300)),
    heat,
    score,
    headline,
    burns,
    compliment,
    stats: {
      repos: int(s.repos),
      stars: int(s.stars),
      followers: int(s.followers),
      top_language: str(s.top_language, 40),
      since: int(s.since),
    },
  };
}
