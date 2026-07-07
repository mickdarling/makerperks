## Why

MakerPerks measures clicks but owns no engagement. Redeem clicks are already counted in
cookieless Umami, but the site cannot remember a single thing about a visitor — no saved
perks, no per-perk popularity to read back, no identity to attribute a return visit to.
To test whether MakerPerks can be **sticky** (the #0 venture's stated goal: drive repeat
visits and measure engagement against an explicit success/kill bar), we first need a
place to put user-generated state. That layer is entirely absent today, and every
planned engagement feature — favorites, popularity counts, accounts, email, AI-assist —
depends on it.

## What Changes

- Introduce a **capture substrate**: an anonymous, privacy-first layer for recording and
  reading back small amounts of engagement state, **without breaking the static /
  cookieless / PR-editable model**.
- **Anonymous session identity** minted only on a *deliberate engagement action* (not on
  pageview), so passive browsing stays fully anonymous and cookieless exactly as today.
- An **edge data store** (Cloudflare D1) plus a **write/read API** (a Worker) for
  engagement events and per-session state, reusing the existing Turnstile / rate-limit /
  CORS abuse-protection patterns from the contribute Worker.
- **Dedup + bot-resistance** baked into the write path (dedup by `(session, target,
  type)`; per-session/IP rate limits; bot heuristics) so any count built on this stays
  honest — a Trusted-Ledger brand requirement, not a nicety.
- An **aggregate read path** so per-target counts can later be materialized back into the
  static build and `llms.txt` (the same write-back pattern the freshness flow uses).
- **No PII and no consent banner in this layer**: the substrate stores only an opaque
  session id and engagement events. Consent-for-value storage of sensitive inputs (build
  descriptions, startup URLs) is a deliberately later change.
- Scope is the foundation only, validated by a thin internal probe (a generic recorded
  event), **not** a user-facing feature — favorites (the next change) is the first real
  consumer.

## Capabilities

### New Capabilities

- `engagement-capture`: an anonymous, privacy-first substrate that records deduplicated,
  bot-resistant engagement events and per-session state at the edge and exposes aggregate
  reads — the foundation favorites, popularity counts, accounts, and AI-assist build on.

### Modified Capabilities

(none — purely additive. The existing `site-analytics` Umami/Apollo behavior is
unchanged; this layer must *preserve* its cookieless, consent-free posture for anonymous
use rather than alter it.)

## Impact

- **Affected specs:** new `engagement-capture` capability (`specs/engagement-capture/spec.md`).
- **New infra:** a Cloudflare **D1** database + a **`makerperks-engagement` Worker**
  (write/read endpoints), reusing the contribute Worker's Turnstile + rate-limit + CORS
  scaffolding. New `wrangler.toml` bindings and a D1 schema/migration. No standing server
  beyond Workers; idle cost ≈ zero.
- **Site:** a small client island that mints the session id on first engagement action
  and calls the write endpoint. No change to any page's static rendering for passive
  visitors; the build still succeeds with the substrate disabled/unconfigured.
- **Privacy:** `/privacy` (and `/terms` if needed) updated to disclose the first-party
  *functional* session id + engagement storage; no third-party sharing and no new cookie
  for passive browsing.
- **Reuses existing instrumentation:** Umami stays the analytics-plane source of truth
  for click/pageview trends; this substrate adds product state + displayable, deduped
  counts that Umami cannot render back into a page or `llms.txt`.
- **Non-goals (later changes):** favorites UI + popularity display (`anon-favorites`),
  accounts + email notifications (`identity-optional`), AI-assist inputs + consent
  storage (`ai-assist`), structured feedback. This change ships the foundation only.
- **Enables the metric:** the studio's 4-week engagement kill criterion cannot be
  measured without this layer — it is the prerequisite instrument.
