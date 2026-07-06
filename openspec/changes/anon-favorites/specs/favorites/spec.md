# Favorites

## ADDED Requirements

### Requirement: Anonymous save and unsave

A visitor SHALL be able to save a perk and unsave it without an account or any personal
data, from **both the listing cards and the perk page**. On a listing card the control SHALL
be a heart (empty when unsaved, filled when saved) in the card's top-right. A saved perk
SHALL persist for that visitor across page reloads and across pages within the same session,
and unsaving SHALL remove it. The control SHALL give immediate feedback independent of
network round-trips.

#### Scenario: Save from a listing card persists across pages

- **WHEN** a visitor saves a perk via its card heart, then navigates to the perk page (or
  reloads) in the same session
- **THEN** the perk still shows as saved in both places, with no login and no personal data
  collected

#### Scenario: Unsave removes it

- **WHEN** a visitor unsaves a previously saved perk
- **THEN** the perk no longer shows as saved anywhere for that visitor, and their
  my-favorites view no longer lists it

#### Scenario: Feedback is immediate

- **WHEN** a visitor toggles save on a perk
- **THEN** the control reflects the new state immediately, without waiting on the server
  response

### Requirement: My-favorites view

A visitor SHALL have a view listing the perks they have saved, rendered from their own
session. When they have saved nothing, the view SHALL show a clear empty state rather than
an error or a blank page.

#### Scenario: Lists saved perks

- **WHEN** a visitor who has saved one or more perks opens the my-favorites view
- **THEN** it lists exactly those perks, linking to each perk page

#### Scenario: Empty state

- **WHEN** a visitor who has saved nothing opens the my-favorites view
- **THEN** it shows a clear empty state inviting them to browse, not an error

### Requirement: Threshold-gated popularity counts, loaded client-side

A perk page SHALL display how many distinct people saved the perk **only when that count is
at or above a configured threshold**; below the threshold NO count SHALL be shown — never a
zero or a small number. Counts SHALL be loaded in the browser and cached in localStorage
(stale-while-revalidate): rendered from cache on load, refreshed on a TTL and after a write,
and updated in place when fresh data arrives. The displayed count SHALL be the substrate's
identity-deduplicated aggregate, and the threshold SHALL be enforced at the source so
sub-threshold counts are never delivered to the client.

#### Scenario: Count shown at or above the threshold

- **WHEN** counts have loaded and a perk's deduplicated save count is at or above the
  configured threshold
- **THEN** the perk page shows the count quietly (e.g. a "saved by N+" treatment)

#### Scenario: Count hidden below the threshold

- **WHEN** a perk's save count is below the threshold (including zero)
- **THEN** no save count is shown for that perk, and the source never delivers that count to
  the client

#### Scenario: Nothing rendered before counts load

- **WHEN** a page first loads with no cached counts and the count has not yet been fetched
- **THEN** no count-dependent element is rendered (no zero, no placeholder); the count
  appears only once data has loaded and the perk meets the threshold

#### Scenario: Count is deduplicated

- **WHEN** a count is shown
- **THEN** it reflects distinct identities (the substrate's owner-deduped aggregate), not
  raw save events

### Requirement: Counts never block or depend on the build

The site build SHALL NOT fetch, embed, or commit save counts; counts are a purely runtime,
client-side concern. The build SHALL succeed whether or not the engagement endpoint is
configured or reachable, with no count data baked into the output.

#### Scenario: Build is independent of counts

- **WHEN** the site is built
- **THEN** it succeeds without contacting the engagement endpoint for counts, and no count
  values are present in the static output

### Requirement: Graceful disable of the favorites surface

When the engagement endpoint is unconfigured, the Save hearts and counts SHALL NOT render,
and no session identifier SHALL be created — preserving the cookieless posture for visitors
who never engage.

#### Scenario: No engagement surface when disabled

- **WHEN** a visitor loads the site built without the engagement endpoint
- **THEN** no Save hearts and no counts appear, and no engagement session identifier is
  created
