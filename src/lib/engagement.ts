/**
 * Headless engagement client for the capture substrate — DORMANT until a component
 * calls it. The first consumer is the favorites UI (`anon-favorites`).
 *
 * Design guarantees (see openspec changes `capture-substrate` + `anon-favorites`):
 * - The anonymous session id is minted ONLY on a deliberate action (favorite/record),
 *   never on import, pageview, or a read — so passive browsing stays cookieless.
 * - First-party only: the id + a favorites mirror + a counts cache live in localStorage
 *   and are never sent to any third party.
 * - No-op when unconfigured (`PUBLIC_ENGAGEMENT_ENDPOINT` empty) or off-DOM, so the
 *   static build succeeds and ships nothing unless a feature wires this up.
 * - Counts are loaded client-side and cached (stale-while-revalidate) — never built or
 *   committed. The server returns only counts at/above the threshold, so any value the
 *   cache holds is displayable.
 */

const ENDPOINT = (import.meta.env.PUBLIC_ENGAGEMENT_ENDPOINT ?? "").replace(
  /\/$/,
  "",
);
// Counts below this are never delivered (the client passes it as the server-side `min`).
const THRESHOLD =
  Math.floor(Number(import.meta.env.PUBLIC_FAVORITES_COUNT_MIN)) || 10;

const SID_KEY = "mp_sid";
const FAVS_KEY = "mp_favs";
const COUNTS_KEY = "mp_counts";
const COUNTS_TTL_MS = 5 * 60 * 1000;
const FAV_TYPE = "favorite";

/** Enabled only when an endpoint is configured AND we're in a browser. */
export function isEngagementEnabled(): boolean {
  return ENDPOINT.length > 0 && typeof window !== "undefined";
}

// ---- localStorage helpers (safe under private mode / quota / SSR) ----
function readLS(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeLS(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

// ---- anonymous session id (mint only on a deliberate action) ----
function getExistingSessionId(): string | null {
  return isEngagementEnabled() ? readLS(SID_KEY) : null;
}
function getOrCreateSessionId(): string {
  const existing = readLS(SID_KEY);
  if (existing) return existing;
  const id = "s_" + crypto.randomUUID().replace(/-/g, "");
  writeLS(SID_KEY, id);
  return id;
}

/**
 * Report an engagement action to Umami (cookieless analytics, loaded site-wide). This
 * is the *analytics* plane (trends, funnels, persona breakdowns) — complementary to the
 * worker's deduped counts (the *product* plane). No-op if Umami isn't present.
 */
function trackUmami(event: string, data?: Record<string, unknown>): void {
  (
    window as unknown as {
      umami?: { track: (e: string, d?: Record<string, unknown>) => void };
    }
  ).umami?.track(event, data);
}

async function send(
  method: string,
  path: string,
  body: unknown,
): Promise<boolean> {
  try {
    const res = await fetch(`${ENDPOINT}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---- favorites (localStorage mirror = instant heart state, offline-friendly) ----
export function getFavorites(): string[] {
  if (!isEngagementEnabled()) return [];
  try {
    const v = JSON.parse(readLS(FAVS_KEY) ?? "[]");
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}
export function isFavorited(target: string): boolean {
  return getFavorites().includes(target);
}
function setFavorites(list: string[]): void {
  writeLS(FAVS_KEY, JSON.stringify([...new Set(list)]));
}

export async function favorite(target: string): Promise<void> {
  if (!isEngagementEnabled()) return;
  setFavorites([...getFavorites(), target]);
  trackUmami("save", { program: target });
  await send("POST", "/event", {
    session: getOrCreateSessionId(),
    target,
    type: FAV_TYPE,
  });
  void refreshCounts();
}

export async function unfavorite(target: string): Promise<void> {
  if (!isEngagementEnabled()) return;
  setFavorites(getFavorites().filter((t) => t !== target));
  trackUmami("unsave", { program: target });
  const session = getExistingSessionId();
  if (session)
    await send("DELETE", "/event", { session, target, type: FAV_TYPE });
  void refreshCounts();
}

/** Toggle and return the NEW saved state (true = now saved). */
export async function toggleFavorite(target: string): Promise<boolean> {
  const next = !isFavorited(target);
  if (next) await favorite(target);
  else await unfavorite(target);
  return next;
}

/** Reconcile the local mirror against the server, within the session (never mints). */
export async function syncMine(): Promise<void> {
  const session = getExistingSessionId();
  if (!session) return;
  try {
    const res = await fetch(
      `${ENDPOINT}/mine?type=${FAV_TYPE}&session=${encodeURIComponent(session)}`,
      { cache: "no-store" },
    );
    if (!res.ok) return;
    const data = (await res.json()) as { targets?: string[] };
    if (Array.isArray(data.targets)) setFavorites(data.targets);
  } catch {
    /* ignore */
  }
}

// ---- popularity counts (stale-while-revalidate; reads never mint a session) ----
type CountsMap = Record<string, number>;
const subscribers = new Set<(counts: CountsMap) => void>();

/** Subscribe to count updates; returns an unsubscribe fn. */
export function onCountsUpdate(cb: (counts: CountsMap) => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/** Counts currently in cache (synchronous). Only at/above-threshold values are present. */
export function getCachedCounts(): CountsMap {
  if (!isEngagementEnabled()) return {};
  try {
    const parsed = JSON.parse(readLS(COUNTS_KEY) ?? "{}") as {
      counts?: CountsMap;
    };
    return parsed.counts ?? {};
  } catch {
    return {};
  }
}
function cacheAgeMs(): number {
  try {
    const parsed = JSON.parse(readLS(COUNTS_KEY) ?? "{}") as { ts?: number };
    return Date.now() - (parsed.ts ?? 0);
  } catch {
    return Infinity;
  }
}

/** Fetch fresh counts, update the cache, and notify subscribers. */
export async function refreshCounts(): Promise<CountsMap> {
  if (!isEngagementEnabled()) return {};
  try {
    // no-store: bypass the browser HTTP cache so the client SWR (localStorage) is the
    // single cache authority; the edge still serves its cached copy for scale.
    const res = await fetch(
      `${ENDPOINT}/counts?type=${FAV_TYPE}&min=${THRESHOLD}`,
      { cache: "no-store" },
    );
    if (!res.ok) return getCachedCounts();
    const data = (await res.json()) as { counts?: CountsMap };
    const counts = data.counts ?? {};
    writeLS(COUNTS_KEY, JSON.stringify({ counts, ts: Date.now() }));
    for (const cb of subscribers) cb(counts);
    return counts;
  } catch {
    return getCachedCounts();
  }
}

/** Return cached counts immediately and revalidate in the background if stale. */
export function loadCounts(): CountsMap {
  if (!isEngagementEnabled()) return {};
  if (cacheAgeMs() > COUNTS_TTL_MS) void refreshCounts();
  return getCachedCounts();
}

/** Generic primitive kept for future non-favorite event types. */
export async function recordEvent(
  target: string,
  type: string,
): Promise<boolean> {
  if (!isEngagementEnabled()) return false;
  return send("POST", "/event", {
    session: getOrCreateSessionId(),
    target,
    type,
  });
}
