import type { ChartSpec, FormSpec } from "@genui/format";

export interface AllowTools {
  /** Tools a view may call to load data (resource selects, chart sources). */
  sources?: string[];
  /** Tools a form may call on submit. */
  submit?: string[];
}

export type Check = { ok: true; tools: string[] } | { ok: false; error: string };

function list(names: string[] | undefined): string {
  return names?.length ? names.join(", ") : "none";
}

/**
 * The model chooses tool names at runtime. Only tools the server owner allowlisted may be
 * called from a view, so a manipulated model cannot wire a form to an arbitrary tool.
 */
export function checkForm(spec: FormSpec, allow: AllowTools): Check {
  const tools = new Set<string>();
  for (const field of spec.fields) {
    if (field.type !== "resource_select" && field.type !== "resource_multiselect") continue;
    const name = field.source.toolName;
    if (!allow.sources?.includes(name)) {
      return { ok: false, error: `Field "${field.name}": tool "${name}" is not an allowed option source. Allowed: ${list(allow.sources)}.` };
    }
    tools.add(name);
  }
  if (spec.submit) {
    const name = spec.submit.toolName;
    if (!allow.submit?.includes(name)) {
      return { ok: false, error: `Submit tool "${name}" is not allowed. Allowed: ${list(allow.submit)}.` };
    }
    tools.add(name);
  }
  return { ok: true, tools: [...tools] };
}

export function checkChart(spec: ChartSpec, allow: AllowTools): Check {
  if (!("source" in spec.data)) return { ok: true, tools: [] };
  const name = spec.data.source.toolName;
  if (!allow.sources?.includes(name)) {
    return { ok: false, error: `Tool "${name}" is not an allowed chart source. Allowed: ${list(allow.sources)}.` };
  }
  return { ok: true, tools: [name] };
}
