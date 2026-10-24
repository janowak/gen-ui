/**
 * The genui view contract: keys the SDK sets in a render tool result's `_meta`, read by the
 * built-in views and by components built with @genui/kit. Keep every `genui/*` key here.
 */

/** Set on registry previews: the view renders without calling tools, which live on the company's own server. */
export const PREVIEW_META_KEY = "genui/preview";

/** The current workspace theme. */
export const THEME_META_KEY = "genui/theme";

/** Stable id of one render. Hosts replay stored results, so a re-rendered message gets the same id. */
export const VIEW_ID_META_KEY = "genui/viewId";

/**
 * Key in a render result's `structuredContent` holding `{ id }`: the same id as `VIEW_ID_META_KEY`,
 * sent in both places until real hosts show which one they replay.
 */
export const VIEW_CONTENT_KEY = "genui";

/** The render id from a tool result: `structuredContent.genui.id`, else `_meta["genui/viewId"]`. */
export function readViewId(result: { structuredContent?: unknown; _meta?: unknown }): string | undefined {
  const content = (result.structuredContent as Record<string, unknown> | undefined)?.[VIEW_CONTENT_KEY] as { id?: unknown } | undefined;
  if (typeof content?.id === "string") return content.id;
  const meta = (result._meta as Record<string, unknown> | undefined)?.[VIEW_ID_META_KEY];
  return typeof meta === "string" ? meta : undefined;
}

/** Key under which use_recipe returns the built form in the result's `_meta`; the form view renders it. */
export const FORM_META_KEY = "genui/form";

/**
 * Version of the component contract above. Components built with @genui/kit declare the version
 * they need in their manifest (`contract`); the SDK skips components that need a newer one.
 */
export const COMPONENT_CONTRACT = 1;
