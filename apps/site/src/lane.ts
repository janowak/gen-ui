// Release lane: promote beta to stable and roll stable back, the way the registry does.

const VERSIONS = ["1.0.0", "1.1.0", "1.2.0", "1.3.0"];

export function setupLane(root: HTMLElement) {
  const versions = [...root.querySelectorAll<HTMLElement>(".lane-ver")];
  const promote = root.querySelector<HTMLButtonElement>("[data-promote]")!;
  const rollback = root.querySelector<HTMLButtonElement>("[data-rollback]")!;
  const log = root.querySelector<HTMLElement>("[data-log]")!;
  const beta = 3;
  // Versions stable has pointed at, oldest first; the last one is current
  const history = [1, 2];

  function render(message?: string) {
    const stable = history[history.length - 1];
    root.style.setProperty("--stable", String(stable));
    root.style.setProperty("--beta", String(beta));
    versions.forEach((el, i) => {
      el.classList.toggle("is-stable", i === stable);
      el.classList.toggle("is-beta", i === beta);
    });

    promote.textContent = `Promote ${VERSIONS[beta]}`;
    promote.disabled = stable === beta;
    const previous = history[history.length - 2];
    rollback.textContent = previous === undefined ? "Roll back" : `Roll back to ${VERSIONS[previous]}`;
    rollback.disabled = previous === undefined;

    if (message) log.textContent = message;
  }

  promote.addEventListener("click", () => {
    history.push(beta);
    render(`Promoted ${VERSIONS[beta]} to stable. New conversations get it; old messages keep the version they were made with.`);
  });

  rollback.addEventListener("click", () => {
    history.pop();
    const stable = VERSIONS[history[history.length - 1]];
    render(`Rolled back stable to ${stable}. Beta testers still see ${VERSIONS[beta]}.`);
  });

  render();
}
