/**
 * D1-backed EngagementStore. The owner indirection lives in the aggregate SQL:
 * `COUNT(DISTINCT COALESCE(s.user_id, e.session_id))` — so linking a session to an
 * account (setting sessions.user_id) re-resolves its events with zero event rewrites.
 */
import type { AggregateRow, EngagementStore, RecordResult } from "./types.ts";

export class D1Store implements EngagementStore {
  constructor(private db: D1Database) {}

  async ensureSession(sessionId: string, now: number): Promise<void> {
    await this.db
      .prepare(
        "INSERT OR IGNORE INTO sessions (session_id, created_at) VALUES (?1, ?2)",
      )
      .bind(sessionId, now)
      .run();
  }

  async recordEvent(
    sessionId: string,
    target: string,
    type: string,
    now: number,
  ): Promise<RecordResult> {
    await this.ensureSession(sessionId, now);
    // INSERT OR IGNORE → changes() is 1 on a fresh row, 0 when the (session,target,type)
    // PRIMARY KEY already exists. That is our idempotency.
    const res = await this.db
      .prepare(
        "INSERT OR IGNORE INTO events (session_id, target, type, created_at) VALUES (?1, ?2, ?3, ?4)",
      )
      .bind(sessionId, target, type, now)
      .run();
    return { created: (res.meta?.changes ?? 0) > 0 };
  }

  async aggregate(targets: string[], type: string): Promise<AggregateRow[]> {
    if (targets.length === 0) return [];
    const placeholders = targets.map((_, i) => `?${i + 2}`).join(", ");
    const sql =
      "SELECT e.target AS target, " +
      "COUNT(DISTINCT COALESCE(s.user_id, e.session_id)) AS count " +
      "FROM events e JOIN sessions s ON s.session_id = e.session_id " +
      `WHERE e.type = ?1 AND e.target IN (${placeholders}) ` +
      "GROUP BY e.target";
    const { results } = await this.db
      .prepare(sql)
      .bind(type, ...targets)
      .all<{ target: string; count: number }>();

    const found = new Map(results.map((r) => [r.target, r.count]));
    // Always return a row per requested target (0 when it has no events).
    return targets.map((target) => ({ target, count: found.get(target) ?? 0 }));
  }

  async linkSessions(
    sessionIds: string[],
    userId: string,
    now: number,
  ): Promise<void> {
    const stmts = sessionIds.flatMap((id) => [
      this.db
        .prepare(
          "INSERT OR IGNORE INTO sessions (session_id, created_at) VALUES (?1, ?2)",
        )
        .bind(id, now),
      this.db
        .prepare("UPDATE sessions SET user_id = ?1 WHERE session_id = ?2")
        .bind(userId, id),
    ]);
    if (stmts.length) await this.db.batch(stmts);
  }
}
