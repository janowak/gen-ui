import { SEMVER } from "@genui/format";

export function parseSemver(version: string): [number, number, number] {
  const match = SEMVER.exec(version);
  if (!match) throw new Error(`Invalid version "${version}"`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareSemver(a: string, b: string): number {
  const [x, y] = [parseSemver(a), parseSemver(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

interface ObjectSchema {
  properties?: Record<string, unknown>;
  required?: string[];
}

/**
 * Props changes that break existing callers (the model, pinned consumers):
 * a removed property, or a newly required one. These need a major version bump.
 */
export function breakingChanges(previous: ObjectSchema, next: ObjectSchema): string[] {
  const issues: string[] = [];
  const prevProps = Object.keys(previous.properties ?? {});
  const nextProps = new Set(Object.keys(next.properties ?? {}));
  for (const name of prevProps) if (!nextProps.has(name)) issues.push(`removed prop "${name}"`);
  const prevRequired = new Set(previous.required ?? []);
  for (const name of next.required ?? []) if (!prevRequired.has(name)) issues.push(`newly required prop "${name}"`);
  return issues;
}
