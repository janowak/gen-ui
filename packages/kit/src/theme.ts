import type { Theme } from "@app-mcp/format";

const TOKENS = [
  ["primary", "--genui-primary"],
  ["primaryForeground", "--genui-primary-foreground"],
  ["accent", "--genui-accent"],
  ["accentForeground", "--genui-accent-foreground"],
] as const;

const CHART = Array.from({ length: 5 }, (_, i) => `--genui-chart-${i + 1}`);

/** Every CSS variable the kit manages on `<html>`. */
export const THEME_VARIABLES = [...TOKENS.map(([, name]) => name), "--genui-radius", ...CHART];

/**
 * The workspace theme as `--genui-*` CSS variables for one color scheme. Only tokens the
 * workspace sets are present, so components keep their own fallbacks: `var(--genui-primary, …)`.
 */
export function themeVariables(theme: Theme | undefined, mode: "light" | "dark"): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!theme) return vars;
  const tokens = theme[mode] ?? {};
  for (const [key, name] of TOKENS) {
    const value = tokens[key];
    if (value) vars[name] = value;
  }
  if (theme.radius) vars["--genui-radius"] = theme.radius;
  tokens.chart?.forEach((color, i) => (vars[CHART[i]!] = color));
  return vars;
}
