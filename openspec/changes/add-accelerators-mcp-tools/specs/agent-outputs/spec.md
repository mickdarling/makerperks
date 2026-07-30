# agent-outputs

## ADDED Requirements

### Requirement: Accelerators MCP query interface

The MCP server SHALL expose read-only, intent-shaped query tools over the published
accelerators dataset (`datasets/accelerators/accelerators.json`): searching with
combinable filters, fetching one record by slug, and listing programs whose next
application deadline falls within a requested window. Accelerator tooling SHALL load
its dataset independently of perks so a failure in one dataset does not disable the
other's tools.

#### Scenario: Agent searches accelerators

- **WHEN** an MCP client calls `search_accelerators` with any combination of
  free-text query, category, format, region, non-dilutive-only, and minimum value
- **THEN** matching programs are returned sorted by value, highest first, defaulting
  to Active programs only

#### Scenario: Agent asks what deadlines are coming up

- **WHEN** an MCP client calls `upcoming_deadlines` with a day window
- **THEN** programs with a dated `next_deadline` inside the window are returned
  soonest-first with days remaining, and active rolling (no-deadline) programs are
  listed alongside

#### Scenario: Accelerators fetch failure does not break perks

- **WHEN** the accelerators dataset URL is unreachable and no cached copy exists
- **THEN** accelerator tools return a structured error result
- **AND** the perks tools continue to function
