# Design — Capture substrate (engagement state foundation)

## Context

MakerPerks is a static Astro site: one schema-validated YAML file per program, served
from a CDN, edited through PRs, with no application backend. Its only dynamic pieces are
Cloudflare Workers for per-request jobs (the `makerperks-contribute` Worker opens
submission PRs; `mcp-worker` serves the agent endpoints) and two client-side analytics
scripts (cookieless Umami for pageviews/redeem-click events; consented Apollo for
company identity). There is **no place to store user-generated state** — favorites,
per-perk popularity, identity, or anything a return visitor would expect us to remember.

This change adds that layer and nothing else. It is the dependency root of the
engagement decomposition (`capture-substrate` → `anon-favorites` → `identity-optional` →
`ai-assist` → `structured-feedback`) recorded in the studio decision log (2026-06-30).
The governing constraints from that decision: **hybrid static + thin edge state**
(no SSR), **anonymous-by-default**, **consent-for-value** for sensitive inputs (a later
change), **reuse existing instrumentation** (don't rebuild what Umami already counts),
and **honest counts** (dedup + bot-resistance) because the brand is the Trusted Ledger.

## Goals / Non-Goals

**Goals:**

- A durable, low-cost edge store for small engagement records, reachable from the static
  site without converting it to SSR.
- An **anonymous** session identity that does not exist for passive visitors — minted
  only when a user takes a deliberate engagement action.
- A write path that is **deduplicated and bot-resistant by construction**, so every count
  later built on it is honest.
- An aggregate read path that lets per-target counts be materialized back into the static
  build / `llms.txt` later (the freshness flow's write-back pattern).
- Preserve today's cookieless, consent-free posture for anyone who only browses.
- Be thin: build only what the first consumer (`anon-favorites`) needs.

**Non-Goals:**

- Any user-facing feature — no favorites UI, no counts display, no accounts, no email,
  no AI-assist. Those are later changes; this one ships the substrate.
- Storing any PII or sensitive input (build descriptions, URLs). The substrate stores an
  opaque session id + engagement events only.
- Replacing Umami. Umami remains the analytics-plane source of truth for click/pageview
  trends; the substrate is the product-state plane.
- SSR / a standing server / a relational app backend beyond a single small DB.

## Decisions

### Decision 1 — Hybrid static + thin edge state (not SSR)

The site stays static and CDN-served. Engagement state lives behind a Cloudflare Worker.
*Live* per-session reads/writes happen at the edge; *aggregate* state (popularity counts)
is later materialized back into the static build on a schedule — the exact write-back
shape the perk-freshness flow already uses. **Alternative rejected:** Astro SSR / a real
backend — it would deliver the same features but forfeit the static, PR-editable,
agent-cacheable identity that is core to the product. The contribute Worker proves the
"static site + Worker for the dynamic 5%" pattern works here.

### Decision 2 — Cloudflare D1 as the primary store, with a session→owner indirection

Primary store = **D1** (SQLite at the edge). Rationale: the roadmap is relational —
favorites today, then accounts, comments, and AI-assist inputs that join to sessions and
perks. **Two tables from day one**, so account-elevation is later a re-pointing rather
than a migration (see Decision 8):

- `sessions(session_id PK, user_id NULL, created_at)` — one row per anonymous session;
  `user_id` stays NULL until the visitor registers and links it (a future `users` table
  holds the email/PII, never this table).
- `events(session_id FK, target, type, created_at)` with a **UNIQUE index on
  `(session_id, target, type)`** for write-time idempotency.

The logical **owner of an event = `COALESCE(sessions.user_id, events.session_id)`**;
"list my favorites" and every aggregate resolve through the owner, so one person's many
sessions collapse to a single identity the moment they link. Elevation is then a single
`UPDATE sessions SET user_id=… WHERE session_id IN (…)` — events are never rewritten.

**Alternatives considered:** *KV* — great for blobs/caching but last-write-wins (bad for
atomic counters) and awkward for relational growth; *Durable Objects* — strong per-entity
consistency, ideal for hot counters, heavier than needed for v1; *keying events directly
on an owner id that is rewritten on merge* — forces a batch row-rewrite plus a
unique-constraint repair on every account link, exactly the migration the indirection
avoids. Lean: D1 primary now; if counter write-throughput ever gets hot, move *counts
only* to a Durable Object or KV cache — a localized change. (The decision log delegated
this low-level pick to design; this is where it's committed.)

### Decision 3 — A dedicated `makerperks-engagement` Worker, reusing contribute scaffolding

A new Worker rather than extending `makerperks-contribute`. Rationale: separation of
concerns — contribute opens GitHub PRs (write-to-repo); engagement stores user state
(write-to-D1). Different bindings, blast radius, and rate-limit profiles. It **reuses**
the contribute Worker's proven scaffolding: Turnstile verification, per-IP rate limiting,
and CORS allowlisted to the site origins. **Alternative rejected:** one Worker with both
responsibilities — couples unrelated secrets/bindings and makes the contribute path's
PR-opening logic share a deploy with high-frequency engagement writes.

### Decision 4 — Mint the session id on first action, never on pageview

The anonymous session id is created **only when the user first takes an engagement action**
(e.g. clicks "save"), stored first-party (localStorage / first-party cookie), and never
shared with any third party. **Why this matters:** passive browsing then sets no
identifier at all, so the current "no cookies, no consent banner" posture is preserved
verbatim for the majority who only read. It also frames the id as a *functional,
user-initiated* identifier (you asked us to remember your favorites), which is the
strongest privacy footing. **Alternative rejected:** mint on pageview — simpler
attribution but it puts an identifier on every visitor, breaks the cookieless posture,
and likely trips consent requirements for non-essential storage.

### Decision 5 — Dedup + rate-limit first; Turnstile reserved, not on every save

Honest counts come from **dedup by `(session, target, type)`** at write time (a unique
constraint: favoriting a perk twice is idempotent) — with reads/aggregates deduped by
**owner** (Decision 8), so counts stay honest across account-elevation — plus
**per-session and per-IP rate limits** and **basic bot heuristics**
(UA/missing-session/velocity). Turnstile is *not* required on a
low-stakes favorite click — a CAPTCHA on every save is bad UX. It is **reserved** for
actions that prove abuse-prone or higher-value (account creation, AI-assist, or counts if
inflation appears). **Alternative rejected:** Turnstile on every write — maximal
resistance, unacceptable friction for the headline low-friction action. Escalation path
is built in: the endpoint can require Turnstile per action-type via config.

### Decision 6 — Aggregate reads now; scheduled materialization deferred to `anon-favorites`

This change exposes an **aggregate read path** (counts per target) and proves it with a
thin probe. The *scheduled snapshot* that writes counts into the dataset/`llms.txt` and
the *display* of counts are part of `anon-favorites` (change #2), where they have a real
consumer. The substrate just guarantees the read exists and is cheap. **Why split:**
keeps this change honestly scoped to the foundation and avoids shipping a snapshot job
with nothing to show.

### Decision 7 — Validate with an internal probe, not a feature

Because the substrate has no user-facing surface, it is verified by a **generic recorded
event** end-to-end (mint session → POST event → dedup holds → aggregate read returns the
count) via tests / a disposable internal action, not by shipping UI. This is the explicit
mitigation for "infrastructure ahead of a consumer" (see Risks).

### Decision 8 — Account-elevation contract (anonymous → registered), forward-compat now

Registration is a later change (`identity-optional`), but the substrate is built so that
change is purely additive — a re-pointing of ownership, not a data migration:

- **Dedup/aggregate unit is the identity (owner), not the session.** Write-time
  idempotency stays per-session (the UNIQUE index); reads and counts dedup by owner, so a
  multi-device person counts once. While no accounts exist, identity ≡ session and
  behavior is identical to a session-keyed model — later changes only *add*, never modify
  this requirement.
- **Elevation links 1..N sessions to one user, atomically and idempotently.** On a
  `(owner, target, type)` collision during merge (the same perk favorited from two linked
  sessions), collapse to one, keeping the earliest `created_at`.
- **PII never enters `events`.** A future `users` table holds email/name; the join is
  owner→user. Linking prior anonymous activity to a now-identified account is a
  consent-for-value moment the registration flow must disclose.
- **Pruning exempts linked sessions.** Retention/TTL (task 5.3) prunes only orphan
  anonymous sessions (`user_id IS NULL`); a linked session's history is the user's and is
  never auto-pruned.

## Risks / Trade-offs

- **Speculative generality — building a substrate with no live consumer.** → Scope strictly
  to what `anon-favorites` needs; ship the two changes close together; validate via probe
  (Decision 7). If favorites slips, reconsider folding the substrate into it.
- **D1 single-writer throughput on hot counters.** → Fine at current traffic; counts are
  read-mostly and materialized on a schedule, not read live per request. Escalation =
  move counts to a Durable Object/KV cache (Decision 2), localized.
- **Privacy creep.** A "harmless" session id can drift toward tracking. → Keep it
  functional, first-party, user-initiated, no third-party sharing, documented in
  `/privacy`; passive visitors get nothing. Sensitive-input storage is gated to a
  separate consent-for-value change.
- **Count inflation / gaming once displayed.** → Dedup + rate-limit + bot heuristics in
  this layer; display thresholds/floors handled in `anon-favorites`; Turnstile escalation
  available (Decision 5).
- **Two sources of click truth (Umami vs. substrate).** If the substrate also records
  redeem clicks for *display*, it can diverge from Umami's analytics number. → Treat Umami
  as the trend source of truth and the substrate's deduped count as a *display* figure;
  document that they answer different questions. (Redeem-count recording itself is
  `anon-favorites`/counts scope.)
- **Build coupling to the edge.** → The static build must succeed with the substrate
  unconfigured (forks, CI) — the engagement island degrades to no-op, exactly like the
  analytics disable path.

## Migration Plan

- Provision D1 + the `makerperks-engagement` Worker behind config; no change to existing
  Workers. Deploy is additive and independently revertable (delete Worker + DB; the
  static site is unaffected).
- The client engagement island is feature-flagged off until the endpoint is live; with it
  off, the site behaves exactly as today.
- Update `/privacy` (and `/terms` if needed) in the same change so published statements
  stay accurate the moment any id can be set.

## Open Questions

- First-party storage mechanism for the id: `localStorage` vs. a first-party functional
  cookie (cookie survives across subdomains/`makerperks.dev`; localStorage is more clearly
  "not a tracking cookie"). Lean localStorage; confirm during apply.
- Column-level D1 schema detail (indexes, timestamp precision) within the now-decided
  two-table `sessions`/`events` shape (Decision 2 / Decision 8) — settle in the first task.
- Whether the engagement endpoint lives on `api.makerperks.dev` (reserved domain, route
  currently commented out) or the default `*.workers.dev` first. Lean: `*.workers.dev`
  until favorites ships, then promote.
- Retention/TTL for anonymous events that never convert to an account (e.g. prune orphan
  sessions after N months) — define before launch.
