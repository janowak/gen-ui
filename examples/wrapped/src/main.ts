import "./style.css";
import { mount, type ContextOf } from "@app-mcp/kit";
import wrapped, { WrappedData } from "./component";
import { BACKLINK, decodeShare, hostLabel, shareUrl, watermark } from "./share";
import { fitted, renderDeck, type Deck } from "./slides";

/**
 * One bundle, two places: inside a chat it is the `render_wrapped` view; opened directly (the share
 * page, https://app-mcp.com/wrapped/#d=…) it reads the cards from the link and shows the same deck.
 */

const SHARE_PAGE: string = import.meta.env.VITE_WRAPPED_SHARE_URL || "https://app-mcp.com/wrapped/";

/** What a share link carries. */
interface Shared {
  v: 1;
  host: string;
  data: WrappedData;
}

const card = document.getElementById("card")!;
const counterEl = document.getElementById("counter")!;
const prevButton = document.getElementById("prev") as HTMLButtonElement;
const nextButton = document.getElementById("next") as HTMLButtonElement;
const shareButton = document.getElementById("share") as HTMLButtonElement;
const panel = document.getElementById("panel")!;
const urlInput = document.getElementById("url") as HTMLInputElement;
const openButton = document.getElementById("open") as HTMLButtonElement;
const statusEl = document.getElementById("status")!;
const controls = document.getElementById("controls")!;

let deck: Deck | undefined;

function showDeck(data: WrappedData, host: string, start: number, onChange?: (index: number) => void) {
  deck = renderDeck(card, data, {
    start,
    footer: () => watermark(host),
    onChange(index) {
      counterEl.textContent = `${index + 1} / ${deck?.kinds.length ?? ""}`;
      prevButton.disabled = index === 0;
      nextButton.disabled = index === (deck?.kinds.length ?? 1) - 1;
      onChange?.(index);
    },
  });
  // renderDeck shows the first slide before `deck` is assigned; label it now.
  counterEl.textContent = `${deck.index + 1} / ${deck.kinds.length}`;
  nextButton.disabled = deck.index === deck.kinds.length - 1;
  controls.hidden = false;
}

prevButton.onclick = () => deck?.prev();
nextButton.onclick = () => deck?.next();
document.addEventListener("keydown", (event) => {
  if (event.target === card || event.target instanceof HTMLInputElement) return;
  if (event.key === "ArrowRight") deck?.next();
  else if (event.key === "ArrowLeft") deck?.prev();
});

function placeholder(title: string, detail: string) {
  card.replaceChildren();
  card.removeAttribute("tabindex");
  const slide = document.createElement("section");
  slide.className = "slide ink-pink intro active waiting";
  const disc = document.createElement("div");
  disc.className = "disc disc-intro";
  const heading = fitted("h2", "display reg", title);
  heading.style.setProperty("--chars", String(title.length));
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = detail;
  slide.append(disc, heading, hint);
  card.append(slide);
}

async function copy(url: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(url);
    return true;
  } catch {
    return false;
  }
}

function showLink(url: string, copied: boolean, copiedText: string) {
  panel.hidden = false;
  urlInput.value = url;
  statusEl.textContent = copied ? copiedText : "Copy the link below to share it.";
  if (!copied) urlInput.select();
}

// --- Share page --------------------------------------------------------------------------------

async function sharePage() {
  document.body.classList.add("standalone");
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  const applyScheme = () => (document.documentElement.dataset.theme = scheme.matches ? "dark" : "light");
  applyScheme();
  scheme.addEventListener("change", applyScheme);
  // Pasting another share link into the address bar only changes the fragment.
  addEventListener("hashchange", () => location.reload());

  const shared = (await decodeShare(location.hash)) as Partial<Shared> | undefined;
  const parsed = WrappedData.safeParse(shared?.data);
  const cta = document.getElementById("cta") as HTMLAnchorElement;
  cta.href = BACKLINK;
  cta.hidden = false;
  if (!parsed.success) {
    placeholder("Oops", "This link has no Wrapped in it. Check that it was copied in full.");
    return;
  }
  document.title = `${parsed.data.name ? `${parsed.data.name}’s` : "An"} AI Wrapped ${parsed.data.year}`;
  showDeck(parsed.data, typeof shared?.host === "string" ? hostLabel(shared.host) : "Claude", 0);
  shareButton.textContent = "Copy link";
  shareButton.onclick = async () => showLink(location.href, await copy(location.href), "Link copied.");
  openButton.hidden = true;
  card.focus({ preventScroll: true });
}

// --- In the chat -------------------------------------------------------------------------------

type Context = ContextOf<typeof wrapped>;
let shown: string | undefined;

function inChat(ctx: Context) {
  if (ctx.status === "error" || ctx.status === "cancelled") {
    shown = undefined;
    controls.hidden = true;
    return placeholder("Hmm", ctx.error ?? "This Wrapped was cancelled.");
  }
  if (!ctx.props) {
    if (shown === undefined) placeholder(String(ctx.partial?.year ?? "AI"), "Wrapping up your year…");
    shown = "";
    return;
  }

  const [saved, setSaved, state] = ctx.useState(0, "slide");
  const key = JSON.stringify(ctx.props);
  if (key !== shown) {
    shown = key;
    const host = hostLabel(ctx.app.getHostVersion()?.name);
    showDeck(ctx.props, host, saved, (index) => {
      if (index !== saved) setSaved(index);
    });
    shareButton.onclick = () => void share(ctx, host);
  } else if (state.restored && deck && saved !== deck.index) {
    deck.show(saved);
  }
}

async function share(ctx: Context, host: string) {
  if (!ctx.props) return;
  shareButton.disabled = true;
  try {
    const url = await shareUrl(SHARE_PAGE, { v: 1, host, data: ctx.props } satisfies Shared);
    showLink(url, await copy(url), "Link copied. Anyone with it can see these cards, and nothing is stored on a server.");
    openButton.hidden = false;
    openButton.onclick = () => void open(ctx, url);
  } finally {
    shareButton.disabled = false;
  }
}

async function open(ctx: Context, url: string) {
  try {
    const result = await ctx.app.openLink({ url });
    if (!result.isError) return;
  } catch {
    // Fall through to window.open.
  }
  window.open(url, "_blank", "noopener");
}

if (window.parent === window) {
  void sharePage();
} else {
  const ctx = mount(wrapped, inChat);
  // Links in a sandboxed iframe go through the host.
  document.addEventListener("click", (event) => {
    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>("a[href]");
    if (!link) return;
    event.preventDefault();
    void open(ctx, link.href);
  });
}
