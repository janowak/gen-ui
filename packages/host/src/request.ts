/** UI HTML and host-only result metadata stay in the browser/persistence store, not the next model request. */
export function stripUiResources(body: string): string {
  const parsed = JSON.parse(body) as { messages?: unknown[] };
  if (!Array.isArray(parsed.messages)) return body;
  return JSON.stringify({
    ...parsed,
    messages: parsed.messages.map((message) =>
      JSON.parse(JSON.stringify(message, (key, value) => (key === "uiResources" ? undefined : value))),
    ),
  });
}
