import { describe, expect, it } from "vitest";
import { decodeCard, encodeCard, roastLevel, safeAvatar, type RoastCard } from "./card";
import roast from "./component";

const card: RoastCard = {
  username: "octo-cat",
  name: "Octo Ćat 🐙",
  avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
  heat: "savage",
  score: 87,
  headline: "Ships forks, not features.",
  burns: [
    { stat: "38 of 52 repos are forks", line: "Your GitHub is a museum of other people's work." },
    { stat: "61% of pushes after midnight", line: "Bugs are written at 3am and so are you." },
    { stat: "0 READMEs", line: "Documentation is a vibe." },
  ],
  compliment: "At least your commit history proves you never give up. Or log off.",
  stats: { repos: 52, stars: 3, followers: 12, top_language: "JavaScript", since: 2016 },
};

describe("share links", () => {
  it("round-trips a card, unicode included, in URL-safe characters", () => {
    const encoded = encodeCard(card);
    expect(encoded).toMatch(/^[\w-]+$/);
    expect(decodeCard(encoded)).toEqual(card);
  });

  it("is a valid roast_my_github props object after decoding", () => {
    expect(roast.props.safeParse(decodeCard(encodeCard(card))).success).toBe(true);
  });

  it("rejects garbage and malformed cards", () => {
    expect(decodeCard("not base64 !!")).toBeUndefined();
    expect(decodeCard(encodeCard({ ...card, burns: card.burns.slice(0, 2) }))).toBeUndefined();
    expect(decodeCard(encodeCard({ ...card, score: 140 }))).toBeUndefined();
    expect(decodeCard(encodeCard({ ...card, username: "<script>" }))).toBeUndefined();
    expect(decodeCard(encodeCard({ ...card, headline: "x".repeat(500) }))).toBeUndefined();
  });

  it("drops avatars that aren't GitHub's", () => {
    expect(decodeCard(encodeCard({ ...card, avatar_url: "https://evil.example/a.png" }))?.avatar_url).toBeUndefined();
    expect(safeAvatar("javascript:alert(1)")).toBeUndefined();
  });
});

describe("roastLevel", () => {
  it("maps the score to a coffee roast", () => {
    expect([0, 24, 25, 50, 74, 75, 100].map((s) => roastLevel(s).id)).toEqual([
      "light",
      "light",
      "medium",
      "dark",
      "dark",
      "french",
      "french",
    ]);
  });
});
