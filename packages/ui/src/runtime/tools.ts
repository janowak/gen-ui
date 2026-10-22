import type { App } from "@modelcontextprotocol/ext-apps";

export interface ToolCallOutcome {
  /** `structuredContent`, or the first text block parsed as JSON. */
  data: unknown;
  /** Concatenated text content, for messages and errors. */
  text: string;
  isError: boolean;
}

interface ToolResultLike {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export function readToolResult(result: ToolResultLike): ToolCallOutcome {
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
  return { data, text, isError: result.isError === true };
}

/** Calls a tool on the view's own server. Protocol errors become `isError` outcomes. */
export async function callTool(
  app: App,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolCallOutcome> {
  try {
    const result = await app.callServerTool({ name, arguments: args }, { signal });
    return readToolResult(result as ToolResultLike);
  } catch (error) {
    if (signal?.aborted) throw error;
    return { data: undefined, text: error instanceof Error ? error.message : String(error), isError: true };
  }
}
