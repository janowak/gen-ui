import { z } from "zod";

const color = z.string().describe("Any CSS color.");

export const ThemeTokens = z.object({
  primary: color.optional(),
  primaryForeground: color.optional(),
  accent: color.optional(),
  accentForeground: color.optional(),
  chart: z.array(color).max(5).optional().describe("Chart palette, in series order."),
});
export type ThemeTokens = z.infer<typeof ThemeTokens>;

/** Workspace theme. Unset tokens inherit the host's style variables, then the built-in defaults. */
export const Theme = z.object({
  radius: z.string().optional().describe('Corner radius, e.g. "0.5rem".'),
  light: ThemeTokens.optional(),
  dark: ThemeTokens.optional(),
});
export type Theme = z.infer<typeof Theme>;

/** Key under which the SDK attaches the current theme to `render_*` tool results' `_meta`. */
export const THEME_META_KEY = "genui/theme";
