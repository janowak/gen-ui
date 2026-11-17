// Hero demos: a reorder form and an order-history chart, side by side in a scroller that snaps to one
// at a time (swipe on touch, the Form/Chart switch anywhere). Each plays the first time it's on screen,
// then the scroller moves on to the next one a few seconds after it finishes, until the visitor takes over.
// The markup holds the finished state, so without JS or with reduced motion nothing moves.

/** How long a finished demo stays up before the next one slides in. Matches `--advance` in site.css. */
const ADVANCE_MS = 5000;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Set by the inline script in index.html
const motion = () => document.documentElement.classList.contains("motion");

type Play = (next: (ms: number) => Promise<boolean>) => Promise<void>;
/** Plays a demo from the start; `onDone` runs if it reaches the end without being restarted. */
type Start = (onDone?: () => void) => void;

/** Runs `play` once `root` is on screen; a card scrolled out of the scroller doesn't count. Replay runs it again. */
function playWhenSeen(root: HTMLElement, play: Play, onFirstDone: () => void): Start {
  const replay = root.querySelector<HTMLButtonElement>("[data-replay]")!;
  let run = 0;

  async function start(onDone?: () => void) {
    observer.disconnect();
    const id = ++run;
    // false once a newer run started (Replay), so this one stops where it is
    const next = async (ms: number) => {
      await wait(ms);
      return id === run;
    };
    replay.hidden = true;
    await play(next);
    if (id !== run) return;
    replay.hidden = false;
    onDone?.();
  }

  replay.addEventListener("click", () => start());
  const observer = new IntersectionObserver(([entry]) => entry.isIntersecting && start(onFirstDone), { threshold: 0.35 });
  observer.observe(root);
  return start;
}

function setupFormDemo(root: HTMLElement, onDone: () => void): Start | null {
  const [user, note, view, answer] = root.querySelectorAll<HTMLElement>("[data-reveal]");
  const fields = [...root.querySelectorAll<HTMLElement>("[data-field]")];
  const submit = root.querySelector<HTMLElement>("[data-submit]")!;
  const done = root.querySelector<HTMLElement>("[data-done]")!;
  const label = submit.querySelector<HTMLElement>("[data-label]")!;
  const steps = [user, note, view, answer, done, ...fields];

  if (!motion()) {
    submit.classList.add("is-sent");
    return null;
  }

  return playWhenSeen(
    root,
    async (next) => {
      steps.forEach((el) => el.classList.remove("is-in", "is-filled"));
      fields.forEach((el) => el.classList.add("is-skeleton"));
      submit.classList.remove("is-busy", "is-sent");
      label.textContent = "Place order";

      if (!(await next(400))) return;
      user.classList.add("is-in");
      if (!(await next(900))) return;
      note.classList.add("is-in");
      if (!(await next(450))) return;
      view.classList.add("is-in");
      for (const field of fields) {
        if (!(await next(200))) return;
        field.classList.add("is-in");
      }
      if (!(await next(500))) return;
      for (const field of fields) {
        if (!(await next(280))) return;
        field.classList.remove("is-skeleton");
        field.classList.add("is-filled");
      }
      if (!(await next(1100))) return;
      submit.classList.add("is-pressed");
      if (!(await next(140))) return;
      submit.classList.remove("is-pressed");
      submit.classList.add("is-busy");
      label.textContent = "Placing order…";
      if (!(await next(1000))) return;
      submit.classList.replace("is-busy", "is-sent");
      label.textContent = "Place order";
      done.classList.add("is-in");
      if (!(await next(600))) return;
      answer.classList.add("is-in");
    },
    onDone,
  );
}

function setupChartDemo(root: HTMLElement, onDone: () => void): Start | null {
  const [user, note, view, answer] = root.querySelectorAll<HTMLElement>("[data-reveal]");
  const bars = root.querySelector<HTMLElement>("[data-bars]")!;

  if (!motion()) return null;

  return playWhenSeen(
    root,
    async (next) => {
      [user, note, view, answer, bars].forEach((el) => el.classList.remove("is-in"));

      if (!(await next(400))) return;
      user.classList.add("is-in");
      if (!(await next(900))) return;
      note.classList.add("is-in");
      if (!(await next(450))) return;
      view.classList.add("is-in");
      if (!(await next(400))) return;
      bars.classList.add("is-in");
      if (!(await next(1500))) return;
      answer.classList.add("is-in");
    },
    onDone,
  );
}

/** The Form/Chart switch under the scroller: follows the swipe and scrolls to the one picked. */
function setupSwitcher(root: HTMLElement) {
  const scroller = root.querySelector<HTMLElement>("[data-scroller]")!;
  const cards = [...scroller.querySelectorAll<HTMLElement>("[data-demo]")];
  const group = root.querySelector<HTMLElement>("[data-tabs]")!;

  const show = (i: number) =>
    scroller.scrollTo({ left: cards[i].offsetLeft - cards[0].offsetLeft, behavior: motion() ? "smooth" : "auto" });

  const tabs = cards.map((card, i) => {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "demo-tab";
    tab.textContent = card.dataset.demo!;
    tab.setAttribute("aria-controls", card.id);
    tab.addEventListener("click", () => show(i));
    group.append(tab);
    return tab;
  });

  const active = () => Math.min(cards.length - 1, Math.round(scroller.scrollLeft / (cards[1].offsetLeft - cards[0].offsetLeft)));
  const sync = () => {
    const current = active();
    tabs.forEach((tab, i) => tab.setAttribute("aria-pressed", String(i === current)));
    // Keep the hidden card out of the tab order so keyboard focus can't scroll it half in
    cards.forEach((card, i) => (card.inert = i !== current));
  };
  scroller.addEventListener("scroll", sync, { passive: true });
  // A reload or back navigation can restore the scroll to either card
  sync();

  return { cards, tabs, show, active };
}

/**
 * Once a demo finishes, counts down on its tab and slides to the next one, which plays from the start,
 * looping. Any touch, wheel, key or click inside the demos hands control to the visitor for good.
 */
function setupAutoAdvance(root: HTMLElement, switcher: ReturnType<typeof setupSwitcher>, starts: Start[]) {
  const { cards, tabs, show, active } = switcher;
  let timer = 0;
  let stopped = false;

  const clear = () => {
    clearTimeout(timer);
    tabs.forEach((tab) => tab.classList.remove("is-counting"));
  };
  const stop = () => {
    stopped = true;
    clear();
  };
  for (const type of ["pointerdown", "wheel", "keydown", "touchstart"]) root.addEventListener(type, stop, { passive: true });

  const schedule = () => {
    if (stopped) return;
    clear();
    const from = active();
    tabs[from].classList.add("is-counting");
    timer = window.setTimeout(() => {
      clear();
      if (stopped || active() !== from) return;
      const to = (from + 1) % cards.length;
      show(to);
      starts[to](schedule);
    }, ADVANCE_MS);
  };
  return schedule;
}

export function setupDemo(root: HTMLElement) {
  const switcher = setupSwitcher(root);
  // The first play of each card comes from scrolling it into view; later ones from the auto-advance
  let schedule = () => {};
  const form = setupFormDemo(root.querySelector("#demo-form")!, () => schedule());
  const chart = setupChartDemo(root.querySelector("#demo-chart")!, () => schedule());
  if (form && chart) schedule = setupAutoAdvance(root, switcher, [form, chart]);
}
