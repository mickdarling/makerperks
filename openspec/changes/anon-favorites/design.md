# Design — Anonymous favorites with threshold-gated counts

## Context

`capture-substrate` shipped the engagement layer (the `makerperks-engagement` Worker + D1,
identity-deduped aggregates, and a dormant `src/lib/engagement.ts` helper) but deliberately
with no consumer. This change is that consumer. It must honor the substrate's posture —
anonymous-by-default, mint-on-action, no PII, honest counts — and the product's brand: the
Trusted Ledger, whose anti-references explicitly include the "cluttered coupon/deals site."
That brand constraint is why visible counts are gated behind a threshold and treated
quietly, and why all presentation routes through `impeccable`.

This change depends on `capture-substrate` and extends its `engagement-capture` capability;
archive `capture-substrate` first so the baseline is complete (the documented "foundational
change archives first" rule).

## Goals / Non-Goals

**Goals:** anonymous save/unsave with instant feedback, surfaced on both the listing cards
and the perk page; a my-favorites view; per-perk popularity that is honest (deduped), calm
(threshold-gated, quiet), and **fresh without commit noise or build coupling**; zero new
PII; graceful disable.

**Non-Goals:** accounts / cross-device favorites (that's `identity-optional`); redeem-count
display (same mechanism, a follow-on); comments; **baking counts into the static HTML or
`llms.txt`** (counts are now client-side — see Decision 8); count badges on listing cards
(the *heart* goes on cards, the *number* stays on the detail page to keep the grid calm).

## Decisions

### Decision 1 — Counts are client-side, cached in localStorage (stale-while-revalidate) — NOT built or committed

Counts are loaded in the browser and cached in localStorage, exactly like the favorites
list. On page load the page renders counts immediately from the cache (if any), then fetches
fresh counts and updates the rendered elements in place; it refreshes on a TTL and after a
write action (save/unsave). **On the first load with no cached data, count-dependent
elements are not rendered at all** — no "0", no skeleton placeholder — and they appear only
once data has loaded and a perk meets the threshold.

**Why:** the previously-proposed build-time materialization (and the committed-snapshot
alternative) is rejected — it creates commit noise and a long lag (counts only move on a
rebuild/deploy). Client-side caching makes counts near-live, decouples the build from the
Worker, and adds nothing to git history. **Trade-off accepted:** counts are no longer in the
static HTML, so they are not SEO-indexable and not in `llms.txt` at build time (see
Decision 8). This is a deliberate freshness-over-staticness choice for the *count* only —
everything else on the page stays static.

### Decision 2 — A bulk, threshold-filtered counts endpoint, edge-cached

The substrate gains `GET /counts?type=favorite&min=N` → every target whose deduped count is
**≥ N** (bounded/capped), counts only. The client requests `min = threshold`, so it only
ever receives **displayable** counts — the threshold is enforced **server-side**, sub-
threshold numbers never leave the edge, and the payload is small (only popular perks). The
response is **edge-cacheable** (`Cache-Control`, ~minutes), so the per-visitor counts fetch
is a cheap CDN hit, not a per-pageview origin/D1 query. **Why a bulk read** instead of
per-target `GET /aggregate`: one cached response covers every page, so any page (and the
listing grid) renders counts from a single localStorage cache without enumerating program
ids client-side.

### Decision 3 — The threshold is the anti-marketing guard

A perk's count appears only at/above the threshold; below it, nothing (Decision 1 + the
server-side `min` of Decision 2). Display leans **bucketed** ("saved by 10+ builders")
rather than a precise, competitive integer — the exact treatment is an `impeccable` call.
**Why:** sub-threshold counts are negative social proof / vanity metrics — the coupon-site
failure the brand forbids. The threshold is one build-time knob (`PUBLIC_FAVORITES_COUNT_MIN`,
modest default, e.g. ~10) consumed by the client as the `min` param.

### Decision 4 — Save state everywhere: a heart on listing cards AND the perk page

The Save control appears as a **heart (empty / filled)** in the top-right of each listing
card, and on the perk detail page. State comes from the client's localStorage **mirror** of
saved target-ids, so hearts light up instantly on any page without a round-trip; toggling is
optimistic and posts to the substrate. **Why on cards:** saving is the lowest-friction
engagement primitive and the grid is where browsing happens — putting it only on detail
pages buries it. The exact heart placement, states, and motion are an `impeccable` call
(this is a visible design surface). The *count number* still stays on the detail page only
(Non-Goals) so the grid stays scannable.

### Decision 5 — My-favorites is client-rendered from the session; the server is for counts + elevation

The anonymous source of truth for "my list" is the **session**: the helper keeps a
localStorage mirror of saved ids for an instant, offline-friendly view, rendered by joining
those ids against the existing `search-index.json`. The **server** copy (substrate events)
powers the deduped counts and future account-elevation. `GET /mine?session=…` lets the client
reconcile/recover its list within a session.

### Decision 6 — Unfavorite is a keyed delete; counts refresh client-side, not at build

Unfavorite = `DELETE` the `(session, target, type)` event (idempotent). The user's own heart
flips instantly (mirror); the public count refreshes on the next client fetch (TTL or post-
write), not on a rebuild — so there is no build lag and no commit. The threshold dampens
sensitivity to single changes anyway.

### Decision 7 — Owner-consistency for the future

`GET /mine` is session-scoped now (anonymous: session ≡ owner). Counts are already owner-
deduped by the substrate. When `identity-optional` lands, my-list resolves by owner (a user's
linked sessions) and counts need no change — `COALESCE(user_id, session_id)` already handles it.

### Decision 8 — Agent-readable popularity moves to the live endpoint, not `llms.txt`

Because counts are client-side (Decision 1), they are not baked into `llms.txt`/static
output. For agent-native popularity we **point agents at the live `GET /counts` endpoint**
(referenced from `llms.txt`) rather than embedding a stale, build-time snapshot. **Why:**
keeps a single fresh source of truth and avoids reintroducing build coupling just for the
text file. (If a baked snapshot is later wanted for pure-static agents, the build *could*
fetch `/counts` at deploy with no commit — noted as an option, not v1.)

## Risks / Trade-offs

- **Counts not in static HTML / `llms.txt` / SEO.** → Accepted for freshness; agents use the
  live endpoint (Decision 8); the count is a small enhancement, not core page content.
- **A counts fetch on every visit (even passive browsers).** → It is anonymous and stores
  nothing (reads never mint a session id); the response is edge-cached so it is a CDN hit,
  not a per-visitor D1 query.
- **Layout shift when counts appear after load.** → `impeccable` places the count where it
  does not reflow main content (e.g. a quiet metadata line); first load simply omits it.
- **Stale cache shows an out-of-date number briefly.** → Stale-while-revalidate updates in
  place within seconds; the threshold makes small drift invisible.
- **Count gaming once visible.** → Substrate dedup + per-session/IP rate limits + bot gates;
  the `min` threshold raises the bar; Turnstile escalation available if abused.
- **Hearts on cards add grid clutter / brand drift.** → Only the heart (not the number) on
  cards, quiet treatment, mandatory `impeccable` pass.

## Migration Plan

- Worker: add `DELETE /event`, `GET /mine`, and `GET /counts?type=&min=` (edge-cached);
  additive and revertable, reuses the existing `events`/`sessions` tables.
- Site: ship the Save heart (cards + detail) + client-side counts behind the existing
  endpoint flag; with it empty the site is byte-for-byte today's behavior. The client counts
  loader degrades to "no counts shown" on any error.
- Order: archive `capture-substrate` → merge this → archive this.

## Open Questions

- Counts cache **TTL** and the post-write refresh debounce — settle in implementation.
- Threshold value + bucket boundaries (10 / 25 / 100 "+") — `impeccable` pass against real
  counts.
- Heart placement/affordance on cards and the count treatment on the detail page —
  `impeccable`.
- Whether to also reference (or later bake) `/counts` in `llms.txt` for agents now or defer
  (Decision 8) — lean: reference the live endpoint, defer any baked snapshot.
