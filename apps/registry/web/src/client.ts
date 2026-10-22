import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createAuthClient } from "better-auth/client";

/** oauthProviderClient attaches the signed OAuth query to sign-in and consent requests, so the flow resumes after them. */
export const authClient = createAuthClient({
  baseURL: `${location.origin}/api/auth`,
  plugins: [oauthProviderClient()],
});

/** better-auth answers sign-in and consent with the next URL in the OAuth flow. */
export function follow(data: unknown): boolean {
  const url = (data as { url?: string } | null)?.url;
  if (url) location.href = url;
  return Boolean(url);
}

export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
