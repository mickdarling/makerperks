/**
 * Pure payload validation for engagement writes and aggregate reads. No I/O, no
 * globals — fully unit-testable.
 */

// Opaque, client-minted session id: "s_" + 32 hex (see the site's engagement helper).
const SESSION_RE = /^s_[a-f0-9]{24,64}$/;

// A target is a program id like "vercel/vercel-for-startups": lowercase slug chars,
// optional single slash segments. Bounded so a bad client can't store junk.
const TARGET_RE = /^[a-z0-9](?:[a-z0-9._-]|\/(?=[a-z0-9])){0,127}$/;

export const MAX_BATCH = 100;

export type EventInput = { session: string; target: string; type: string };

export type Valid<T> = { ok: true; value: T } | { ok: false; error: string };

/** Validate a POST /event body against the known event types. */
export function validateEvent(
  body: unknown,
  knownTypes: Set<string>,
): Valid<EventInput> {
  if (typeof body !== "object" || body === null)
    return { ok: false, error: "body must be an object" };
  const { session, target, type } = body as Record<string, unknown>;

  if (typeof session !== "string" || !SESSION_RE.test(session))
    return { ok: false, error: "invalid session" };
  if (typeof target !== "string" || !TARGET_RE.test(target))
    return { ok: false, error: "invalid target" };
  if (typeof type !== "string" || !knownTypes.has(type))
    return { ok: false, error: "unknown event type" };

  return { ok: true, value: { session, target, type } };
}

/** Validate the GET /aggregate query (targets + a single known type). */
export function validateAggregateQuery(
  targets: string[],
  type: string | null,
  knownTypes: Set<string>,
): Valid<{ targets: string[]; type: string }> {
  if (type === null || !knownTypes.has(type))
    return { ok: false, error: "unknown event type" };
  if (targets.length === 0)
    return { ok: false, error: "at least one target is required" };
  if (targets.length > MAX_BATCH)
    return { ok: false, error: `at most ${MAX_BATCH} targets per request` };
  for (const t of targets)
    if (!TARGET_RE.test(t)) return { ok: false, error: `invalid target: ${t}` };

  // De-dupe targets so the SQL IN-list and the response are clean.
  return { ok: true, value: { targets: [...new Set(targets)], type } };
}

/** Default cap on how many targets the bulk counts read returns. */
export const COUNTS_CAP = 1000;

/** Validate the GET /mine query (a session + a single known type). */
export function validateMineQuery(
  session: string | null,
  type: string | null,
  knownTypes: Set<string>,
): Valid<{ session: string; type: string }> {
  if (session === null || !SESSION_RE.test(session))
    return { ok: false, error: "invalid session" };
  if (type === null || !knownTypes.has(type))
    return { ok: false, error: "unknown event type" };
  return { ok: true, value: { session, type } };
}

/** Validate the GET /counts query (a known type + an integer min >= 1). */
export function validateCountsQuery(
  type: string | null,
  minRaw: string | null,
  knownTypes: Set<string>,
): Valid<{ type: string; min: number }> {
  if (type === null || !knownTypes.has(type))
    return { ok: false, error: "unknown event type" };
  const min = Number(minRaw ?? "1");
  if (!Number.isInteger(min) || min < 1)
    return { ok: false, error: "min must be an integer >= 1" };
  return { ok: true, value: { type, min } };
}

/** Parse a comma-separated env list into a Set, dropping blanks. */
export function parseTypeSet(csv: string | undefined): Set<string> {
  return new Set(
    (csv ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}
