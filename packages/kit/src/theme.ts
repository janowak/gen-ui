import type { Theme } from "@app-mcp/format";

const TOKENS = [
  ["primary", "--app-mcp-primary"],
  ["primaryForeground", "--app-mcp-primary-foreground"],
  ["accent", "--app-mcp-accent"],
  ["accentForeground", "--app-mcp-accent-foreground"],
] as const;

const CHART = Array.from({ length: 5 }, (_, i) => `--app-mcp-chart-${i + 1}`);

/** Every CSS variable the kit manages on `<html>`. */
export const THEME_VARIABLES = [...TOKENS.map(([, name]) => name), "--app-mcp-radius", ...CHART];

/**
 * The workspace theme as `--app-mcp-*` CSS variables for one color scheme. Only tokens the
 * workspace sets are present, so components keep their own fallbacks: `var(--app-mcp-primary, …)`.
 */
export function themeVariables(theme: Theme | undefined, mode: "light" | "dark"): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!theme) return vars;
  const tokens = theme[mode] ?? {};
  for (const [key, name] of TOKENS) {
    const value = tokens[key];
    if (value) vars[name] = value;
  }
  if (theme.radius) vars["--app-mcp-radius"] = theme.radius;
  tokens.chart?.forEach((color, i) => (vars[CHART[i]!] = color));
  return vars;
}
