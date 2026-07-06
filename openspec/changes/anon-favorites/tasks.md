# Tasks — Anonymous favorites with threshold-gated counts

> **Depends on `capture-substrate`** (the `makerperks-engagement` Worker + D1 +
> `src/lib/engagement.ts`). Archive that change before archiving this one.
>
> **impeccable boundary:** group 4 (the Save hearts on cards + detail page, the count
> treatment, the my-favorites view, empty/disabled states) is a visible design surface and
> **MUST go through `impeccable`**. Groups 1–3, 5, 6 are backend/data/build and do **not**
> require impeccable.
>
> **Decisions (from design):** counts are **client-side, cached in localStorage
> (stale-while-revalidate)** — never built or committed; refreshed on TTL + after a write;
> **first load with no data renders no count element** (no "0") · a bulk, **server-side
> threshold-filtered**, edge-cached `GET /counts?type=&min=` feeds the cache · Save = a
> **heart on listing cards AND the detail page**; the *number* stays on the detail page only ·
> unfavorite = keyed `DELETE`, counts refresh client-side (no build lag) · agent popularity
> via the **live `/counts` endpoint referenced from `llms.txt`**, not baked.

## 1. Substrate extensions (engagement-worker) — no impeccable

- [x] 1.1 `removeEvent(session, target, type)` in the store interface + `store-memory` +
  `store-d1` (`DELETE FROM events WHERE session_id=? AND target=? AND type=?`); idempotent
- [x] 1.2 `listBySession(session, type)` → targets, **owner-resolved**
  (`COALESCE(sessions.user_id, events.session_id)`); `store-memory` + `store-d1`
- [x] 1.3 `bulkCounts(type, min, cap)` → owner-deduped counts for every target with
  `count >= min`, capped (`GROUP BY target HAVING COUNT(DISTINCT owner) >= ?`); excludes
  sub-threshold; `store-memory` + `store-d1`
- [x] 1.4 Handler: `DELETE /event`, `GET /mine?session=&type=`, and
  `GET /counts?type=&min=` — reuse CORS/rate-limit/bot/validate gates; `/counts` carries a
  `Cache-Control` for edge caching and returns counts only (no identifiers)
- [x] 1.5 Worker tests: remove idempotent + drops from aggregate; `/mine` returns the
  session's targets and **resolves by owner after `linkSessions`**; `/counts` returns only
  `>= min`, excludes sub-threshold, respects the cap; gates reject bad origin / over-limit / bots

## 2. Client favorites + counts helper (site) — no impeccable

- [x] 2.1 Extend `src/lib/engagement.ts`: `unfavorite(target)` → `DELETE /event`; a
  localStorage **mirror** (`mp_favs`) of saved target-ids; `isFavorited(target)` and
  `listFavorites()` reading the mirror; `syncMine()` reconciling the mirror against `GET /mine`
- [x] 2.2 Counts cache (`mp_counts`, stale-while-revalidate): `loadCounts()` returns the
  cached map immediately and revalidates via `GET /counts?type=favorite&min=<threshold>`;
  refresh on a TTL and after any write; expose a subscribe/update hook so rendered counts
  update in place; all no-op when the endpoint is unconfigured
- [x] 2.3 Keep mint-on-action (saving mints the session id; counts reads stay anonymous and
  never mint)

## 3. Config + agent surface — no impeccable

- [x] 3.1 Add the `PUBLIC_FAVORITES_COUNT_MIN` threshold knob (modest default) that the
  client passes as `min`; document it + reuse of `PUBLIC_ENGAGEMENT_ENDPOINT` in `.env.example`
- [x] 3.2 `llms.txt`: reference the live `GET /counts` endpoint for agent-readable popularity
  (Decision 8); do **not** bake count values into the static text

## 4. UI presentation — **impeccable REQUIRED**

- [x] 4.1 Via `impeccable`: the **heart Save control on listing cards** (top-right,
  empty/filled), optimistic toggle, hidden when the endpoint is unconfigured, WCAG 2.2 AA
  (`aria-pressed`, keyboard, focus, reduced-motion)
- [x] 4.2 Via `impeccable`: the Save control on the **perk detail page**, consistent with the
  card heart
- [x] 4.3 Via `impeccable`: the **threshold-gated count** on the detail page (quiet, e.g.
  "saved by N+"), rendered/updated from the client counts cache — **not rendered on first
  load with no data**, and placed so it does **not reflow main content** when it appears
- [x] 4.4 Via `impeccable`: the **My-favorites view** (page or island) joining
  `listFavorites()` against `search-index.json`, with a clear **empty state** and a
  **disabled state** when the endpoint is unset
- [x] 4.5 Wire the components to `engagement.ts` (save/unsave/isFavorited/listFavorites/
  loadCounts + the update hook); confirm no engagement session id is created on passive load

## 5. Privacy — no impeccable

- [x] 5.1 Confirm the substrate's `/privacy` "Saving perks" disclosure covers this feature;
  note that the anonymous counts fetch stores nothing; adjust copy only if wording needs it

## 6. Verify — no impeccable

- [x] 6.1 `engagement-worker` typecheck + tests green (remove + mine + counts + owner-
  resolution + cache headers)
- [x] 6.2 Site typecheck + lint + `npm run build` with the endpoint **unconfigured** → no
  hearts, no counts, build succeeds, and **no count values present in the static output**
  (counts are never baked)
- [x] 6.3 With the endpoint **configured** (local `wrangler dev` + seeded D1): hearts toggle
  and persist across cards ↔ detail ↔ reload; counts appear after load only for
  at/above-threshold perks and update in place after a write; sub-threshold perks show none;
  a first load with cleared storage shows no count element until counts arrive
- [x] 6.4 `impeccable` accessibility pass on the new UI (keyboard, contrast, `aria-pressed`,
  reduced-motion, **no main-content reflow** when counts appear); confirm the grid stays
  calm (heart only, no number on cards)
