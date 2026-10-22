import { App, applyDocumentTheme, applyHostStyleVariables, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";

/**
 * A registry component built without @genui/ui: any framework works as long as it ships a
 * single-file HTML bundle. The genui SDK passes the tools this component may call
 * (`genui/allowedTools`) and the workspace theme (`genui/theme`) in the render result's _meta.
 */

const questionEl = document.getElementById("question")!;
const starsEl = document.getElementById("stars")!;
const statusEl = document.getElementById("status")!;

let props: { question?: string; subject?: string; max?: number } = {};
let allowed = new Set<string>();
let locked = false;

const app = new App({ name: "genui-rating", version: "1.0.0" });

function applyHost(ctx: McpUiHostContext | undefined) {
  if (ctx?.theme) applyDocumentTheme(ctx.theme);
  if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
}

function render(selected = 0) {
  const max = Math.min(10, Math.max(3, props.max ?? 5));
  starsEl.replaceChildren(
    ...Array.from({ length: max }, (_, i) => i + 1).map((n) => {
      const button = document.createElement("button");
      button.textContent = "★";
      button.setAttribute("role", "radio");
      button.setAttribute("aria-label", `${n} star${n > 1 ? "s" : ""}`);
      button.setAttribute("aria-checked", String(n === selected));
      if (n <= selected) button.dataset.on = "";
      button.disabled = locked;
      button.onclick = () => void rate(n);
      return button;
    }),
  );
}

async function rate(stars: number) {
  if (locked) return;
  locked = true;
  render(stars);
  statusEl.textContent = "Saving…";
  const summary = `The user rated "${props.question}" ${stars}/${Math.min(10, Math.max(3, props.max ?? 5))}.`;

  if (allowed.has("save_rating")) {
    try {
      const result = await app.callServerTool({ name: "save_rating", arguments: { stars, question: props.question, subject: props.subject } });
      if (result.isError) throw new Error("save_rating failed");
      statusEl.textContent = "Thanks for your rating!";
      await app.updateModelContext({ content: [{ type: "text", text: `${summary} It was saved.` }] });
    } catch {
      locked = false;
      render(stars);
      statusEl.textContent = "Could not save. Try again.";
    }
  } else {
    // No save tool allowed on this server: hand the rating to the conversation.
    await app.sendMessage({ role: "user", content: [{ type: "text", text: summary }] });
    statusEl.textContent = "Thanks for your rating!";
  }
}

app.ontoolinput = ({ arguments: args }) => {
  props = (args ?? {}) as typeof props;
  questionEl.textContent = props.question ?? "Rate";
  render();
};

app.ontoolresult = (result) => {
  const meta = (result._meta ?? {}) as Record<string, unknown>;
  const tools = meta["genui/allowedTools"];
  allowed = new Set(Array.isArray(tools) ? tools : []);
  const theme = meta["genui/theme"] as { light?: { primary?: string }; dark?: { primary?: string } } | undefined;
  const mode = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  const primary = theme?.[mode]?.primary;
  if (primary) document.documentElement.style.setProperty("--genui-primary", primary);
};

app.onhostcontextchanged = applyHost;

render();
await app.connect();
applyHost(app.getHostContext());
