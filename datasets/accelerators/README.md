# Accelerators dataset

`accelerators.json` is a browseable, agent-friendly directory of startup accelerators, incubators, and founder programs, in the same family as MakerPerks `perks.json`. Where the two schemas share a concept they share a field name (`slug`, `title`, `provider`, `url`, `tags`, `value_type`, `currency`, `max_value`, `value_display`, `region`, `status`, `sources`, `verified`). Accelerator-specific additions: `apply_url`, `category`, `stage`, `equity`, `cohort_model`, `format`, `location`, `next_cohort`, `next_deadline`, `deadline_note`, `eligibility`.

Every entry was verified against the program's own live website on the date in its `verified` field. Entries that could not be confirmed first-party are marked `"status": "Unverified"` and say so in their notes. Dead programs are kept with `"status": "Defunct"` or `"Paused"` as landscape memory.

Status: parked here as a dataset for now. Candidate for a standardized multi-dataset generator (perks, grants, accelerators) — pending design discussion. Not yet wired into the site build; `perks.json` remains generated from `src/content/programs/`.

Privacy note: earlier revisions carried `fit`/`fit_note` (maintainer-founder-profile fit judgments). They were removed 2026-07-31 — fit assessments are personal data and now live per-user in the MCP-AQL adapter profile, never in the published dataset.
