# Features

Oxygen covers the full competition lifecycle — from event setup through registration, start draw, SI card readout, and live results.

> Screenshots are auto-generated with GDPR-safe fictional data. Regenerate with `pnpm docs:screenshots`.

## Competition Management

Create competitions from scratch or import directly from Eventor. Multiple competitions can exist side-by-side, each in its own database. Competitions can also connect to remote MySQL databases for distributed setups.

![Competition selector](screenshots/competition-selector.png)

The dashboard shows real-time progress — how many runners have been read, class completion percentages, and overall race status.

![Dashboard](screenshots/dashboard.png)

## Event Setup & Eventor Integration

The event page provides sync controls for the Swedish Orienteering Federation's Eventor system:

- **Eventor Sync** — import entries, classes, clubs, and competitors; upload start lists and results
- **Global Runner Database** — download the full runner database for name/card lookup during registration
- **Club Sync** — fetch club logos and metadata
- **LiveResults** — push live results to liveresultat.se with configurable intervals

![Event page](screenshots/event.png)

## Runner Registration & Management

The runner list shows all registered competitors with their class, club, SI card, and status. Click any row to expand the inline detail pane for quick editing — name, class, club, times, punches, and status are all editable in place with auto-save.

![Runner management with inline editing](screenshots/runners.png)

Select multiple runners using checkboxes to access bulk operations. The floating action bar lets you change class, status, or club for all selected runners at once.

![Bulk editing](screenshots/runners-bulk.png)

## Course, Class & Control Setup

Courses can be imported from OCAD files or IOF XML, or created manually. Each course defines a control sequence with distance and climb data. Classes are assigned to courses, and the system validates that all referenced controls exist. Each class supports configurable options including free start, no timing (for children's/open classes), direct registration, and a maximum allowed running time.

![Course management](screenshots/courses.png)

![Class management](screenshots/classes.png)

![Control management](screenshots/controls.png)

The Controls page tracks both logical controls (used in course definitions) and the physical SI station units that fulfill them. Each physical unit is identified by its SI hardware serial — a single logical control can own multiple units (for redundancy at the same location, or after a mid-race unit replacement with a different code). Battery voltage, last-checked time, programmed code and firmware are tracked per unit, so two stations never overwrite each other's state. When a control is programmed from the UI, the unit row is upserted automatically; backup-memory reads are attributed to the reading unit too.

## Start Draw

The draw engine allocates start times with configurable methods:

- **Club separation** — prevents runners from the same club starting back-to-back
- **Random** — simple random allocation within each class
- **Seeded** — preserves a specific order (e.g., ranking-based)
- **Simultaneous** — mass start for all runners in a class

The graphical timeline shows how classes are distributed across corridors (parallel start lanes) and time. Classes sharing a first control are automatically separated. Drag class bars to rearrange the schedule.

![Draw panel with timeline](screenshots/draw-panel.png)

After applying the draw, the start list shows all runners with their allocated start times.

![Start list](screenshots/start-list.png)

## SI Card Readout & Live Results

Oxygen reads SportIdent cards directly in the browser using the Web Serial API. Supported card types: SI5, SI6, SI8, SI9, SI10, SI11, SIAC, pCard, and tCard.

When a card is read, punches are validated against the course definition and a result is computed instantly — OK, missing punch, or DNF. Results update in real-time as cards are processed. Three-layer stale punch detection prevents data from previous races from polluting results. See [registration-and-readout.md](registration-and-readout.md) for the full technical flow.

![Results](screenshots/results.png)

The cards page shows all readout data, including detailed punch information.

![Cards](screenshots/cards.png)

## Kiosk Mode

A self-service interface for race day operations, designed for a dedicated screen:

- **Registration** — runners insert their SI card, the organizer enters their details, and the runner confirms by re-inserting the card. Smart pre-fill from DB, Eventor, and card owner data (with factory default filtering).
- **Pre-start** — shows course information, clear/check verification, and a countdown to start time
- **Readout** — displays the result (OK, missing punch, DNF) with running time

The kiosk runs in a dark theme and communicates with the admin window via the BroadcastChannel API — no network required.

![Kiosk idle](screenshots/kiosk-idle.png)

![Kiosk readout](screenshots/kiosk-readout.png)

## Start Screen

A dedicated display for the start area, showing runners who are about to start. The screen automatically updates based on the current time, displaying the next group of runners with their class, name, and start time.

![Start screen](screenshots/start-screen.png)

## Test Lab

The built-in Test Lab generates realistic test data for development and demos. It works through four stages:

1. **Generate Classes** — creates a standard Swedish long-distance class setup (38 classes)
2. **Generate Courses** — creates 8 tiered courses with ~50 controls and realistic course sharing
3. **Register Runners** — populate with GDPR-safe fictional runners (randomized Swedish names, mixed SI card types) or real runners from the Eventor database
4. **Race Simulation** — simulates a full race with realistic split times, including DNF, mispunch, and DNS anomalies

The simulation runs server-side so it doesn't depend on keeping the browser tab open. Speed can be adjusted in real-time (instant, 1x, 10x, 50x).

![Test Lab](screenshots/test-lab.png)

## GPS Tracks & Replay

The Tracks page displays GPS route data synced from Livelox, with support for viewing, filtering, and animated replay.

- **Livelox integration** — Event Settings includes a Livelox section where the organizer can enter or auto-detect the Livelox event ID (via Eventor link), then sync all GPS routes into the competition database
- **Runner matching** — Livelox participants are matched to registered runners using a 3-tier strategy: Eventor person ID (ExtId), club-scoped name match with middle-name stripping, and cross-club name fallback
- **Route storage** — GPS waypoints stored in `oxygen_routes` table with nullable FK to `oRunner`/`oClass`, enabling unmatched routes to still appear
- **Tracks page** — Sortable table of all synced routes with class/name filters. Expandable rows show a map preview (O2 map or Livelox map fallback) with the track overlaid, filtered to only show the runner's course controls
- **Replay viewer** — Full animated GPS playback with mass start / real time / legs modes, variable speed (1x–64x), follow mode, and per-runner visibility toggles. Light theme matching Oxygen's UI. Punch pulse animations at control points. Class selector in the header for quick switching
- **Late GPS lock correction** — Runners whose GPS locked after their race start are detected and corrected using `lastWaypoint - result.time` derivation, preventing visual offset in mass-start replays

## Offline Support & PWA

Oxygen works during internet outages — from brief drops to full-day operation at forest venues with no connectivity.

The app is a **Progressive Web App (PWA)** that can be installed on any device. A service worker precaches all static assets and caches API responses, so the app loads instantly even without internet. Competition data (runners, classes, courses, controls, clubs) is pre-fetched and persisted to IndexedDB on station pages, surviving browser restarts and overnight power-off.

When offline, an **event-based mutation queue** stores all actions locally (finish recording, registration, etc.) and drains them to the server when connectivity returns. The finish station can compute results locally using shared readout logic, including course matching, status computation, and position ranking — printing receipts from cached data.

See [offline-architecture.md](offline-architecture.md) for technical details and [future-architecture.md](future-architecture.md) for the post-MeOS vision with event sourcing.

## MeOS Compatibility

Oxygen reads and writes the same MySQL schema as [MeOS](http://www.melin.nu/meos), the established Windows-based orienteering software. Both tools can operate on the same database simultaneously — changes made in MeOS are immediately reflected in Oxygen and vice versa. This allows a gradual migration path where organizers can use Oxygen for web-based features while keeping MeOS for legacy workflows.

Status calculation is fully MeOS-compatible — Oxygen computes all result statuses that MeOS does: OK, DNF, Missing Punch, Over Max Time, No Timing, and Out of Competition. MeOS per-runner flags (TransferFlags) such as OutOfCompetition and NoTiming are respected by the result engine and displayed as badges in the runner detail view. Punch data round-trips correctly including MeOS-specific `@unit` metadata for multi-unit timing setups.
