# MakerPerks engagement Worker — the capture substrate

The server side of the engagement layer: an anonymous, privacy-first store for small
amounts of engagement state, behind a Cloudflare Worker + **D1**. No standing server, no
PII — only an opaque client-minted session id, a target, a type, and a timestamp.

- `POST /event` — `{ session, target, type, turnstileToken? }` → records a **deduplicated**
  engagement event (`(session, target, type)` is idempotent). Bot-gated, CORS-allowlisted,
  rate-limited per IP **and** per session. Low-stakes types need no Turnstile; types listed
  in `CHALLENGE_EVENT_TYPES` require a token (escalation).
- `GET /aggregate` — `?type=favorite&target=A&target=B` (or `?targets=A,B`) → the count of
  **unique identities** per target. Counts only — never session/account ids.
- `GET /` — plain-text help.

The site's headless helper (`src/lib/engagement.ts`) calls these; it is dormant until a
feature wires it up (first consumer: the `anon-favorites` change).

## Identity & account-elevation (the key design)

Two tables (`migrations/0001_init.sql`):

- `sessions(session_id PK, user_id NULL, created_at)`
- `events(session_id, target, type, created_at)` — `PRIMARY KEY (session_id, target, type)`
  gives write-time idempotency.

The **owner** of an event is `COALESCE(sessions.user_id, events.session_id)`, and every
aggregate counts `DISTINCT` owners. So when a visitor later registers, linking their
sessions is a single `UPDATE sessions SET user_id=…` — **no events are rewritten** and a
multi-device person collapses to one identity. `linkSessions()` exists today (dormant);
the registration UI + a `users`/PII table arrive in the `identity-optional` change.

## Develop & test

```sh
cd engagement-worker
npm install
npm test          # handler/dedup/aggregate/elevation tests (node:test, no deploy)
npm run typecheck
npm run build     # wrangler dry-run (bundle + config check)
npm run dev       # local: http://localhost:8787 (needs a local D1, see below)
```

## One-time setup before deploy

1. **Create the D1 database** and paste its id into `wrangler.toml`:
   ```sh
   wrangler d1 create makerperks-engagement
   # → copy database_id into [[d1_databases]] database_id
   ```
2. **Apply migrations** (local for dev, remote for prod):
   ```sh
   wrangler d1 migrations apply makerperks-engagement            # local
   wrangler d1 migrations apply makerperks-engagement --remote   # production
   ```
3. **Set the Turnstile secret** (only needed if you enable `CHALLENGE_EVENT_TYPES`):
   ```sh
   wrangler secret put TURNSTILE_SECRET
   ```
4. **Deploy** and point the site at it:
   ```sh
   npm run deploy
   # then set PUBLIC_ENGAGEMENT_ENDPOINT=<worker url> in the site's production env
   ```

CORS (`ALLOWED_ORIGINS`), accepted `EVENT_TYPES`, and `CHALLENGE_EVENT_TYPES` are
non-secret `[vars]` in `wrangler.toml`.

## Retention / TTL

Anonymous sessions that never convert to an account are pruned on a schedule;
**linked sessions (a registered user's history) are never auto-pruned.** `sql/prune.sql`
deletes only `user_id IS NULL` sessions (and their events) older than a cutoff. Run it
from a Worker cron or a scheduled job, e.g. prune everything older than 180 days:

```sh
wrangler d1 execute makerperks-engagement --remote --file=sql/prune.sql \
  --param "$(node -e 'process.stdout.write(String(Date.now()-180*864e5))')"
```

## Privacy posture

Passive browsing sets **nothing** — the session id is minted only on a deliberate action.
The id is first-party, opaque, never shared with a third party, and stores no PII. When
the site sets `PUBLIC_ENGAGEMENT_ENDPOINT`, `/privacy` discloses the functional id +
saved-perks storage; with it empty the whole layer is a no-op.
