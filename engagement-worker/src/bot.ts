/**
 * Lightweight, pure bot heuristics for the write path. Deliberately conservative —
 * dedup + rate limits do the heavy lifting; this only rejects obvious non-browser
 * traffic. Returns a reason for logging when it blocks.
 */

export type BotVerdict = { ok: true } | { ok: false; reason: string };

// Obvious automated clients. Real browsers always send a non-empty UA; favorites are
// browser-initiated, so a missing or crawler UA is a strong signal.
const BOT_UA_RE =
  /\b(bot|crawler|spider|crawl|slurp|headless|python-requests|curl|wget|httpclient|axios|go-http-client)\b/i;

export function botCheck(userAgent: string | null): BotVerdict {
  const ua = (userAgent ?? "").trim();
  if (ua.length === 0) return { ok: false, reason: "missing user-agent" };
  if (BOT_UA_RE.test(ua)) return { ok: false, reason: "automated user-agent" };
  return { ok: true };
}
