/**
 * HTTP handling for the capture substrate, with all I/O injected via `deps` so it runs
 * under `node --test` with no Cloudflare runtime. `index.ts` wires the real D1 store,
 * rate-limit bindings, and Turnstile verifier into these deps.
 *
 *   POST /event      { session, target, type, turnstileToken? } → { ok, created }
 *   GET  /aggregate  ?type=favorite&target=a&target=b           → { type, counts }
 *   GET  /                                                       → plain-text help
 */
import { botCheck } from "./bot.ts";
import { validateAggregateQuery, validateEvent } from "./validate.ts";
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
    "access-control-allow-methods": "GET, POST, OPTIONS",
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
POST /event      { session, target, type } -> records a deduplicated engagement event
GET  /aggregate  ?type=favorite&target=ID  -> count of unique identities per target

Anonymous + privacy-first: no PII is stored, only an opaque session id you mint. Writes
are deduplicated and rate-limited. See /privacy on the site.
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

  if (request.method === "POST" && url.pathname === "/event")
    return handleEvent(request, deps, cors);

  return json({ error: "not found" }, 404, cors);
}

async function handleEvent(
  request: Request,
  deps: HandlerDeps,
  cors: Record<string, string>,
): Promise<Response> {
  // Bot gate before any store work.
  const bot = botCheck(request.headers.get("user-agent"));
  if (!bot.ok) return json({ error: "blocked" }, 403, cors);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400, cors);
  }

  const valid = validateEvent(body, deps.knownTypes);
  if (!valid.ok) return json({ error: valid.error }, 400, cors);
  const { session, target, type } = valid.value;

  // Rate limit per IP AND per session — a single browser can't hammer writes even
  // from behind one shared IP.
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const [ipOk, sessionOk] = await Promise.all([
    deps.ipLimiter.limit({ key: ip }),
    deps.sessionLimiter.limit({ key: session }),
  ]);
  if (!ipOk.success || !sessionOk.success)
    return json({ error: "rate limited — slow down" }, 429, cors);

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
