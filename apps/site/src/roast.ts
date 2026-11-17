import "@fontsource-variable/geist";
import "@app-mcp/example-roast-my-github/card.css";
import "./site.css";
import { decodeCard, renderCard } from "@app-mcp/example-roast-my-github/card";

// /roast#<card>: a roast card shared from the chat. The card travels in the fragment, so nothing is stored.
const target = document.getElementById("roast")!;

function show() {
  const card = decodeCard(location.hash.slice(1));
  if (!card) {
    document.title = "Roast my GitHub · app-mcp";
    const message = document.createElement("div");
    message.className = "text-center";
    message.innerHTML = `<h1 class="text-2xl font-semibold tracking-tight">This roast link is incomplete</h1>
      <p class="mt-2 text-muted-foreground">Copy the whole link from the chat, including everything after the #.</p>`;
    target.replaceChildren(message);
    return;
  }
  document.title = `@${card.username} got roasted · app-mcp`;
  target.replaceChildren(renderCard(card));
}

show();
addEventListener("hashchange", show);
