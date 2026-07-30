# Tasks — accelerators MCP tools

> Backend/agent-endpoint change (worker code + config + docs) — no site design
> surface, so `impeccable` is not required.
>
> **Decisions (from design):** same worker, prefixed tool names · lazy per-tool
> dataset load with structured error results · separate 5-min cache ·
> `upcoming_deadlines` with `within_days` + rolling programs appended ·
> Active-only default · fit fields pass through marked advisory ·
> `ACCELERATORS_JSON_URL` var (raw GitHub until the site publishes the dataset).

## 1. Data path

- [x] 1.1 Add `ACCELERATORS_JSON_URL` to `Env` and `wrangler.toml` (raw GitHub
  `main` URL, comment noting the future site URL)
- [x] 1.2 Add `Accelerator` / `AcceleratorsDataset` interfaces matching the dataset
  README schema, plus a lazy `loadAccelerators()` with its own cache and
  last-good-on-failure semantics

## 2. Tools

- [x] 2.1 `search_accelerators(query?, category?, format?, region?, non_dilutive?,
  min_value?, include_inactive?, limit?)` — value-sorted, Active-only by default
- [x] 2.2 `get_accelerator(slug)` — full record or notFound
- [x] 2.3 `upcoming_deadlines(within_days?, include_rolling?)` — dated deadlines in
  window soonest-first with `days_left`, active rolling programs appended
- [x] 2.4 Wrap accelerator tool bodies so a dataset-load failure returns a
  structured error result instead of throwing

## 3. Docs

- [x] 3.1 Update the worker help page (`GET /`) with the accelerator tools
- [x] 3.2 Update `mcp-worker/README.md` tools table + data note

## 4. Verify

- [x] 4.1 `npm run typecheck` green in `mcp-worker/`
- [x] 4.2 `npm run build` (wrangler dry-run) green
