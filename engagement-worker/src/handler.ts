/**
 * HTTP handling for the capture substrate, with all I/O injected via `deps` so it runs
 * under `node --test` with no Cloudflare runtime. `index.ts` wires the real D1 store,
 * rate-limit bindings, and Turnstile verifier into these deps.
 *
 *   POST   /event      { session, target, type, turnstileToken? } → { ok, created }
 *   DELETE /event      { session, target, type }                  → { ok }       (unfavorite)
 *   GET    /aggregate  ?type=favorite&target=a&target=b           → { type, counts }
 *   GET    /mine       ?type=favorite&session=s_…                 → { type, targets }
 *   GET    /counts     ?type=favorite&min=10                      → { type, min, counts } (cached)
 *   GET    /                                                      → plain-text help
 */
import { botCheck } from "./bot.ts";
import {
  COUNTS_CAP,
  validateAggregateQuery,
  validateCountsQuery,
  validateEvent,
  validateMineQuery,
} from "./validate.ts";
import type { EngagementStore, RateLimiter } from "./types.ts";

export interface HandlerDeps {
  store: EngagementStore;
  ipLimiter: RateLimiter;
  sessionLimiter: RateLimiter;
  verifyTurnstile: (token: string, ip: string) => Promise<boolean>;
  allowedOrigins: string[];
  knownTypes: Set<string>;
  challengeTypes: Set<string>;
  now: () => number;
}

function corsHeaders(
  origin: string | null,
  allowed: string[],
): Record<string, string> {
  const ok = origin !== null && allowed.includes(origin);
  return {
    "access-control-allow-origin": ok ? origin : (allowed[0] ?? ""),
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

function json(
  body: unknown,
  status: number,
  cors: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...cors },
  });
}

const HELP = `MakerPerks engagement API
=========================
POST   /event      { session, target, type } -> record a deduplicated engagement event
DELETE /event      { session, target, type } -> remove your event (unfavorite)
GET    /aggregate  ?type=favorite&target=ID  -> count of unique identities per target
GET    /mine       ?type=favorite&session=…  -> the targets your session engaged
GET    /counts     ?type=favorite&min=10     -> popular targets (count >= min), cached

Anonymous + privacy-first: no PII is stored, only an opaque session id you mint. Writes
are deduplicated and rate-limited. Popularity counts are deduplicated by identity. See
/privacy on the site.
`;

export async function handleRequest(
  request: Request,
  deps: HandlerDeps,
): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  const cors = corsHeaders(origin, deps.allowedOrigins);

  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers: cors });

  if (request.method === "GET" && url.pathname === "/")
    return new Response(HELP, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });

  // CORS: browser calls always send Origin; reject non-allowlisted origins.
  if (origin !== null && !deps.allowedOrigins.includes(origin))
    return json({ error: "origin not allowed" }, 403, cors);

  if (request.method === "GET" && url.pathname === "/aggregate")
    return handleAggregate(url, deps, cors);

  if (request.method === "GET" && url.pathname === "/mine")
    return handleMine(url, deps, cors);

  if (request.method === "GET" && url.pathname === "/counts")
    return handleCounts(url, deps, cors);

  if (request.method === "POST" && url.pathname === "/event")
    return handleEvent(request, deps, cors);

  if (request.method === "DELETE" && url.pathname === "/event")
    return handleRemove(request, deps, cors);

  return json({ error: "not found" }, 404, cors);
}

/** Bot gate — reject obvious non-browser traffic before any store work. */
function botGate(
  request: Request,
  cors: Record<string, string>,
): Response | null {
  return botCheck(request.headers.get("user-agent")).ok
    ? null
    : json({ error: "blocked" }, 403, cors);
}

/** Per-IP AND per-session rate gate for writes. */
async function rateGate(
  deps: HandlerDeps,
  ip: string,
  session: string,
  cors: Record<string, string>,
): Promise<Response | null> {
  const [ipOk, sessionOk] = await Promise.all([
    deps.ipLimiter.limit({ key: ip }),
    deps.sessionLimiter.limit({ key: session }),
  ]);
  return ipOk.success && sessionOk.success
    ? null
    : json({ error: "rate limited — slow down" }, 429, cors);
}

async function handleEvent(
  request: Request,
  deps: HandlerDeps,
  cors: Record<string, string>,
): Promise<Response> {
  const blocked = botGate(request, cors);
  if (blocked) return blocked;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400, cors);
  }

  const valid = validateEvent(body, deps.knownTypes);
  if (!valid.ok) return json({ error: valid.error }, 400, cors);
  const { session, target, type } = valid.value;

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const limited = await rateGate(deps, ip, session, cors);
  if (limited) return limited;

  // Escalation: only event types configured as challenge-required need Turnstile; a
  // low-stakes favorite does not.
  if (deps.challengeTypes.has(type)) {
    const token = String(
      (body as Record<string, unknown>).turnstileToken ?? "",
    );
    const human = await deps.verifyTurnstile(token, ip);
    if (!human) return json({ error: "human verification failed" }, 403, cors);
  }

  const { created } = await deps.store.recordEvent(
    session,
    target,
    type,
    deps.now(),
  );
  return json({ ok: true, created }, 200, cors);
}

async function handleRemove(
  request: Request,
  deps: HandlerDeps,
  cors: Record<string, string>,
): Promise<Response> {
  const blocked = botGate(request, cors);
  if (blocked) return blocked;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400, cors);
  }

  const valid = validateEvent(body, deps.knownTypes);
  if (!valid.ok) return json({ error: valid.error }, 400, cors);
  const { session, target, type } = valid.value;

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const limited = await rateGate(deps, ip, session, cors);
  if (limited) return limited;

  // Removing your own favorite needs no Turnstile — it cannot inflate a count.
  await deps.store.removeEvent(session, target, type);
  return json({ ok: true }, 200, cors);
}

async function handleAggregate(
  url: URL,
  deps: HandlerDeps,
  cors: Record<string, string>,
): Promise<Response> {
  // Accept repeated ?target= and/or a comma list ?targets=a,b.
  const targets = [
    ...url.searchParams.getAll("target"),
    ...(url.searchParams.get("targets")?.split(",") ?? []),
  ]
    .map((t) => t.trim())
    .filter(Boolean);

  const valid = validateAggregateQuery(
    targets,
    url.searchParams.get("type"),
    deps.knownTypes,
  );
  if (!valid.ok) return json({ error: valid.error }, 400, cors);

  const rows = await deps.store.aggregate(
    valid.value.targets,
    valid.value.type,
  );
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.target] = r.count;
  return json({ type: valid.value.type, counts }, 200, cors);
}

async function handleMine(
  url: URL,
  deps: HandlerDeps,
  cors: Record<string, string>,
): Promise<Response> {
  const valid = validateMineQuery(
    url.searchParams.get("session"),
    url.searchParams.get("type"),
    deps.knownTypes,
  );
  if (!valid.ok) return json({ error: valid.error }, 400, cors);

  const targets = await deps.store.listBySession(
    valid.value.session,
    valid.value.type,
  );
  return json({ type: valid.value.type, targets }, 200, cors);
}

async function handleCounts(
  url: URL,
  deps: HandlerDeps,
  cors: Record<string, string>,
): Promise<Response> {
  const valid = validateCountsQuery(
    url.searchParams.get("type"),
    url.searchParams.get("min"),
    deps.knownTypes,
  );
  if (!valid.ok) return json({ error: valid.error }, 400, cors);

  const rows = await deps.store.bulkCounts(
    valid.value.type,
    valid.value.min,
    COUNTS_CAP,
  );
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.target] = r.count;
  // Edge-cacheable: a per-visitor counts load becomes a CDN hit, not a D1 query.
  return new Response(
    JSON.stringify({ type: valid.value.type, min: valid.value.min, counts }),
    {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        // Browser must revalidate (so a just-saved count isn't masked by the HTTP
        // cache); the edge/CDN still caches for 5 min via s-maxage (scale preserved).
        "cache-control": "public, max-age=0, s-maxage=300",
        ...cors,
      },
    },
  );
}
