// Hero demos: a reorder form and an order-history chart, side by side in a scroller that snaps to one
// at a time (swipe on touch, the Form/Chart switch anywhere). Each plays the first time it's on screen.
// The markup holds the finished state, so without JS or with reduced motion nothing moves.

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Set by the inline script in index.html
const motion = () => document.documentElement.classList.contains("motion");

/** Runs `play` once `root` is on screen; a card scrolled out of the scroller doesn't count. Replay runs it again. */
function playWhenSeen(root: HTMLElement, play: (next: (ms: number) => Promise<boolean>) => Promise<void>) {
  const replay = root.querySelector<HTMLButtonElement>("[data-replay]")!;
  let run = 0;

  async function start() {
    const id = ++run;
    // false once a newer run started (Replay), so this one stops where it is
    const next = async (ms: number) => {
      await wait(ms);
      return id === run;
    };
    replay.hidden = true;
    await play(next);
    if (id === run) replay.hidden = false;
  }

  replay.addEventListener("click", start);
  const observer = new IntersectionObserver(
    ([entry]) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      start();
    },
    { threshold: 0.35 },
  );
  observer.observe(root);
}

function setupFormDemo(root: HTMLElement) {
  const [user, note, view, answer] = root.querySelectorAll<HTMLElement>("[data-reveal]");
  const fields = [...root.querySelectorAll<HTMLElement>("[data-field]")];
  const submit = root.querySelector<HTMLElement>("[data-submit]")!;
  const done = root.querySelector<HTMLElement>("[data-done]")!;
  const label = submit.querySelector<HTMLElement>("[data-label]")!;
  const steps = [user, note, view, answer, done, ...fields];

  if (!motion()) {
    submit.classList.add("is-sent");
    return;
  }

  playWhenSeen(root, async (next) => {
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
  });
}

function setupChartDemo(root: HTMLElement) {
  const [user, note, view, answer] = root.querySelectorAll<HTMLElement>("[data-reveal]");
  const bars = root.querySelector<HTMLElement>("[data-bars]")!;

  if (!motion()) return;

  playWhenSeen(root, async (next) => {
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
  });
}

/** The Form/Chart switch under the scroller: follows the swipe and scrolls to the one picked. */
function setupSwitcher(root: HTMLElement) {
  const scroller = root.querySelector<HTMLElement>("[data-scroller]")!;
  const cards = [...scroller.querySelectorAll<HTMLElement>("[data-demo]")];
  const group = root.querySelector<HTMLElement>("[data-tabs]")!;

  const tabs = cards.map((card, i) => {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "demo-tab";
    tab.textContent = card.dataset.demo!;
    tab.setAttribute("aria-controls", card.id);
    tab.addEventListener("click", () => {
      scroller.scrollTo({ left: cards[i].offsetLeft - cards[0].offsetLeft, behavior: motion() ? "smooth" : "auto" });
    });
    group.append(tab);
    return tab;
  });

  const sync = () => {
    const step = cards[1].offsetLeft - cards[0].offsetLeft;
    const active = Math.min(cards.length - 1, Math.round(scroller.scrollLeft / step));
    tabs.forEach((tab, i) => tab.setAttribute("aria-pressed", String(i === active)));
    // Keep the hidden card out of the tab order so keyboard focus can't scroll it half in
    cards.forEach((card, i) => (card.inert = i !== active));
  };
  scroller.addEventListener("scroll", sync, { passive: true });
  // A reload or back navigation can restore the scroll to either card
  sync();
}

export function setupDemo(root: HTMLElement) {
  setupFormDemo(root.querySelector("#demo-form")!);
  setupChartDemo(root.querySelector("#demo-chart")!);
  setupSwitcher(root);
}
