## Why

The capture substrate can store engagement, but nothing uses it yet. `anon-favorites` is
its first real consumer: it lets an anonymous visitor **save perks** (a reason to come
back) and shows **how many builders saved a perk** — turning the substrate's deduped
counts into visible, on-brand proof. It produces the first engagement signal the studio's
stickiness success/kill bar needs. Crucially, it does this **without becoming a
coupon/deals site**: counts appear only once they carry real signal (above a threshold),
rendered quietly and precisely — never "0 saved", never hype.

## What Changes

- A **Save** control on perk pages: anonymous favorite / unfavorite, instant and
  optimistic, backed by the substrate. State persists per session (the substrate's
  mint-on-action id) — no login.
- A **"My favorites"** view listing the visitor's saved perks (client-rendered from the
  session plus the existing `search-index.json`).
- **Popularity counts**: a perk can show "N builders saved this" **only when N ≥ a
  configured threshold** — the anti-marketing guard. Below the threshold it shows nothing
  (never "0"). Counts are identity-deduped by the substrate and **materialized into the
  static build + `llms.txt`** (lagged, agent-readable), not fetched live per pageview.
- **Substrate extensions** (`engagement-capture`): remove an event (unfavorite) and list a
  session's events (my-list) — generic operations the substrate didn't need until now.
- **Graceful disable**: when the engagement endpoint is unconfigured, no Save UI and no
  counts render, and the build still succeeds (forks/CI) — exactly the substrate's
  disable path.
- All UI presentation goes through **`impeccable`** (the Save control, the count
  treatment, the my-favorites view, empty/disabled states) per the project's design
  workflow.

## Capabilities

### New Capabilities

- `favorites`: anonymous save/unsave of perks, a my-favorites view, and threshold-gated,
  identity-deduped popularity counts surfaced in the static build and `llms.txt`.

### Modified Capabilities

- `engagement-capture`: add **event removal** (unfavorite) and **per-session event
  listing** (my-list) to the substrate. Defined by the `capture-substrate` change —
  **archive that change first** so this only adds deltas to a complete baseline.

## Impact

- **Depends on `capture-substrate`** (the `makerperks-engagement` Worker + D1 + the dormant
  `src/lib/engagement.ts` helper). Archive `capture-substrate` before archiving this change.
- **New worker endpoints:** `DELETE /event` and `GET /mine` on `makerperks-engagement`,
  reusing the existing CORS / rate-limit / bot gates. New SQL: delete-by-key and
  select-targets-by-session — added to `store-d1`, `store-memory`, the handler, and tests.
- **Site:** a Save control + count badge on the perk page (`programs/[...slug].astro`); a
  my-favorites page/island; a **build-time counts loader** that batches `GET /aggregate`
  for all programs (threshold applied at render/emit); counts surfaced in
  `llms.txt`/`llms-full.txt`. `src/lib/engagement.ts` gains unfavorite + a localStorage
  mirror for instant heart state.
- **Config:** reuse `PUBLIC_ENGAGEMENT_ENDPOINT`; add a build-time counts **threshold**
  knob. No new secrets.
- **Privacy:** covered by the substrate's existing `/privacy` disclosure (favorites are
  anonymous, no PII; counts are aggregate). Copy touch-up only if wording needs it.
- **Metric:** makes favoriting-session rate + per-perk popularity observable — the
  engagement signal behind the 4-week kill criterion.
- **Non-goals / later:** redeem-count display (same mechanism, follow-on); cross-device
  favorites + account-scoped my-list (`identity-optional`); comments/structured feedback.
  Count badges on listing cards are deferred — **detail page only in v1** to stay calm.
