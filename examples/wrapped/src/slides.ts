import type { WrappedData } from "./component";

/**
 * The card deck, shared by the chat view and the public share page. Pure DOM, no host APIs.
 * Each slide is printed in two "inks" (risograph style): `--bg` paper, `--fg` main ink and `--ink2`,
 * the second plate, which starts out of register on every slide and settles into place.
 */

export type SlideKind = "intro" | "stats" | "topics" | "themes" | "phrase" | "personality" | "summary";

/** The slides `data` gets, in order: 6, or 7 with headline numbers. */
export function slidesFor(data: WrappedData): SlideKind[] {
  const stats = data.stats && Object.values(data.stats).some((value) => value !== undefined);
  return ["intro", ...(stats ? (["stats"] as const) : []), "topics", "themes", "phrase", "personality", "summary"];
}

type Child = Node | string | false | undefined;
function h(tag: string, className?: string, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  if (className) el.className = className;
  for (const child of children) if (child !== false && child !== undefined) el.append(child);
  return el;
}

/** Display text sized to its length (`.fit` reads `--chars`), so long names still fit the card. */
export function fitted(tag: string, className: string, text: string): HTMLElement {
  const el = h(tag, `${className} fit`, text);
  el.style.setProperty("--chars", String(Math.max(6, text.length)));
  return el;
}

const number = (n: number) => Math.round(n).toLocaleString("en-US");

/** Counts up to `to` when the slide is shown (`data-count`, run by `play`). */
function counter(to: number, className = "count"): HTMLElement {
  const el = h("span", className, number(to));
  el.dataset.count = String(to);
  return el;
}

/** A halftone disc, the slide's one big shape. */
const disc = (variant: string) => h("div", `disc disc-${variant}`);

function intro(data: WrappedData): HTMLElement {
  return h(
    "section",
    "slide ink-pink intro",
    disc("intro"),
    h("p", "kicker", data.name ? `${data.name}, this was your` : "This was your"),
    h("h2", "display year reg", String(data.year)),
    h("p", "title", "AI Wrapped"),
    h("p", "hint", "Tap to start"),
  );
}

function stats(data: WrappedData): HTMLElement {
  const { conversations, messages, hours } = data.stats ?? {};
  const row = (value: number | undefined, label: string, prefix = "") =>
    value !== undefined && h("li", undefined, h("span", "big reg", prefix, counter(value)), h("span", "label", label));
  return h(
    "section",
    "slide ink-blue stats",
    disc("stats"),
    h("p", "kicker", "You and AI, by the numbers"),
    h("ul", "numbers", row(messages, "messages sent"), row(conversations, "conversations"), row(hours, "hours together", "~")),
  );
}

function topics(data: WrappedData): HTMLElement {
  const [first, ...rest] = data.topics;
  return h(
    "section",
    "slide ink-yellow topics",
    disc("topics"),
    h("p", "kicker", "Your top topic"),
    fitted("h2", "display topic reg", first!.name),
    first!.note && h("p", "note", first!.note),
    rest.length > 0 &&
      h(
        "ol",
        "runners",
        ...rest.map((topic, i) =>
          h("li", undefined, h("span", "rank", String(i + 2)), h("span", "name", topic.name), topic.note && h("span", "sub", topic.note)),
        ),
      ),
  );
}

function themes(data: WrappedData): HTMLElement {
  const sorted = [...data.themes].sort((a, b) => b.weight - a.weight);
  const max = sorted[0]!.weight;
  return h(
    "section",
    "slide ink-teal themes",
    h("p", "kicker", "Where your hours went"),
    h(
      "ul",
      "bars",
      ...sorted.map((theme, i) => {
        const bar = h("li", undefined, h("span", "name", theme.name), h("span", "bar"));
        bar.style.setProperty("--w", `${Math.max(8, (theme.weight / max) * 100)}%`);
        bar.style.setProperty("--i", String(i));
        return bar;
      }),
    ),
  );
}

function phrase(data: WrappedData): HTMLElement {
  return h(
    "section",
    "slide ink-red phrase",
    disc("phrase"),
    h("p", "kicker", "Your most-said phrase"),
    fitted("blockquote", "display quote reg", `“${data.phrase.text}”`),
    h("p", "times", counter(data.phrase.count, "count big"), " times"),
  );
}

function personality(data: WrappedData): HTMLElement {
  const { type, description, traits = [] } = data.personality;
  return h(
    "section",
    "slide ink-violet personality",
    disc("personality"),
    h("p", "kicker", "Your AI personality"),
    fitted("h2", "display type reg", type),
    h("p", "description", description),
    traits.length > 0 && h("ul", "traits", ...traits.map((trait) => h("li", undefined, trait))),
  );
}

function summary(data: WrappedData): HTMLElement {
  const cell = (label: string, value: string, className = "") =>
    h("div", `cell ${className}`, h("span", "label", label), h("span", "value", value));
  return h(
    "section",
    "slide ink-paper summary",
    h("p", "kicker", data.name ? `${data.name}’s AI Wrapped` : "My AI Wrapped"),
    h("h2", "display year-small reg", String(data.year)),
    h(
      "div",
      "grid",
      cell("Top topic", data.topics[0]!.name, "wide"),
      cell("Kept saying", `“${data.phrase.text}” ×${number(data.phrase.count)}`, "wide"),
      cell("Personality", data.personality.type, "wide"),
    ),
    h("p", "closing", data.summary),
  );
}

const BUILD: Record<SlideKind, (data: WrappedData) => HTMLElement> = { intro, stats, topics, themes, phrase, personality, summary };

const reducedMotion = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** Runs the counters on a slide that was just shown. */
function play(slide: HTMLElement) {
  for (const el of slide.querySelectorAll<HTMLElement>("[data-count]")) {
    const to = Number(el.dataset.count);
    if (reducedMotion() || to < 2) {
      el.textContent = number(to);
      continue;
    }
    const start = performance.now();
    const duration = 1100;
    // The exact number even where animation frames are throttled (a background tab).
    setTimeout(() => (el.textContent = number(to)), duration + 50);
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      el.textContent = number(to * (1 - (1 - t) ** 3));
      if (t < 1 && el.isConnected) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

export interface Deck {
  readonly kinds: SlideKind[];
  readonly index: number;
  show(index: number): void;
  next(): void;
  prev(): void;
}

export interface DeckOptions {
  /** Slide to start on. */
  start?: number;
  /** Called after the slide changed. */
  onChange?: (index: number) => void;
  /** Added to the bottom of every slide (the watermark). */
  footer?: () => Node;
}

/**
 * Renders `data` into `card` (replacing its contents) as a deck: progress segments on top, tap the
 * left third to go back and the rest to go on, arrow keys while the card has focus.
 */
export function renderDeck(card: HTMLElement, data: WrappedData, options: DeckOptions = {}): Deck {
  const kinds = slidesFor(data);
  const slides = kinds.map((kind) => {
    const slide = BUILD[kind](data);
    slide.dataset.kind = kind;
    if (options.footer) slide.append(options.footer());
    return slide;
  });
  const segments = kinds.map(() => h("span", "segment", h("span", "fill")));
  const live = h("p", "sr-only");
  live.setAttribute("aria-live", "polite");
  card.replaceChildren(h("div", "progress", ...segments), ...slides, live);
  card.tabIndex = 0;
  card.setAttribute("role", "region");
  card.setAttribute("aria-roledescription", "slides");
  card.setAttribute("aria-label", `AI Wrapped ${data.year}`);

  let index = -1;
  const deck: Deck = {
    kinds,
    get index() {
      return index;
    },
    show(next) {
      next = Math.max(0, Math.min(slides.length - 1, next));
      if (next === index) return;
      const forward = next > index;
      index = next;
      slides.forEach((slide, i) => {
        slide.classList.toggle("active", i === index);
        slide.toggleAttribute("inert", i !== index);
        slide.setAttribute("aria-hidden", String(i !== index));
      });
      segments.forEach((segment, i) => {
        segment.classList.toggle("done", i < index);
        segment.classList.toggle("current", i === index);
      });
      card.dataset.direction = forward ? "forward" : "back";
      card.dataset.last = String(index === slides.length - 1);
      live.textContent = `Slide ${index + 1} of ${slides.length}`;
      play(slides[index]!);
      options.onChange?.(index);
    },
    next: () => deck.show(index + 1),
    prev: () => deck.show(index - 1),
  };

  card.onclick = (event) => {
    if ((event.target as HTMLElement).closest("a, button")) return;
    const box = card.getBoundingClientRect();
    if (event.clientX - box.left < box.width / 3) deck.prev();
    else deck.next();
  };
  card.onkeydown = (event) => {
    if (event.key === "ArrowRight" || event.key === " ") deck.next();
    else if (event.key === "ArrowLeft") deck.prev();
    else if (event.key === "Home") deck.show(0);
    else if (event.key === "End") deck.show(slides.length - 1);
    else return;
    event.preventDefault();
  };

  deck.show(options.start ?? 0);
  return deck;
}
