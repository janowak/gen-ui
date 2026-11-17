/**
 * Caps on what one person or workspace can make on the hosted registry, where anyone with Google or GitHub
 * gets a workspace. A self-hosted registry runs without them.
 */
export interface Quotas {
  /** Workspaces a person admins. Being invited into someone else's as a member doesn't count. */
  workspacesPerPerson: number;
  environments: number;
  /** Component names; each keeps all its versions. */
  components: number;
  /** New component versions a workspace may publish in 24 hours. Versions are kept forever. */
  versionsPerDay: number;
  /** Workflows and commands in one environment. */
  workflows: number;
  tokens: number;
  pendingInvites: number;
}

export const HOSTED_QUOTAS: Quotas = {
  workspacesPerPerson: 5,
  environments: 10,
  components: 200,
  versionsPerDay: 300,
  workflows: 200,
  tokens: 50,
  pendingInvites: 50,
};

/** Cloudflare's rate limiting binding (wrangler.jsonc "ratelimits"), or anything shaped like it. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** Request rates, keyed by workspace. Unset: no limit (Node, self-hosted). */
export interface RateLimits {
  /** Changes through the /v1 API: publishing, environments, workflows, tokens… */
  writes?: RateLimiter;
  /** Requests to a workspace's end-user MCP, public and server alike. */
  endUserMcp?: RateLimiter;
}
