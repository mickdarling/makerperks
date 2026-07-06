/**
 * Headless engagement client for the capture substrate — DORMANT until a page calls it.
 *
 * Design guarantees (see openspec change `capture-substrate`):
 * - The anonymous session id is minted ONLY on a deliberate action (first `recordEvent`),
 *   never on import or pageview — so passive browsing stays cookieless and id-free.
 * - First-party only: the id lives in localStorage and is never sent to any third party.
 * - No-op when unconfigured (`PUBLIC_ENGAGEMENT_ENDPOINT` empty) or off-DOM, so the static
 *   build succeeds on forks/CI and ships nothing unless a feature wires this up.
 *
 * No page imports this yet; the first consumer is the `anon-favorites` change.
 */

const ENDPOINT = (import.meta.env.PUBLIC_ENGAGEMENT_ENDPOINT ?? "").replace(
  /\/$/,
  "",
);
const STORAGE_KEY = "mp_sid";

/** Enabled only when an endpoint is configured AND we're in a browser. */
export function isEngagementEnabled(): boolean {
  return ENDPOINT.length > 0 && typeof window !== "undefined";
}

/** Read the existing session id, or mint+persist one. Call ONLY from an action. */
function getOrCreateSessionId(): string {
  const existing = window.localStorage.getItem(STORAGE_KEY);
  if (existing) return existing;
  const id = "s_" + crypto.randomUUID().replace(/-/g, "");
  window.localStorage.setItem(STORAGE_KEY, id);
  return id;
}

/**
 * Record a deliberate engagement action (e.g. ("vercel/...", "favorite")). Mints the
 * session id on first use. Returns true if the server accepted it; false (no throw) when
 * disabled or on any network error — callers stay simple and optimistic.
 */
export async function recordEvent(
  target: string,
  type: string,
): Promise<boolean> {
  if (!isEngagementEnabled()) return false;
  try {
    const session = getOrCreateSessionId();
    const res = await fetch(`${ENDPOINT}/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session, target, type }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Read identity-deduplicated counts for one or more targets. Returns {} when disabled or
 * on error. Does NOT mint a session id (reads are anonymous).
 */
export async function getCounts(
  targets: string[],
  type: string,
): Promise<Record<string, number>> {
  if (!isEngagementEnabled() || targets.length === 0) return {};
  try {
    const params = new URLSearchParams({ type });
    for (const t of targets) params.append("target", t);
    const res = await fetch(`${ENDPOINT}/aggregate?${params.toString()}`);
    if (!res.ok) return {};
    const data = (await res.json()) as { counts?: Record<string, number> };
    return data.counts ?? {};
  } catch {
    return {};
  }
}
