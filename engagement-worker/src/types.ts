/** Shared types for the capture substrate. */

export type RecordResult = { created: boolean };

export type AggregateRow = { target: string; count: number };

/**
 * The engagement store. Two implementations: an in-memory one for tests
 * (`store-memory.ts`) and the D1-backed one for production (`store-d1.ts`).
 *
 * The OWNER of an event = the session's linked `user_id` if it has one, else the
 * session id itself. `aggregate` MUST dedup by owner, so one person's many linked
 * sessions count once — that is what makes account-elevation a re-pointing, not a
 * recount.
 */
export interface EngagementStore {
  /** Idempotently ensure a session row exists. */
  ensureSession(sessionId: string, now: number): Promise<void>;

  /**
   * Idempotently record an engagement event keyed by (session, target, type).
   * Returns `{ created: false }` when the same triple already exists (dedup).
   */
  recordEvent(
    sessionId: string,
    target: string,
    type: string,
    now: number,
  ): Promise<RecordResult>;

  /**
   * Count of unique OWNERS per target for one event type. Targets with no events
   * are returned with `count: 0`. Never exposes session/user identifiers.
   */
  aggregate(targets: string[], type: string): Promise<AggregateRow[]>;

  /**
   * Account-elevation seam (dormant until `identity-optional`): link one or more
   * sessions to a single owner. Idempotent; never rewrites events — only sets
   * `sessions.user_id`, so every existing event re-resolves to the new owner.
   */
  linkSessions(
    sessionIds: string[],
    userId: string,
    now: number,
  ): Promise<void>;
}

/** Matches the Cloudflare rate-limit binding shape; faked in tests. */
export interface RateLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}
