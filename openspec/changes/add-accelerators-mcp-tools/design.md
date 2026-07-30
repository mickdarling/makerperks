# Design — accelerators MCP tools

## Decisions

- **Same worker, not a second worker.** One MCP endpoint (`mcp.makerperks.com`) with
  both datasets keeps discovery trivial and reuses the DO/session/rate-limit setup.
  Tool names are prefixed (`search_accelerators` vs `search_perks`) so the two
  families read as siblings.
- **Lazy per-tool dataset load.** `loadPerks` runs at `init()` today; a failing
  accelerators URL at init would take down the whole server. Accelerator tools call
  `loadAccelerators()` inside the handler and return a structured error result on
  failure. Perks behavior is untouched.
- **Separate module-level cache**, same TTL (5 min) and last-good-on-failure
  semantics as perks.
- **`upcoming_deadlines` is the differentiator.** `next_deadline` is ISO
  (`YYYY-MM-DD`) or null in the dataset (validated). The tool takes `within_days`
  (default 60), compares against the current date (UTC), returns dated programs
  soonest-first each with `days_left`, and appends active rolling programs
  (`next_deadline: null`, status Active) so "no deadline, start anytime" options
  aren't invisible. Past-dated deadlines are excluded.
- **Filters mirror dataset enums**: `category` (flagship | ai | non_dilutive |
  vendor | regional | university), `format` (remote | hybrid | in_person),
  `status` defaults to Active-only with an `include_inactive` escape hatch
  (Defunct/Paused entries are landscape memory, not offers).
- **`non_dilutive` filter** = `value_type` in {grant, credits, services} or
  `equity` equal to "none" — the query the target audience actually asks.
- **fit/fit_note pass through untransformed** but tool descriptions state they are
  relative to the dataset maintainer's profile — advisory, not universal.
- **Data URL**: `ACCELERATORS_JSON_URL` var → raw GitHub `main` copy for now;
  switch to `https://www.makerperks.com/accelerators.json` when the site build
  publishes the dataset (follow-up, out of scope here).

## Alternatives rejected

- Generalizing the perks loader into one generic dataset loader — premature; the
  multi-dataset generator design (with Nate) will own that shape.
- A `list_accelerator_categories` tool — the enum is small and fixed; it lives in
  the tool descriptions and help page instead of costing a tool slot.
