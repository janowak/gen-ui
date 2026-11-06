/** Serve on a separate, cookieless origin. Never serve this route on your app/API origin. */
export function sandboxResponse(request: Request, allowedParents: readonly string[]): Response {
  const parents = allowedParents.map(origin);
  if (!parents.length) throw new Error("Configure at least one parent origin");
  const url = new URL(request.url);
  let requested: { resourceDomains?: string[]; connectDomains?: string[]; frameDomains?: string[] } = {};
  try {
    requested = JSON.parse(url.searchParams.get("csp") ?? "{}");
  } catch {
    return new Response("Invalid CSP", { status: 400 });
  }
  const domains = (items: string[] | undefined) => (items ?? []).map(origin).join(" ");
  let resource: string, connect: string, frames: string;
  try {
    resource = domains(requested.resourceDomains);
    connect = domains(requested.connectDomains);
    frames = domains(requested.frameDomains);
  } catch {
    return new Response("Invalid CSP origin", { status: 400 });
  }
  const policy = `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: ${resource}; style-src 'unsafe-inline'; img-src data: blob: ${resource}; font-src data: ${resource}; connect-src ${connect || "'none'"}; frame-src 'self' ${frames}; base-uri 'none'; form-action 'none'; frame-ancestors ${parents.join(" ")}`;
  const safeParents = JSON.stringify(parents).replaceAll("<", "\\u003c");
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;overflow:hidden}</style></head><body><script>
const allowed=${safeParents};let guest;let host;
addEventListener('message',event=>{
 if(event.source===parent&&allowed.includes(event.origin)){
  host=event.origin;
  if(event.data?.method==='ui/notifications/sandbox-resource-ready'){
   if(guest)return;
   guest=document.createElement('iframe');guest.sandbox='allow-scripts allow-same-origin allow-forms';
   guest.srcdoc=event.data.params.html;document.body.appendChild(guest);
  }else if(guest)guest.contentWindow.postMessage(event.data,location.origin);
 }else if(guest&&event.source===guest.contentWindow&&host){parent.postMessage(event.data,host);}
});
parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/sandbox-proxy-ready',params:{}},'*');
</script></body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": policy,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function origin(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.origin !== value) throw new Error("Expected an exact HTTP(S) origin");
  return url.origin;
}
