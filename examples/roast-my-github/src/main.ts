import { mount, type ContextOf } from "@app-mcp/kit";
import "./card.css";
import "./view.css";
import { encodeCard, renderCard } from "./card";
import roast, { HEAT } from "./component";

/** Where share links open when the server has no share_roast tool (e.g. the hosted MCP on its own). */
export const DEFAULT_SHARE_BASE = "https://app-mcp.com/roast";

type Context = ContextOf<typeof roast>;
type Heat = (typeof HEAT)[number];

interface ViewState {
  /** The re-roast this card asked for, so its buttons stay used after a reload. */
  asked?: "harder" | "nicer";
  shareUrl?: string;
}

const root = document.getElementById("root")!;
let note = "";
let sharing = false;
/** The card for the current props, kept across re-renders so its stamp animates once. */
let rendered: { props: unknown; card: HTMLElement } | undefined;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function render(ctx: Context) {
  if (ctx.status === "error" || ctx.status === "cancelled") {
    root.replaceChildren(el("div", { className: "roast-error" }, ctx.error ?? "The roast was cancelled."));
    return;
  }
  if (ctx.status !== "ready" || !ctx.props) {
    const who = ctx.partial?.username;
    root.replaceChildren(el("div", { className: "roast-waiting" }, who ? `Roasting @${who}…` : "Grinding the beans…"));
    return;
  }

  const props = ctx.props;
  const [state, setState] = ctx.useState<ViewState>({});
  const heat = props.heat;
  const used = state.asked !== undefined;

  const harder = el("button", {
    type: "button",
    textContent: heat === "savage" ? "Roast even harder" : "Roast harder",
    disabled: used,
    onclick: () => void reroast(ctx, "harder", HEAT[Math.min(HEAT.indexOf(heat) + 1, HEAT.length - 1)]!, setState),
  });
  const nicer = el("button", {
    type: "button",
    textContent: "Be nicer",
    disabled: used,
    onclick: () => void reroast(ctx, "nicer", HEAT[Math.max(HEAT.indexOf(heat) - 1, 0)]!, setState),
  });
  const share = el("button", {
    type: "button",
    className: "roast-share",
    textContent: state.shareUrl ? "Open share page" : sharing ? "Making a link…" : "Share",
    disabled: sharing,
    onclick: () => void (state.shareUrl ? open(ctx, state.shareUrl) : shareCard(ctx, setState)),
  });

  if (rendered?.props !== props) rendered = { props, card: renderCard(props) };
  const children: Node[] = [rendered.card, el("div", { className: "roast-actions" }, harder, nicer, share)];
  if (state.shareUrl) {
    const input = document.createElement("input");
    input.readOnly = true;
    input.value = state.shareUrl;
    input.setAttribute("aria-label", "Share link");
    input.onfocus = () => input.select();
    children.push(el("div", { className: "roast-link" }, input));
  }
  const status = note || (state.asked === "harder" ? "Asked for a harder roast." : state.asked === "nicer" ? "Asked for a nicer one." : "");
  children.push(el("p", { className: "roast-note" }, status));
  root.replaceChildren(...children);
}

async function reroast(ctx: Context, asked: "harder" | "nicer", heat: Heat, setState: (s: ViewState) => void) {
  const { username } = ctx.props!;
  const how = asked === "harder" ? "Roast them harder" : "Be nicer this time";
  const sent = await ctx.model.send(
    `${how}: roast @${username} again with heat "${heat}". Reuse the github_roast_stats data, write new burns, and call render_roast_my_github again.`,
  );
  if (sent) setState({ ...ctx.useState<ViewState>({})[0], asked });
  else {
    note = "The chat didn't accept the message. Ask for it in the chat instead.";
    render(ctx);
  }
}

async function shareCard(ctx: Context, setState: (s: ViewState) => void) {
  sharing = true;
  note = "";
  render(ctx);
  const card = encodeCard(ctx.props!);
  const result = await ctx.tools.call("share_roast", { card, username: ctx.props!.username });
  sharing = false;
  let url: string | undefined;
  if (result.ok) url = (result.data as { url?: unknown } | undefined)?.url as string | undefined;
  else if (result.unavailable) url = `${DEFAULT_SHARE_BASE}#${card}`;
  if (typeof url !== "string") {
    note = result.ok ? "share_roast returned no link." : result.error;
    return render(ctx);
  }
  const copied = await navigator.clipboard?.writeText(url).then(
    () => true,
    () => false,
  );
  note = copied ? "Link copied. It opens the card on its own page." : "Copy the link below. It opens the card on its own page.";
  setState({ ...ctx.useState<ViewState>({})[0], shareUrl: url });
}

async function open(ctx: Context, url: string) {
  const result = await ctx.app.openLink({ url }).catch(() => ({ isError: true }));
  if (result.isError) {
    note = "The chat blocked opening the link. Copy it from the box below.";
    render(ctx);
  }
}

mount(roast, render);
