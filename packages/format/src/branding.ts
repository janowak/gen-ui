import { z } from "zod";

/** How the workspace's connector presents itself to hosts (MCP serverInfo). The icon is uploaded separately. */
export const Branding = z.object({
  title: z.string().min(1).max(80).optional().describe('Display name, e.g. "Acme Support". Default: the workspace name.'),
  description: z.string().min(1).max(500).optional().describe("One or two sentences on what the connector does."),
  websiteUrl: z.url({ protocol: /^https?$/ }).optional(),
});
export type Branding = z.infer<typeof Branding>;

/** Icon formats MCP hosts render. SVG is served with a CSP that blocks scripts. */
export const ICON_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"] as const;
export type IconType = (typeof ICON_TYPES)[number];
export const MAX_ICON_BYTES = 100_000;
