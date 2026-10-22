// Hero demo: the message, the form streaming in as placeholders, the pre-fill, then the submit.
// The markup holds the finished state, so without JS or with reduced motion nothing moves.

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function setupDemo(root: HTMLElement) {
  const [user, note, view, answer] = root.querySelectorAll<HTMLElement>("[data-reveal]");
  const fields = [...root.querySelectorAll<HTMLElement>("[data-field]")];
  const submit = root.querySelector<HTMLElement>("[data-submit]")!;
  const done = root.querySelector<HTMLElement>("[data-done]")!;
  const label = submit.querySelector<HTMLElement>("[data-label]")!;
  const replay = root.querySelector<HTMLButtonElement>("[data-replay]")!;
  const steps = [user, note, view, answer, done, ...fields];
  let run = 0;

  // Set by the inline script in index.html; without it the finished state stays as it is
  if (!document.documentElement.classList.contains("motion")) {
    submit.classList.add("is-sent");
    return;
  }

  async function play() {
    const id = ++run;
    // false once a newer run started (Replay), so this one stops where it is
    const next = async (ms: number) => {
      await wait(ms);
      return id === run;
    };

    replay.hidden = true;
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
    replay.hidden = false;
  }

  replay.addEventListener("click", play);

  const observer = new IntersectionObserver(
    ([entry]) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      play();
    },
    { threshold: 0.35 },
  );
  observer.observe(root);
}
