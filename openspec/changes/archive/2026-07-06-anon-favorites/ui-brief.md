# UI brief for `impeccable` — anon-favorites group 4

The backend + client API are done and committed. This is the design-surface work (tasks
4.1–4.5) that must go through `impeccable`. Everything below is the integration contract;
the *look/motion/placement* are impeccable's call within the brand.

**Brand:** the Trusted Ledger — _trustworthy & precise_. Anti-references: cluttered
coupon/deals site. Counts must read as quiet metadata, never hype. WCAG 2.2 AA.

## Surfaces to build

1. **Heart save toggle on listing cards** — `src/components/ProgramCard.astro` (used by
   `src/pages/index.astro` and `src/pages/for/[audience].astro`). Empty heart = unsaved,
   filled = saved, top-right of the card. Optimistic toggle.
2. **Save control on the perk detail page** — `src/pages/programs/[...slug].astro`,
   consistent with the card heart.
3. **Threshold-gated count — detail page ONLY** (not on cards; keep the grid calm). Quiet
   "saved by N+" treatment. Placed so it does **not reflow main content** when it appears.
4. **My-favorites view** — a new `/favorites` page (or island) listing saved perks; clear
   empty state; disabled state when the endpoint is unconfigured.

## Integration contract — `src/lib/engagement.ts` (already built)

```
isEngagementEnabled(): boolean        // gate the ENTIRE surface on this; false → render nothing
isFavorited(target): boolean          // sync, from localStorage mirror — instant heart state
toggleFavorite(target): Promise<bool> // returns the NEW saved state; updates mirror + server
getFavorites(): string[]              // for the my-favorites view
syncMine(): Promise<void>             // optional: reconcile mirror from server within a session
loadCounts(): Record<string,number>   // returns cached counts now + revalidates if stale
onCountsUpdate(cb): () => void         // re-render counts when fresh data arrives
```

`target` = the program id (`program.id`, e.g. `vercel/vercel-for-startups`).

## Behavior rules (from the spec/design)

- **Gate everything on `isEngagementEnabled()`** — when false, no hearts, no counts, no
  my-favorites surface; nothing mints a session id. (Passive browsing stays cookieless.)
- **Hearts** read `isFavorited()` (localStorage, no network) so they light up instantly on
  any page; click → `toggleFavorite()` (optimistic; the helper handles server + mirror).
  Use `aria-pressed`, keyboard-operable, `:focus-visible`, honor `prefers-reduced-motion`.
- **Count (detail only):** on mount call `loadCounts()`; show the count **iff
  `counts[program.id]` exists** (the server already applied the threshold, so any present
  value is displayable). **Render nothing if absent** — no "0", no skeleton. Subscribe via
  `onCountsUpdate()` to fill/Update in place when revalidation returns.
- **My-favorites:** join `getFavorites()` against `/search-index.json` (already served) to
  render cards; empty state invites browsing.
- Do **not** call any engagement function on passive page load except `loadCounts()` on the
  detail page (anonymous read, no mint).

## Suggested command

```
/impeccable craft favorites — a heart save toggle (empty/filled, aria-pressed) in the
top-right of ProgramCard and on the perk detail page; a quiet "saved by N+" popularity
line on the detail page only (shown only when a count exists, never reflowing content);
and a /favorites view of saved perks with an empty state. Wire to src/lib/engagement.ts
(isEngagementEnabled/isFavorited/toggleFavorite/getFavorites/loadCounts/onCountsUpdate);
gate the whole surface on isEngagementEnabled().
```

After impeccable builds these, finish: task 4.5 (confirm the wiring) and 6.3/6.4
(verify with the endpoint configured + an a11y pass).
