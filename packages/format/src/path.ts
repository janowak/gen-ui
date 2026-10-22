/** Reads a dot path ("data.items.0.name") from a value. Empty path returns the value itself. */
export function getPath(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  let current: unknown = value;
  for (const key of path.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Reads an array at `itemsPath`; returns [] when the path does not point at an array. */
export function getItems(value: unknown, itemsPath: string | undefined): unknown[] {
  const items = getPath(value, itemsPath);
  return Array.isArray(items) ? items : [];
}
