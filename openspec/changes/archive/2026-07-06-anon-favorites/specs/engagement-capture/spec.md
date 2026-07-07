# Engagement Capture

## ADDED Requirements

### Requirement: Remove an engagement event

The substrate SHALL let a session remove one of its own engagement events, keyed by
`(session, target, type)`. Removal SHALL be idempotent (removing an absent event is a
no-op and an error-free result) and SHALL drop that session's contribution from the
target's aggregate. Removal SHALL be subject to the same CORS, rate-limit, and bot gates as
writes.

#### Scenario: Removing an event drops it from the aggregate

- **WHEN** a session that recorded `(target, type)` removes it
- **THEN** the event no longer exists and the target's deduplicated aggregate no longer
  counts that session

#### Scenario: Removing an absent event is a no-op

- **WHEN** a session removes a `(target, type)` it never recorded (or already removed)
- **THEN** the request succeeds with no change and no error

### Requirement: List a session's engagement events

The substrate SHALL expose, for a given session and event type, the list of targets that
session has engaged. The response SHALL contain only targets — no other session or account
identifiers and no personal data. The listing SHALL resolve by owner, so once a session is
linked to an account it reflects that owner's engagements.

#### Scenario: Lists a session's targets

- **WHEN** a session that recorded several `(target, "favorite")` events requests its list
  for type `favorite`
- **THEN** the response contains exactly those targets and nothing identifying

#### Scenario: Empty when nothing recorded

- **WHEN** a session that recorded nothing requests its list
- **THEN** the response is an empty list, not an error

#### Scenario: Resolves by owner after linking

- **WHEN** two sessions are linked to one account owner and one of them requests its list
- **THEN** the list reflects the owner's engagements across the linked sessions

### Requirement: Bulk threshold-filtered counts read

The substrate SHALL expose a read returning, for an event type and a minimum `N`, every
target whose identity-deduplicated count is at or above `N` — and ONLY those. The response
SHALL contain counts only (no identifiers), SHALL be bounded (a capped maximum number of
targets), and SHALL be safely cacheable at the edge so it does not hit the database per
request. Targets below `N` SHALL NOT appear in the response, so a client cannot learn
sub-threshold counts.

#### Scenario: Returns only at-or-above-minimum targets

- **WHEN** the bulk counts read is requested for a type with minimum `N`
- **THEN** the response includes every target whose deduplicated count is ≥ `N` with its
  count, and excludes every target below `N`

#### Scenario: Sub-threshold counts are never delivered

- **WHEN** a target's deduplicated count is below the requested `N`
- **THEN** that target and its count are absent from the response entirely

#### Scenario: Response is cacheable and bounded

- **WHEN** the bulk counts read responds
- **THEN** it carries caching headers allowing edge/CDN caching and returns at most a capped
  number of targets, so repeated visitor loads do not each query the database
