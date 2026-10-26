/** Buttons with `data-copy` copy that text and say so for a moment. */
export function setupCopy(root: ParentNode) {
  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-copy]")) {
    const label = button.textContent;
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.copy!);
        button.textContent = "Copied";
      } catch {
        button.textContent = "Copy failed";
      }
      setTimeout(() => (button.textContent = label), 1500);
    });
  }
}
