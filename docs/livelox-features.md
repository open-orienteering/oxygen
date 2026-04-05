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
- [ ] Speed-colored route tails (green→red by pace)
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
