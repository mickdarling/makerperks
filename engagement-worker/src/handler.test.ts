/**
 * Tests for the capture-substrate handler. Run: npm test
 * (node:test + type-stripping; no deploy, no Cloudflare runtime, no extra deps.)
 *
 * Everything I/O is injected, so we exercise dedup, bot/rate/CORS gates, Turnstile
 * escalation, and identity-deduped aggregates against the in-memory store.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest, type HandlerDeps } from "./handler.ts";
import { MemoryStore } from "./store-memory.ts";

const UA =
  "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36";
const ORIGIN = "https://makerperks.com";
const SID_A = "s_" + "a".repeat(32);
const SID_B = "s_" + "b".repeat(32);
const T1 = "vercel/vercel-for-startups";
const T2 = "aws/aws-activate";

const allow = { limit: async () => ({ success: true }) };
const deny = { limit: async () => ({ success: false }) };

function makeDeps(over: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    store: new MemoryStore(),
    ipLimiter: allow,
    sessionLimiter: allow,
    verifyTurnstile: async (token: string) => token === "good",
    allowedOrigins: [ORIGIN, "http://localhost:4321"],
    knownTypes: new Set(["favorite", "redeem"]),
    challengeTypes: new Set(),
    now: () => 1000,
    ...over,
  };
}

function postEvent(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Request {
  return new Request("https://api.test/event", {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "user-agent": UA,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function getAggregate(qs: string): Request {
  return new Request(`https://api.test/aggregate?${qs}`, {
    headers: { origin: ORIGIN, "user-agent": UA },
  });
}

async function countOf(deps: HandlerDeps, target: string): Promise<number> {
  const res = await handleRequest(
    getAggregate(`type=favorite&target=${encodeURIComponent(target)}`),
    deps,
  );
  const { counts } = (await res.json()) as { counts: Record<string, number> };
  return counts[target];
}

test("records an event and counts it", async () => {
  const deps = makeDeps();
  const res = await handleRequest(
    postEvent({ session: SID_A, target: T1, type: "favorite" }),
    deps,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, created: true });
  assert.equal(await countOf(deps, T1), 1);
});

test("repeating the same action is idempotent (dedup)", async () => {
  const deps = makeDeps();
  await handleRequest(
    postEvent({ session: SID_A, target: T1, type: "favorite" }),
    deps,
  );
  const second = await handleRequest(
    postEvent({ session: SID_A, target: T1, type: "favorite" }),
    deps,
  );
  assert.deepEqual(await second.json(), { ok: true, created: false });
  assert.equal(await countOf(deps, T1), 1); // still one, not two
});

test("distinct sessions count distinctly", async () => {
  const deps = makeDeps();
  await handleRequest(
    postEvent({ session: SID_A, target: T1, type: "favorite" }),
    deps,
  );
  await handleRequest(
    postEvent({ session: SID_B, target: T1, type: "favorite" }),
    deps,
  );
  assert.equal(await countOf(deps, T1), 2);
});

test("invalid payloads are rejected", async () => {
  const deps = makeDeps();
  for (const body of [
    { session: "nope", target: T1, type: "favorite" },
    { session: SID_A, target: "Bad Target!", type: "favorite" },
    { session: SID_A, target: T1, type: "unknown-type" },
  ]) {
    const res = await handleRequest(postEvent(body), deps);
    assert.equal(res.status, 400);
  }
});

test("bot / missing user-agent is blocked", async () => {
  const deps = makeDeps();
  const noUa = await handleRequest(
    postEvent(
      { session: SID_A, target: T1, type: "favorite" },
      { "user-agent": "" },
    ),
    deps,
  );
  assert.equal(noUa.status, 403);
  const bot = await handleRequest(
    postEvent(
      { session: SID_A, target: T1, type: "favorite" },
      { "user-agent": "python-requests/2.31" },
    ),
    deps,
  );
  assert.equal(bot.status, 403);
});

test("non-allowlisted origin is rejected", async () => {
  const deps = makeDeps();
  const res = await handleRequest(
    postEvent(
      { session: SID_A, target: T1, type: "favorite" },
      { origin: "https://evil.example" },
    ),
    deps,
  );
  assert.equal(res.status, 403);
});

test("rate limiting (IP or session) returns 429", async () => {
  const ipLimited = await handleRequest(
    postEvent({ session: SID_A, target: T1, type: "favorite" }),
    makeDeps({ ipLimiter: deny }),
  );
  assert.equal(ipLimited.status, 429);
  const sessionLimited = await handleRequest(
    postEvent({ session: SID_A, target: T1, type: "favorite" }),
    makeDeps({ sessionLimiter: deny }),
  );
  assert.equal(sessionLimited.status, 429);
});

test("Turnstile escalation is per event type", async () => {
  const deps = makeDeps({ challengeTypes: new Set(["redeem"]) });
  // challenge-required type without a token → blocked
  const blocked = await handleRequest(
    postEvent({ session: SID_A, target: T1, type: "redeem" }),
    deps,
  );
  assert.equal(blocked.status, 403);
  // same type with a valid token → ok
  const ok = await handleRequest(
    postEvent({
      session: SID_A,
      target: T1,
      type: "redeem",
      turnstileToken: "good",
    }),
    deps,
  );
  assert.equal(ok.status, 200);
  // a non-challenge type still needs no token
  const noChallenge = await handleRequest(
    postEvent({ session: SID_B, target: T1, type: "favorite" }),
    deps,
  );
  assert.equal(noChallenge.status, 200);
});

test("aggregate returns counts only, zero for unseen targets, and rejects bad queries", async () => {
  const deps = makeDeps();
  await handleRequest(
    postEvent({ session: SID_A, target: T1, type: "favorite" }),
    deps,
  );
  const res = await handleRequest(
    getAggregate(
      `type=favorite&target=${encodeURIComponent(T1)}&target=${encodeURIComponent(T2)}`,
    ),
    deps,
  );
  const payload = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(payload, { type: "favorite", counts: { [T1]: 1, [T2]: 0 } });
  // no session/account identifiers leak into the response
  assert.equal(JSON.stringify(payload).includes(SID_A), false);
  // bad queries
  assert.equal(
    (await handleRequest(getAggregate("type=favorite"), deps)).status,
    400,
  ); // no target
  assert.equal(
    (await handleRequest(getAggregate(`type=bogus&target=${T1}`), deps)).status,
    400,
  ); // unknown type
});

test("forward-compat: linking sessions to one account collapses the count (elevation = re-pointing)", async () => {
  const deps = makeDeps();
  // One person favorites the same perk from two anonymous sessions (two devices).
  await handleRequest(
    postEvent({ session: SID_A, target: T1, type: "favorite" }),
    deps,
  );
  await handleRequest(
    postEvent({ session: SID_B, target: T1, type: "favorite" }),
    deps,
  );
  assert.equal(await countOf(deps, T1), 2); // anonymous: two identities

  // They register; both sessions link to one account owner — NO events rewritten.
  await deps.store.linkSessions([SID_A, SID_B], "user_42", deps.now());
  assert.equal(await countOf(deps, T1), 1); // now one identity
});

const SID_C = "s_" + "c".repeat(32);

function deleteEvent(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Request {
  return new Request("https://api.test/event", {
    method: "DELETE",
    headers: {
      origin: ORIGIN,
      "user-agent": UA,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function getReq(path: string): Request {
  return new Request(`https://api.test${path}`, {
    headers: { origin: ORIGIN, "user-agent": UA },
  });
}

test("unfavorite removes the event and drops it from the aggregate", async () => {
  const deps = makeDeps();
  await handleRequest(
    postEvent({ session: SID_A, target: T1, type: "favorite" }),
    deps,
  );
  assert.equal(await countOf(deps, T1), 1);

  const del = await handleRequest(
    deleteEvent({ session: SID_A, target: T1, type: "favorite" }),
    deps,
  );
  assert.equal(del.status, 200);
  assert.deepEqual(await del.json(), { ok: true });
  assert.equal(await countOf(deps, T1), 0);
});

test("unfavorite is idempotent (removing an absent event is a no-op)", async () => {
  const deps = makeDeps();
  const del = await handleRequest(
    deleteEvent({ session: SID_A, target: T1, type: "favorite" }),
    deps,
  );
  assert.equal(del.status, 200);
});

test("DELETE /event is bot- and rate-gated", async () => {
  const bot = await handleRequest(
    deleteEvent(
      { session: SID_A, target: T1, type: "favorite" },
      { "user-agent": "python-requests/2" },
    ),
    makeDeps(),
  );
  assert.equal(bot.status, 403);
  const limited = await handleRequest(
    deleteEvent({ session: SID_A, target: T1, type: "favorite" }),
    makeDeps({ ipLimiter: deny }),
  );
  assert.equal(limited.status, 429);
});

test("GET /mine lists the session's targets, scoped to that session", async () => {
  const deps = makeDeps();
  await handleRequest(
    postEvent({ session: SID_A, target: T1, type: "favorite" }),
    deps,
  );
  await handleRequest(
    postEvent({ session: SID_A, target: T2, type: "favorite" }),
    deps,
  );
  const res = await handleRequest(
    getReq(`/mine?type=favorite&session=${SID_A}`),
    deps,
  );
  const { type, targets } = (await res.json()) as {
    type: string;
    targets: string[];
  };
  assert.equal(type, "favorite");
  assert.deepEqual([...targets].sort(), [T1, T2].sort());

  const empty = await handleRequest(
    getReq(`/mine?type=favorite&session=${SID_B}`),
    deps,
  );
  assert.deepEqual(((await empty.json()) as { targets: string[] }).targets, []);
});

test("GET /mine resolves by owner after linking", async () => {
  const deps = makeDeps();
  await handleRequest(
    postEvent({ session: SID_A, target: T1, type: "favorite" }),
    deps,
  );
  await handleRequest(
    postEvent({ session: SID_B, target: T2, type: "favorite" }),
    deps,
  );
  await deps.store.linkSessions([SID_A, SID_B], "user_77", deps.now());
  const res = await handleRequest(
    getReq(`/mine?type=favorite&session=${SID_A}`),
    deps,
  );
  const { targets } = (await res.json()) as { targets: string[] };
  assert.deepEqual([...targets].sort(), [T1, T2].sort());
});

test("GET /counts returns only at-or-above-min targets, cached", async () => {
  const deps = makeDeps();
  for (const s of [SID_A, SID_B, SID_C])
    await handleRequest(
      postEvent({ session: s, target: T1, type: "favorite" }),
      deps,
    ); // T1 saved by 3
  await handleRequest(
    postEvent({ session: SID_A, target: T2, type: "favorite" }),
    deps,
  ); // T2 saved by 1

  const res = await handleRequest(getReq(`/counts?type=favorite&min=2`), deps);
  assert.match(res.headers.get("cache-control") ?? "", /max-age/);
  const body = (await res.json()) as {
    type: string;
    min: number;
    counts: Record<string, number>;
  };
  assert.deepEqual(body, { type: "favorite", min: 2, counts: { [T1]: 3 } }); // T2 excluded
});

test("GET /counts rejects bad query", async () => {
  const deps = makeDeps();
  assert.equal(
    (await handleRequest(getReq(`/counts?type=bogus&min=1`), deps)).status,
    400,
  );
  assert.equal(
    (await handleRequest(getReq(`/counts?type=favorite&min=0`), deps)).status,
    400,
  );
});
