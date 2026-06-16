# Livelox Feature Reference

Research notes from reverse-engineering Livelox (March 2026). Use as a roadmap for which features to implement in Oxygen's replay viewer.

## Livelox API (reverse-engineered)

**Authentication**: No login required for public events. Requires headers:
- `X-Requested-With: XMLHttpRequest`
- `Origin: https://www.livelox.com`
- `Content-Type: application/json`

**Data flow**:
1. `POST /Data/ClassInfo` with `{"classIds":[ID]}` → event metadata + `classBlobUrl`
2. `GET <classBlobUrl>` (Azure blob) → full data blob with map, tiles, courses, participants
3. Route data is custom base64 encoded (see `packages/api/src/livelox/decoder.ts`)

**Key endpoints**: `/Data/ClassInfo`, `/Data/ClassBlob`, `/Data/Routes`, `/Data/Maps`, `/Data/Map`, `/Data/CoursesForClass`, `/Data/Reproject`, `/Data/Deproject`

---

## Relay legs and forked courses

Relays (e.g. Jukola) are modelled as a **single Livelox class** with multiple
legs and forked courses. Both are handled in `packages/api/src/livelox/` and
surfaced by `ReplayViewer`.

### Multiple relay legs

- `ClassInfo` returns the available legs in `general.class.relayLegs`
  (`[{leg, name, participantCount}, …]`). For Kotka-Jukola 2026 that's 7 legs.
- A specific leg's blob is requested by adding `relayLegs:[N]` to the
  `ClassInfo` body (the **array** form — a singular `relayLeg` field is ignored
  upstream). The response `classBlobUrl` then points at `…_relayLeg_0N_…`. With
  no `relayLegs` field, Livelox returns the first leg.
- Each leg's blob carries its own map, its own forked courses, and its own
  runners, so legs are loaded **lazily, one at a time**. `importClass` takes an
  optional `relayLeg`; `ReplayData.relay` describes the available legs and which
  one is loaded; the viewer renders a leg switcher in its title bar. Each
  `(classId, relayLeg)` pair is its own query, so switching back is instant.

### Forked courses

- A forked leg's blob contains one `course` per fork (leg 1 of Kotka-Jukola
  has 18: `J101`–`J118`), each with its own ordered control list.
- Runners carry no `courseId`; the fork is recovered by matching the punched
  control sequence (`result.splitTimeData`) against each fork's control codes.
  Runners punch spectator/arena controls (e.g. a TV passage, code `500`) that
  belong to no course, so codes absent from every fork are dropped before
  matching. An exact sequence match wins (~92% of runners); DNF/MP runners fall
  back to the best positional match. The matched fork id lands on
  `ReplayRoute.courseId` (see `matchFork` in `transform.ts`).
- Rendering (`ReplayCourseLayer` + `fork-selection.ts`): when all visible
  runners share one fork it is drawn in detail with sequential control numbers;
  when they span several forks the forks are drawn merged ("union") with
  control-code labels only (no sequential numbering, since the order differs per
  fork). A **"All forks"** toggle overlays every fork — faint behind a
  highlighted single fork, or as the full union.

Legs mode is **fork-aware**: each runner's leg boundaries come from their own
matched fork (`route.courseId`), so when two runners on different forks are
compared control-to-control, the faster one freezes at *its own* next control
and waits for the slower one, then both advance at the shared merge. Forks with
differing control counts (leg 6 has 25- and 26-control forks) are aligned by
leg ordinal — each runner still waits at its own controls. See
`leg-timing.ts` (`buildRouteControlTimes`).

> Known limitation: restart-from-control still indexes the single reference
> course (`courses[0]`) and is therefore disabled for forked relay legs (a
> control click just toggles play). Fork-aware restart-from-control is a
> follow-up.

---

## Speed-coloured track overlay

Beyond watching the race unfold live, the viewer can lay out each selected
runner's **whole route** statically, coloured by running speed — Oxygen's take
on Livelox's `speedColored` route style plus its route-tick drawer.

- Toggled by a **`Tracks`** button in the title bar (sibling of `Heatmap` /
  `Nearby`). Driven by the current selection (`state.visibleParticipants`): one
  runner gives a clean trace, several overlay together.
- It is a pure overlay — it **coexists** with the heatmap and with live playback
  dots, and never alters the heatmap's colouring. To stay legible on top of the
  warm orange heatmap it uses a separate **cool** colour range: deep blue (slow)
  → cyan → green (fast). Speed per point is smoothed over a ~12 s window and
  normalised to each runner's own p5..p95 range so a GPS spike or a stop doesn't
  wash out the scale.
- **Time ticks** (white dots, default every 60 s) mark pace along the track —
  closely-spaced dots mean slow, widely-spaced mean fast — mirroring Livelox's
  tail-tick drawer.
- Implementation: `ReplaySpeedTrackLayer` mirrors `ReplayHeatmapLayer`'s
  offscreen-blit design (the track is pre-rendered once in map-pixel space and
  blitted with the viewport transform). Because the track is static it only
  subscribes to viewport changes, not the elapsed-time bus, so it adds no
  per-frame cost. Colour/speed/tick maths live in the pure, unit-tested
  `speed-color.ts`.

> Not yet copied from Livelox: an on-screen colour legend and user-adjustable
> fast/slow pace thresholds (`Color range` sliders). The thresholds are
> currently fixed at the per-runner p5..p95 range.

---

## View Modes (4 tabs)

### 1. Replay (Player)
- Animated GPS routes on map with moving position markers
- **Player modes**: `replay`, `pause`, `live`
- **Route styles**:
  - `monochrome` — distinct solid color per runner (default)
  - `monochromeByClass` — all runners in same class share a color
  - `speedColored` — route color varies by pace (green→yellow→red via configurable ColorRange)
- **Route drawers**: `MonochromeRouteDrawer`, `ColorCodedRouteDrawer`, `GradientRouteDrawer`
- **Tail tick drawer** — time graduation tick marks along route trail
- **Speed slider** — continuous replay speed (default 10x)
- **Timeline scrubber** — `TimeSliderCanvas` at bottom
- **Tail length** — configurable trail behind moving dot (default 60s)
- **Start modes**:
  - Real clock time
  - Mass start (all from 0:00)
  - Ctrl+click on any control → mass start from that point
  - Synchronized control starts
- **Name labels** next to markers (toggleable)
- **Participant info boxes** (toggleable, configurable size)
- **Live delay** — configurable anti-coaching delay (default 15s)
- **Speed graph** — pace over time for selected participant (s/km)
- **Speed distribution graph** — kernel density of pace for all visible participants

### 2. Legs
- Course split into control-to-control legs, one displayed at a time
- **Numbered leg bar** — click any number to jump, arrow buttons for prev/next
- **Route styles**: `monochrome` or `timeColored` (default: green→red by ranking)
- **Leg info header**: control X→Y, leg distance, distance from start
- **Performance table**: Name, Time, Distance, Pace sorted fastest-first
- **Custom segments**: Ctrl+drag on leg bar for arbitrary sub-sections
- **Special legs**: `customLeg`, `wholeCourse`

### 3. Duel
- Head-to-head comparison of exactly 2 runners per leg
- **Two participant dropdowns**
- **Reference mode**: `best` (auto-picks fastest per leg) or `lock`
- **Route proximity**: `DuelDrawer` classifies segments as `faster`/`slower`/`neutral`
- Dotted lines = same route choice, solid = divergent routes
- **Duel chart** — cumulative time gain/loss bar chart
- **Properties**: time, distance, speed; percentual toggle

### 4. Table
- Split time matrix: controls × participants
- **5 table types** (from source `tableType` enum):
  - `time` (0) — split times + cumulative
  - `distance` (1) — actual route distance (m)
  - `speed` (2) — pace from actual route distance (min/km)
  - `controlStraightLineSpeed` (3) — pace from beeline distance
  - `controlStraightLineDistanceRatio` (4) — actual/straight-line distance %
- **Split time sources**: `result` (electronic punch), `calculated` (GPS), `none`
- **Highlighting**: best=red, 2nd/3rd=blue per leg

---

## Map & Course Display
- **Map opacity** slider (default 1.0)
- **Course opacity** slider (default 0.9)
- **Control numbers** toggle (default on)
- **Map types**: `image`, `google`, `mapAntSweden`, `mapAntFinland`
- **Map rotation** (Shift+scroll)
- **North align** toggle
- **Overview map** modal
- **Download map** with options: map only, with course, with routes

## Route Rendering Settings
- **Opacity** slider per participant
- **Size** (thickness) control
- **Border width percentage** slider
- **Route ticks** toggle (time marks along trail)
- **Color range** for speed coloring — fastest/slowest pace thresholds

## Camera / Follow Modes
- `FollowVisibleParticipantsOnCourseViewportCalculator` — auto-fit all visible
- `FollowSelectedParticipantOnCourseViewportCalculator` — track one runner
- `CenterSelectedParticipantViewportCalculator` — center without auto-zoom
- `FollowVisibleParticipantsOnLegViewportCalculator` — leg view variant

## Other Features
- **Merge classes/courses** — view multiple classes on one map
- **Pseudo-class creation** — custom grouping from different classes
- **Route calibration** — shift GPS track offset
- **Manual route drawing** — `RouteEditor` with waypoint mode
- **Route image export** — with rotation support
- **Presentation mode** flag
- **Virtual routes** — participants without GPS data positioned at controls from split times
- **Force calculate split times** — GPS proximity-based virtual punches

---

## Subscription Tiers (from `viewerFeatureLevel` enum)
- `singleRoute` — one route at a time (free)
- `longestLegOnly` — leg/duel only on longest leg (free)
- `full` — all features (premium)
- `isMultiRoute` — multi-route check

## Technology
- HTML5 Canvas 2D (not WebGL)
- Knockout.js (ko.observable) for reactive UI
- jQuery for DOM
- SignalR for live data streaming
- Google Maps JS API for background tiles

---

## Implementation Priority for Oxygen

### Phase 1 (Done)
- [x] Replay mode with animated routes
- [x] Mass start / real time toggle
- [x] Participant show/hide
- [x] Livelox data import
- [x] Eventor event ID → Livelox class lookup (via Eventor WebURL field)
- [x] GPS route sync into `oxygen_routes` DB table (with oRunner/oClass name matching)
- [x] Tracks page — list, filter, map preview, delete
- [x] Replay from Tracks page (single route or full class)
- [x] Event Settings Livelox section (event ID, auto-detect, sync)

### Phase 2 (Next)
- [x] Speed-coloured tracks — static full-route overlay, cool ramp + time ticks (`ReplaySpeedTrackLayer`); see "Speed-coloured track overlay" above
- [ ] Tail length control
- [ ] Follow participant (auto-pan/zoom)
- [ ] Keyboard shortcuts (space=play/pause, arrows=scrub)

### Phase 3
- [ ] Legs view (leg-by-leg analysis with ranking)
- [ ] Split time table
- [ ] Ctrl+click mass start from any control

### Phase 4
- [ ] Duel mode
- [ ] Speed graph
- [ ] Speed distribution graph
- [ ] Custom segment analysis

### Phase 5
- [ ] Own GPS data collection integration (replace Livelox import)
- [ ] Live tracking on dashboard map
- [ ] GPX/FIT/TCX file import
