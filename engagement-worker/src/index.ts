/**
 * MakerPerks engagement Worker — the capture substrate.
 *
 * Anonymous, deduplicated, bot-resistant engagement state at the edge (D1). Records
 * favorite/redeem events keyed by an opaque client-minted session id and serves
 * identity-deduplicated aggregate counts. No PII is ever stored — only the session id,
 * target, type, and timestamp. See README.md and /privacy on the site.
 */
import { handleRequest, type HandlerDeps } from "./handler.ts";
import { D1Store } from "./store-d1.ts";
import { parseTypeSet } from "./validate.ts";
import type { RateLimiter } from "./types.ts";

interface Env {
  DB: D1Database;
  TURNSTILE_SECRET: string;
  ALLOWED_ORIGINS: string;
  EVENT_TYPES: string;
  CHALLENGE_EVENT_TYPES: string;
  RATE_LIMITER_IP: RateLimiter;
  RATE_LIMITER_SESSION: RateLimiter;
}

async function verifyTurnstile(
  secret: string,
  token: string,
  ip: string,
): Promise<boolean> {
  if (!token) return false;
  const res = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token, remoteip: ip }),
    },
  );
  if (!res.ok) return false;
  return Boolean(((await res.json()) as { success?: boolean }).success);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const deps: HandlerDeps = {
      store: new D1Store(env.DB),
      ipLimiter: env.RATE_LIMITER_IP,
      sessionLimiter: env.RATE_LIMITER_SESSION,
      verifyTurnstile: (token, ip) =>
        verifyTurnstile(env.TURNSTILE_SECRET, token, ip),
      allowedOrigins: (env.ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      knownTypes: parseTypeSet(env.EVENT_TYPES),
      challengeTypes: parseTypeSet(env.CHALLENGE_EVENT_TYPES),
      now: () => Date.now(),
    };
    return handleRequest(request, deps);
  },
};
