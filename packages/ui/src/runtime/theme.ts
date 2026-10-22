import { Theme, type ThemeTokens } from "@genui/format";

/**
 * shadcn token ← MCP Apps host variable. shadcn's generated styles.css stays untouched:
 * tokens the host provides are pointed at the host variable with inline styles on <html>.
 */
const HOST_TOKENS: [string, string][] = [
  ["--background", "--color-background-primary"],
  ["--foreground", "--color-text-primary"],
  ["--card", "--color-background-primary"],
  ["--card-foreground", "--color-text-primary"],
  ["--popover", "--color-background-primary"],
  ["--popover-foreground", "--color-text-primary"],
  ["--primary", "--color-background-inverse"],
  ["--primary-foreground", "--color-text-inverse"],
  ["--secondary", "--color-background-secondary"],
  ["--secondary-foreground", "--color-text-primary"],
  ["--muted", "--color-background-secondary"],
  ["--muted-foreground", "--color-text-secondary"],
  ["--accent", "--color-background-tertiary"],
  ["--accent-foreground", "--color-text-primary"],
  ["--destructive", "--color-text-danger"],
  ["--border", "--color-border-primary"],
  ["--input", "--color-border-primary"],
  ["--ring", "--color-ring-primary"],
  ["--radius", "--border-radius-md"],
];

const WORKSPACE_TOKENS: [keyof Omit<ThemeTokens, "chart">, string][] = [
  ["primary", "--primary"],
  ["primaryForeground", "--primary-foreground"],
  ["accent", "--accent"],
  ["accentForeground", "--accent-foreground"],
];

const CHART_VARS = Array.from({ length: 5 }, (_, i) => `--chart-${i + 1}`);
const MANAGED = new Set([...HOST_TOKENS.map(([token]) => token), ...CHART_VARS]);

/**
 * Resolves view theming, lowest to highest precedence:
 * shadcn defaults (styles.css) → host style variables → workspace theme.
 * Dark mode uses shadcn's `.dark` class.
 */
export function applyTheme(options: { mode: "light" | "dark"; hostVariables?: Record<string, string | undefined>; workspace?: unknown }): void {
  const root = document.documentElement;
  root.classList.toggle("dark", options.mode === "dark");
  for (const name of MANAGED) root.style.removeProperty(name);

  for (const [token, hostVar] of HOST_TOKENS) {
    if (options.hostVariables?.[hostVar]) root.style.setProperty(token, `var(${hostVar})`);
  }

  const parsed = Theme.safeParse(options.workspace);
  if (!parsed.success) return;
  const theme = parsed.data;
  const tokens = theme[options.mode] ?? {};
  if (theme.radius) root.style.setProperty("--radius", theme.radius);
  for (const [key, cssVar] of WORKSPACE_TOKENS) {
    const value = tokens[key];
    if (value) root.style.setProperty(cssVar, value);
  }
  tokens.chart?.forEach((color, i) => root.style.setProperty(`--chart-${i + 1}`, color));
}
