## Why

The repo now carries a second dataset — `datasets/accelerators/accelerators.json`, a
verified directory of startup accelerators, incubators, and founder programs in the
perks.json family — but the MCP server only speaks perks. An agent asking "which
accelerators can a remote-first US startup still apply to this fall?" has to fetch and
filter the raw JSON itself. The whole point of the MCP worker is intent-shaped queries
over our datasets; the accelerators dataset should get the same treatment, including
the one query perks don't need: **what deadlines are coming up?**

## What Changes

- **Three read-only accelerator tools on the existing MCP worker**:
  - `search_accelerators` — free-text + filters (category, format, region, status,
    non-dilutive-only, minimum value), value-sorted.
  - `get_accelerator` — one full record by slug.
  - `upcoming_deadlines` — programs whose `next_deadline` falls within N days, sorted
    soonest-first, with rolling/open-ended programs listed alongside — the "radar"
    query.
- **Independent data path**: the worker fetches `accelerators.json` from a new
  `ACCELERATORS_JSON_URL` var, cached like perks.json. Accelerator tools load their
  dataset lazily so a failed accelerators fetch never breaks the perks tools.
- Help page and README document the new tools.

## Capabilities

### New Capabilities

(none — extends `agent-outputs`.)

### Modified Capabilities

- `agent-outputs`: the interactive MCP query interface also serves the accelerators
  dataset, including a deadline-window query.

## Impact

- **Affected specs:** `agent-outputs` (added requirement).
- **Code:** `mcp-worker/src/index.ts` (tools + loader), `mcp-worker/wrangler.toml`
  (`ACCELERATORS_JSON_URL`), `mcp-worker/README.md`, help text.
- **Data note:** `fit`/`fit_note` are maintainer-profile-specific; tool descriptions
  mark them advisory. Until the site build publishes `/accelerators.json`, the var
  points at the raw-GitHub copy on `main`.
- **Non-goals:** site UI for accelerators; multi-dataset generator (separate design
  discussion with Nate); mutating tools.
