export type ToolOutcome =
  | { ok: true; data: unknown; text: string }
  | {
      ok: false;
      /** Readable reason, for the UI or the model. */
      error: string;
      /** The tool was never called: a registry preview, or a failed or cancelled render. */
      unavailable: boolean;
      data: unknown;
      text: string;
    };

interface ToolResultLike {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** `structuredContent`, or the text content parsed as JSON; `isError` results become `ok: false`. */
export function readToolResult(name: string, result: ToolResultLike): ToolOutcome {
  const text = (result.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
  let data: unknown = result.structuredContent;
  if (data === undefined && text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }
  if (result.isError === true) return { ok: false, error: text || `${name} failed.`, unavailable: false, data, text };
  return { ok: true, data, text };
}

export function unavailable(name: string, reason: string): ToolOutcome {
  return { ok: false, error: `${name} was not called. ${reason}`, unavailable: true, data: undefined, text: "" };
}
