import { mount, type ContextOf } from "@app-mcp/kit";
import rating from "./component";

/**
 * A registry component built with @app-mcp/kit and no UI framework. The kit validates props,
 * applies host styles and the workspace theme (`--app-mcp-*`), only calls tools the server
 * approved, and keeps the rating per render (`ctx.useState`) so a re-rendered message stays rated.
 */

const questionEl = document.getElementById("question")!;
const starsEl = document.getElementById("stars")!;
const statusEl = document.getElementById("status")!;

type Context = ContextOf<typeof rating>;

let saving = 0; // stars being saved
let message = "";

function render(ctx: Context) {
  questionEl.textContent = ctx.props?.question ?? ctx.partial?.question ?? "…";
  if (ctx.status === "error") {
    starsEl.replaceChildren();
    statusEl.textContent = ctx.error ?? "Something went wrong.";
    return;
  }

  const [saved, , state] = ctx.useState<number | undefined>(undefined);
  const selected = saved ?? saving;
  const locked = ctx.status !== "ready" || !state.restored || saved !== undefined || saving > 0;
  const max = ctx.props?.max ?? 5;
  starsEl.replaceChildren(
    ...Array.from({ length: max }, (_, i) => i + 1).map((n) => {
      const button = document.createElement("button");
      button.textContent = "★";
      button.setAttribute("role", "radio");
      button.setAttribute("aria-label", `${n} star${n > 1 ? "s" : ""}`);
      button.setAttribute("aria-checked", String(n === selected));
      if (n <= selected) button.dataset.on = "";
      button.disabled = locked;
      button.onclick = () => void rate(ctx, n);
      return button;
    }),
  );
  statusEl.textContent = saved !== undefined ? "Thanks for your rating!" : message;
}

async function rate(ctx: Context, stars: number) {
  const { question, subject, max = 5 } = ctx.props!;
  saving = stars;
  message = "Saving…";
  render(ctx);

  const summary = `The user rated "${question}" ${stars}/${max}.`;
  // The render id makes a repeated save (the view closed mid-save, then the user rated again) a no-op.
  const result = await ctx.tools.call("save_rating", { stars, question, subject, request_id: ctx.viewId });
  saving = 0;
  if (result.ok) {
    await ctx.model.update(`${summary} It was saved.`);
  } else if (result.unavailable) {
    // Tools don't run here (e.g. a registry preview): hand the rating to the conversation instead.
    await ctx.model.send(summary);
  } else {
    message = "Could not save. Try again.";
    return render(ctx);
  }
  const [, setSaved] = ctx.useState<number | undefined>(undefined);
  setSaved(stars); // re-renders
}

mount(rating, render);
