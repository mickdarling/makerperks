# Tasks — Capture substrate (engagement state foundation)

> Backend/infra change: a Cloudflare D1 store + a new `makerperks-engagement` Worker +
> a headless client helper + a privacy disclosure. **No visible design surface** — the
> first design surface (the Save button + popularity counts) lands in `anon-favorites`,
> so `impeccable` is not required here. The only human-facing copy is the `/privacy`
> disclosure (5.2).
>
> **Decisions (from design):** hybrid static + thin edge state (no SSR) · **D1** primary
> store with a **two-table `sessions`/`events` owner indirection** (account-elevation = a
> re-pointing, not a migration) · dedicated `makerperks-engagement` Worker reusing contribute Turnstile/rate-limit/
> CORS · session id **minted on first action, not pageview** · dedup by `(session, target,
> type)` + rate-limit first, **Turnstile reserved** (escalation per type) · aggregate read
> now, scheduled materialization deferred to `anon-favorites` · validate via internal probe.

## 1. Data store (Cloudflare D1)

- [x] 1.1 Create the `engagement-worker/` package (mirror `worker/` layout: `wrangler.toml`,
  `src/`, `package.json`, `tsconfig.json`); add a **D1** binding plus `[vars]` for the CORS
  `ALLOWED_ORIGINS` and rate-limit config, and a `TURNSTILE_SECRET` placeholder (set via
  `wrangler secret`, never committed)
- [x] 1.2 Define the D1 schema/migration as **two tables** so account-elevation is later a
  re-pointing, not a migration: `sessions(session_id PK, user_id NULL, created_at)` and
  `events(session_id FK, target, type, created_at)` with a **UNIQUE index on
  `(session_id, target, type)`** for write-time idempotency. **No PII columns** (email/name
  live in a future `users` table); `user_id` stays NULL until `identity-optional` links it
- [x] 1.3 Wire `wrangler d1 migrations` (apply locally + a documented prod-apply step in
  the worker README)
- [x] 1.4 Implement owner resolution `owner = COALESCE(sessions.user_id, events.session_id)`
  used by "list my X" and aggregate reads, so a future account link collapses a person's
  sessions to one identity with no event rewrite

## 2. Engagement Worker endpoints

- [x] 2.1 Scaffold the `makerperks-engagement` Worker, **reusing** the contribute Worker's
  Turnstile-verify, per-IP rate-limit, and CORS-allowlist utilities (copy/extract, don't
  fork behavior)
- [x] 2.2 `POST /event` — validate `{ session, target, type, turnstileToken? }`, enforce
  CORS + rate limit, **upsert into D1 with idempotent dedup**, persist no PII, return a
  minimal ack
- [x] 2.3 `GET /aggregate` — return the **count of unique owners (identities) per target**
  via owner resolution (1.4), single + batch, exposing counts only (no session/account ids);
  cheap enough to be called by a later materialization job
- [x] 2.4 `GET /` — plain-text help (house pattern from the contribute Worker)

## 3. Dedup, bot-resistance, escalation

- [x] 3.1 Idempotent dedup proven by the unique index — repeated `(session, target, type)`
  writes never inflate the aggregate; aggregates dedup by **owner** (1.4) so linked
  sessions of one person count once
- [x] 3.2 Per-session **and** per-IP rate limits; over-limit writes are rejected and record
  nothing
- [x] 3.3 Reject non-allowlisted origins (CORS) and obvious bots (missing/invalid session,
  UA/velocity heuristics)
- [x] 3.4 **Per-event-type Turnstile escalation**: low-stakes types accept with no
  challenge; types flagged in config require a valid token, others unaffected

## 4. Client session helper (headless, dormant)

- [x] 4.1 First-party session module: **mint the id on first engagement action only**
  (never on pageview), store first-party (localStorage — confirm vs. functional cookie per
  design open-Q), never share with third parties
- [x] 4.2 A `recordEvent(target, type)` helper that lazily mints the session, posts to the
  endpoint, and **degrades to a no-op** when the substrate is unconfigured
- [x] 4.3 Ship the helper **behind a feature flag / env, dormant** — no page wires it up yet
  (first consumer is `anon-favorites`); passive browsing sets nothing

## 5. Privacy, config, build resilience

- [x] 5.1 Config-gate the substrate via env (endpoint URL / enable flag); when empty the
  client is a no-op and the build still succeeds (parallels the analytics disable path)
- [x] 5.2 Update `/privacy` (and `/terms` if needed) to disclose the **functional
  first-party session id + engagement storage**, no third-party sharing; keep the existing
  cookieless-analytics statements accurate
- [x] 5.3 Define + document **retention/TTL** that prunes only **orphan** anonymous
  sessions (`user_id IS NULL`, older than N months) and **never** linked sessions (a linked
  session's history belongs to the account); at minimum a stated policy + a prune stub/cron note

## 6. Verify (probe + tests)

- [x] 6.1 Unit tests (`node:test`, like the contribute Worker) for dedup (same
  session/target idempotent; distinct sessions distinct) and aggregate uniqueness
- [x] 6.2 Tests for rate-limit rejection, CORS rejection, and per-type Turnstile escalation
- [x] 6.3 **End-to-end probe** (Decision 7): mint session → `POST /event` → dedup holds →
  `GET /aggregate` returns the unique-session count, runnable via `wrangler dev`
- [x] 6.4 Confirm `npm run build` succeeds with the substrate unconfigured, plus typecheck
  + lint green across the repo and the new worker
- [x] 6.5 Forward-compat test: link two sessions that each engaged the same target to one
  `user_id`, then assert the aggregate counts them as **one** owner — proving elevation is
  a re-pointing (`UPDATE sessions`) with no event rewrite
