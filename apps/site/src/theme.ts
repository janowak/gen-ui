// Theme toggle: flips light and dark. A choice that matches the system theme isn't saved,
// so the page follows the system again (the inline script in index.html applies it on load).

const system = matchMedia("(prefers-color-scheme: dark)");

export function setupThemeToggle(button: HTMLButtonElement) {
  const root = document.documentElement;
  const label = () =>
    button.setAttribute("aria-label", root.classList.contains("dark") ? "Switch to light theme" : "Switch to dark theme");

  button.addEventListener("click", () => {
    const dark = !root.classList.contains("dark");
    try {
      if (dark === system.matches) localStorage.removeItem("theme");
      else localStorage.setItem("theme", dark ? "dark" : "light");
    } catch {
      // Storage blocked: the choice lasts until the next reload
    }
    // Swap colors at once instead of running every element's transition
    root.classList.add("theme-switching");
    root.classList.toggle("dark", dark);
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")));
    label();
  });

  system.addEventListener("change", label);
  label();
}
