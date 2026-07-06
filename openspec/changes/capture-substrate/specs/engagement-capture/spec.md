# Engagement Capture

## ADDED Requirements

### Requirement: Anonymous, action-minted session identity

The system SHALL identify an engaging visitor by an opaque, first-party session
identifier that is created ONLY when the visitor takes a deliberate engagement action.
Passive browsing SHALL NOT create or store any identifier. The identifier SHALL NOT be
shared with any third party and SHALL carry no personal data.

#### Scenario: Passive browsing stays anonymous

- **WHEN** a visitor loads and reads pages without taking any engagement action
- **THEN** no engagement session identifier is created or stored, and the existing
  cookieless, consent-free browsing posture is unchanged

#### Scenario: Identifier minted on first action

- **WHEN** a visitor takes their first engagement action (e.g. saving a perk)
- **THEN** an opaque first-party session identifier is created and reused for that
  visitor's subsequent engagement actions

#### Scenario: Identifier is opaque and first-party

- **WHEN** an engagement session identifier exists
- **THEN** it contains no personal data and is never transmitted to a third-party service

### Requirement: Edge-stored engagement events

The system SHALL expose a write endpoint that records an engagement event at the edge,
keyed by the session identifier, a target (e.g. a program id), and an event type. Stored
events SHALL contain no personal data. The store SHALL persist across requests and
deploys without a standing application server.

#### Scenario: An engagement event is recorded

- **WHEN** a valid engagement write arrives with a session, a target, and a type
- **THEN** the event is durably stored and is retrievable through the aggregate read path

#### Scenario: No personal data is stored

- **WHEN** any engagement event is recorded
- **THEN** only the opaque session identifier, target, type, and timestamp are stored —
  no email, name, IP, or other personal data is persisted in the event

### Requirement: Deduplicated, idempotent writes

The system SHALL deduplicate engagement writes by `(session, target, type)` so that a
single session repeating the same action is idempotent and stores at most one event for
that `(session, target, type)`.

#### Scenario: Repeating an action is idempotent

- **WHEN** the same session writes the same `(target, type)` more than once
- **THEN** only one event is stored for that `(session, target, type)`, so that session
  contributes at most once to that target

### Requirement: Session-to-owner indirection for account-elevation

The system SHALL record sessions such that a session can later be linked to an account
owner WITHOUT rewriting any stored event. An event's owner SHALL resolve to the session's
linked account if one exists, otherwise to the session itself. Linking SHALL support
attaching multiple sessions to the same owner, and an anonymous session SHALL require no
personal data to exist.

#### Scenario: Sessions are linkable without touching events

- **WHEN** a session is later associated with an account owner
- **THEN** all of that session's existing events resolve to the new owner, with no event
  rows rewritten

#### Scenario: Many sessions, one owner

- **WHEN** more than one session is linked to the same account owner
- **THEN** every event from those sessions resolves to that single owner

#### Scenario: Anonymous sessions carry no personal data

- **WHEN** a session has never been linked to an account
- **THEN** it holds no personal data and resolves to itself as its own identity

### Requirement: Bot-resistant, rate-limited write path

The write path SHALL resist automated abuse: it SHALL apply per-session and per-IP rate
limits, SHALL restrict cross-origin calls to the site's allowlisted origins, and SHALL
support requiring a human-verification challenge (Turnstile) per event type as an
escalation. A low-stakes engagement action SHALL NOT require a challenge by default.

#### Scenario: Excessive writes are rate-limited

- **WHEN** a single session or IP exceeds the configured write rate
- **THEN** further writes are rejected until the limit window resets, and no events are
  recorded for the rejected requests

#### Scenario: Cross-origin writes are rejected

- **WHEN** a write request originates from an origin not on the allowlist
- **THEN** the request is rejected and no event is recorded

#### Scenario: Challenge can be escalated per action type

- **WHEN** an event type is configured to require human verification
- **THEN** a write of that type without a valid Turnstile token is rejected, while other
  event types continue to accept writes without a challenge

### Requirement: Identity-deduplicated aggregate reads

The system SHALL expose a read path returning, per target, the count of unique
**identities** that engaged it — where an identity is the session's linked account owner
if the session has been elevated to an account, and the session itself otherwise. Counts
SHALL dedup by identity, not by raw session, so one person engaging from several linked
sessions is counted once. The read SHALL be cheap enough to materialize into the static
build and `llms.txt`, and SHALL NOT expose individual session or account identifiers.

#### Scenario: Aggregate reflects unique identities

- **WHEN** the aggregate for a target is read after multiple events from overlapping
  sessions
- **THEN** the returned count equals the number of distinct identities, not the number of
  raw events
- **AND** while no accounts exist, each anonymous session is its own identity, so the
  count equals the number of distinct sessions

#### Scenario: Linked sessions of one identity count once

- **WHEN** several sessions linked to the same account owner have each engaged the same
  target
- **THEN** that target's aggregate counts them as one

#### Scenario: Aggregate exposes no identifiers

- **WHEN** an aggregate is read
- **THEN** the response contains counts only — no session or account identifiers and no
  personal data

### Requirement: Disabled-by-default and build-resilient

The substrate SHALL be configuration-gated. When it is not configured, the static site
SHALL build and serve exactly as today, with the engagement client degrading to a no-op
and no identifier ever created. When the substrate is enabled, its first-party storage
SHALL be disclosed in the Privacy Policy, and the existing cookieless pageview analytics
SHALL remain unaffected.

#### Scenario: Builds with the substrate unconfigured

- **WHEN** the site is built and deployed without the engagement endpoint configured
  (e.g. a fork or CI)
- **THEN** the build succeeds, the engagement client is a no-op, and no identifier or
  event is ever created

#### Scenario: Disclosed when enabled

- **WHEN** the substrate is enabled and able to set a first-party identifier
- **THEN** the Privacy Policy discloses the functional first-party session identifier and
  engagement storage, so published privacy statements remain accurate

#### Scenario: Existing analytics unaffected

- **WHEN** the substrate is enabled
- **THEN** the cookieless Umami pageview analytics continues to run without cookies or a
  consent gate of its own
