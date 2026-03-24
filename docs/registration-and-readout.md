# Registration, Readout & Kiosk Flow

This document describes the end-to-end flows for SI card registration, readout, and kiosk display. It covers the client-side device handling, server-side data processing, stale punch detection, and the BroadcastChannel-based kiosk protocol.

## Overview

```
SI Card Inserted
    │
    ▼
┌──────────────────────┐
│  Web Serial Reader   │  packages/web/src/lib/webserial.ts
│  (si:card-readout)   │  Browser-side SI protocol over Web Serial API
└─────────┬────────────┘
          │
          ▼
┌──────────────────────┐
│   DeviceManager      │  packages/web/src/context/DeviceManager.tsx
│   addRecentCard()    │  Central card processing pipeline
│                      │
│  1. DOW freshness    │  isPunchDataFresh() — client-side stale check
│  2. storeReadout()   │  Backup to DB + conditional oCard write
│  3. readout query    │  Fetch runner info + course matching
│  4. Action decision  │  "register" | "readout" | "pre-start"
│  5. Auto-apply       │  Write Status/FinishTime if readout
│  6. Kiosk broadcast  │  BroadcastChannel → KioskPage
└─────────┬────────────┘
          │
          ├──── action = "register" ──────▶ RegistrationDialog
          ├──── action = "readout"  ──────▶ Kiosk readout screen + auto-apply
          └──── action = "pre-start" ─────▶ Kiosk pre-start screen
```

## Key Files

| Component | File | Role |
|-----------|------|------|
| SI protocol | `packages/web/src/lib/si-protocol.ts` | Low-level SI card protocol (read/write/parse) |
| Web Serial | `packages/web/src/lib/webserial.ts` | SI reader connection, card read, station programming |
| DeviceManager | `packages/web/src/context/DeviceManager.tsx` | Card processing pipeline, action routing |
| Kiosk channel | `packages/web/src/lib/kiosk-channel.ts` | BroadcastChannel protocol for admin↔kiosk IPC |
| Kiosk page | `packages/web/src/pages/KioskPage.tsx` | Self-service kiosk display (readout, pre-start, registration) |
| Registration dialog | `packages/web/src/components/RegistrationDialog.tsx` | Runner registration form with autocomplete |
| Card readout router | `packages/api/src/routers/cardReadout.ts` | storeReadout, readout query, performReadout |
| Runner router | `packages/api/src/routers/runner.ts` | runner.create (links oCard), runner.update (auto-populate times) |

---

## 1. SI Card Read (Web Serial)

When an SI card is inserted into a connected reader, the WebSerial layer reads the card data and emits events:

1. **`si:card-detected`** — Card physically detected (before data is read). Carries the card number.
2. **`si:card-readout`** — Full card data read. Carries an `SICardReadout` object:

```typescript
interface SICardReadout {
  cardNumber: number;
  cardType: "SI5" | "SI6" | "SI8+" | "SI9" | "SI10" | "SIAC" | ...;
  checkTime?: number;           // seconds since midnight
  startTime?: number;           // seconds since midnight
  finishTime?: number;          // seconds since midnight
  clearTime?: number;           // seconds since midnight
  finishDayOfWeek?: number;     // 1=Mon..7=Sun (from PTD byte)
  checkDayOfWeek?: number;      // 1=Mon..7=Sun
  punches: { controlCode: number; time: number }[];
  punchCount: number;
  ownerData?: { firstName, lastName, sex, dateOfBirth, club, phone, email, country };
  batteryVoltage?: number;      // volts (SIAC only)
  metadata?: { batteryDate, productionDate, hardwareVersion, softwareVersion, clearCount };
}
```

3. **`si:card-removed`** — Card physically removed from the reader.

Supported card types: SI5, SI6, SI8, SI9, SI10, SI11, SIAC, pCard, tCard.

---

## 2. DeviceManager Pipeline

`DeviceManager` is a React context that manages SI reader connections and processes all card events. The main processing function is `addRecentCard(readout)`, triggered by `si:card-readout`.

### 2a. Deduplication

If the same card with identical punch data is scanned within a short window, the duplicate is detected by `readoutsMatch()` (compares card number, start/finish/check times, and punch sequences). Duplicates reuse the existing entry ID instead of creating a new pipeline run.

### 2b. Client-Side Freshness Check

```typescript
function isPunchDataFresh(readout: SICardReadout): boolean
```

SI cards retain punches from previous races until explicitly cleared. The day-of-week (DOW) byte in the card's PTD field encodes which day the punches were recorded. If the finish or check DOW doesn't match today, the data is stale.

- Extracts DOW from `finishDayOfWeek` or `checkDayOfWeek` (SI format: 1=Mon..7=Sun)
- Compares against today's DOW (converted from JS format: 0=Sun..6=Sat)
- Returns `false` if DOW mismatch → punches are from a different day

The result is stored as `hasRaceData` on the card entry and passed to the server as `punchesFresh`.

### 2c. Store Readout (Server Call)

The readout is always sent to the server via `storeReadout`:

```typescript
storeReadout.mutateAsync({
  cardNo,
  punches: [{ controlCode, time }],     // times in seconds
  checkTime, startTime, finishTime,       // seconds since midnight
  cardType, batteryVoltage,
  punchesFresh: boolean,                  // from isPunchDataFresh()
  ownerData: { firstName, lastName, ... },
  metadata: { batteryDate, clearCount, ... },
})
```

The server always backs up the data to `oxygen_card_readouts` (forensic history), but only writes to `oCard` (the MeOS-compatible table) if strict guards pass. See §3 below.

### 2d. Fetch Readout Data

After storing, DeviceManager fetches the runner's full readout via `cardReadout.readout({ cardNo })`. This returns:

- Whether a runner was found for this card number
- Course matching results (punch-by-punch comparison against expected controls)
- Timing data (start, finish, running time, status)
- `punchesMatchCourse` flag (server-side course matching)

### 2e. Action Determination

Based on the DB lookup result:

| Condition | Action | Meaning |
|-----------|--------|---------|
| No runner found for this CardNo | `register` | New runner — open registration dialog |
| Runner found, punches match course OR has existing result | `readout` | Show result on kiosk, auto-apply |
| Runner found, no matching punches, no existing result | `pre-start` | Runner is registered but hasn't raced yet |

"Has existing result" means `Status > 0` excluding DNS (20) and Cancel (21), which are pre-race statuses.

### 2f. Auto-Apply Result

When action is `readout`, DeviceManager automatically writes the result to the database:

```typescript
applyResult.mutateAsync({
  runnerId,
  status,        // 1=OK, 2=DNF, 3=MP
  finishTime,    // deciseconds
  startTime,     // deciseconds
})
```

This persists `Status`, `FinishTime`, and `StartTime` to `oRunner`. The assigned (draw) start time takes priority over the card start punch — the card punch is only used for punch-start events where no draw start is assigned.

### 2g. Kiosk Broadcast

If a kiosk window is paired (same competition), DeviceManager sends the card data via BroadcastChannel. See §5 for the full kiosk protocol.

---

## 3. Server: storeReadout

**File:** `packages/api/src/routers/cardReadout.ts`

This is the core mutation that processes incoming card data on the server.

### 3a. Build MeOS Punch String

Punches are converted from the input format to MeOS's string encoding:

```
Format: "{type}-{seconds}.{tenths};"

Examples:
  3-35940.0;    → check punch at 09:59:00
  1-36000.0;    → start punch at 10:00:00
  41-36120.0;   → control 41 at 10:02:00
  2-36720.0;    → finish punch at 10:12:00
```

Special punch types: `1` = start, `2` = finish, `3` = check. All other numbers are control codes.

### 3b. Foreign Control Check (Stale Detection Layer 2)

The server fetches all control codes defined in the current competition (`oControl.Numbers`) and counts how many of the card's punches are "foreign" (not in any competition control). A ratio-based check determines relevance:

```
foreignCount = punches with control codes NOT in competition
punchesRelevant = foreignCount <= 50% of total punches
```

This is deliberately generous — a single misconfigured control or accidental punch of a non-competition control won't invalidate the entire readout. The three-layer detection (DOW check + this + course matching) ensures stale data is still caught. Completely stale cards from different events will have a majority of foreign controls and be rejected.

### 3c. Backup to History Table

Every readout — stale or fresh — is saved to `oxygen_card_readouts` (raw SQL table, not Prisma). This provides a forensic record of every card scan, useful for post-race debugging. Deduplication: if the most recent entry for this card has identical punch data, the existing row is updated rather than inserting a duplicate.

### 3d. oCard Write Guards

Three conditions must ALL be true to write to `oCard`:

```
shouldWriteOCard = punchesRelevant        // no foreign controls (§3b)
                && hasControlPunches       // punches.length > 0
                && punchesFresh !== false   // client DOW check passed (§2b)
```

If any guard fails, the readout is backed up to history but `oCard` is untouched. This prevents registration scans, stale data, and empty cards from polluting the MeOS-compatible `oCard` table.

Coverage of edge cases:

| Scenario | punchesRelevant | hasControlPunches | punchesFresh | oCard written? |
|----------|----------------|-------------------|-------------|----------------|
| Stale card, different course | false | true | varies | No |
| Stale card, same course, different DOW | true | true | false | No |
| Empty/cleared card | true | false | varies | No |
| Registration scan (card not cleared, same DOW) | true | true | true | Yes (rare edge case) |
| Post-race readout with valid punches | true | true | true | Yes |

The "same course, same DOW" edge case is extremely rare (requires the exact same course to be reused on the same weekday) and is overwritten by the real readout later.

### 3e. Prefer Runner-Linked oCard

When updating an existing oCard, the server prefers the one linked to the runner via `oRunner.Card` FK:

```
1. Look up runner by CardNo
2. If runner has Card FK → use that oCard
3. Else → findFirst by CardNo (non-removed, then any)
```

This prevents the wrong oCard from being updated when multiple rows exist (e.g., one from Oxygen, one from MeOS).

### 3f. ReadId Deduplication

Before writing, a hash is computed from the punch data:

```typescript
function computeReadId(punches, finishTime, startTime): number {
  // MeOS-compatible hash (SICard::calculateHash)
  let h = (punches.length * 100000 + (finishTime ?? 0)) >>> 0;
  for (const p of punches) {
    h = (((h * 31 + p.controlCode) >>> 0) * 31 + p.time) >>> 0;
  }
  return (h + (startTime ?? 0)) >>> 0;
}
```

If the existing oCard's `ReadId` matches the computed hash, the update is skipped (identical data already stored). This matches MeOS's deduplication behavior.

### 3g. Runner Linking

After creating or updating an oCard, if a runner exists with the same CardNo but has no `Card` FK set, the server links them:

```
oRunner.Card = oCard.Id
```

This happens on both the create and update paths, ensuring the FK is always set when possible.

### 3h. Return Value

```typescript
{ cardId: number | null, created: boolean, punchesRelevant: boolean }
```

- `cardId`: the oCard row ID (null if oCard write was skipped)
- `created`: true if a new oCard was created (vs. updated)
- `punchesRelevant`: whether punches passed the foreign control check

---

## 4. Server: Readout & Split Time Computation

### 4a. readout Query

```typescript
cardReadout.readout({ cardNo }) → { found: boolean, runner, timing, controls, ... }
```

Finds a runner by CardNo, then calls `performReadout()` to compute the full result.

### 4b. performReadout()

**Exported from `cardReadout.ts`**, used by multiple routers (race, runner, cardReadout).

Steps:

1. **Load runner** → get Class, Course assignment
2. **Load course** → get expected control sequence
3. **Load card data**:
   - Prefer runner-linked oCard (`oRunner.Card` FK)
   - Fall back to CardNo lookup
   - Also load free punches (`oPunch` records from radio controls)
4. **Parse punches** from MeOS string format:
   ```
   "41-36120.0;42-36240.0;2-36720.0;" → [{type:41, time:361200}, {type:42, time:362400}, ...]
   ```
   Times are converted from `seconds.tenths` to deciseconds.
5. **Merge and sort** card punches + free punches by time
6. **Match to course** via `matchPunchesToCourse()`

### 4c. matchPunchesToCourse Algorithm

Sequential matching of actual punches against expected course controls:

```
Input:  allPunches (sorted by time), courseControls (expected order), fallbackStartTime
Output: matches[], extraPunches[], startTime, finishTime, missingCount

For each expected control:
  Scan forward through remaining punches
  If matching code found → status: "ok", record split/cumulative times
  If not found → status: "missing"

Extra = punches not consumed by any expected control
```

Start time priority:
1. **Assigned start** (from draw) — always preferred
2. **Card start punch** — used only if no assigned start (punch-start events)
3. **0** — if neither available

Split times are computed relative to the previous matched control (or start for the first control).

### 4d. Result Status Determination

```
finishTime === 0        → DNF (Did Not Finish)
missingCount > 0        → MP  (Missing Punch)
runningTime > 0         → OK
else                    → keep existing DB status
```

### 4e. Return Object

```typescript
{
  runner: { id, name, cardNo, startNo, clubName, className, dbStatus },
  course: { id, name, length, controlCount },
  timing: {
    cardStartTime,          // from SI card start punch (deciseconds)
    assignedStartTime,      // from draw (deciseconds)
    startTime,              // effective (assigned > card > 0)
    finishTime,             // deciseconds
    runningTime,            // finish - start (deciseconds)
    status,                 // 1=OK, 2=DNF, 3=MP
  },
  controls: [{              // one per expected control
    controlCode, status,    // "ok" | "missing"
    punchTime, splitTime, cumTime,
  }],
  extraPunches: [...],      // punches not in course
  missingControls: [...],   // control codes with status "missing"
  isRentalCard: boolean,
  hasCard: boolean,
}
```

---

## 5. Runner Create & Update

### 5a. runner.create — oCard Linking

**File:** `packages/api/src/routers/runner.ts`

When a new runner is created with a CardNo, the server checks if an oCard already exists for that card (e.g., from a prior `storeReadout` during the scan) and links it:

```
IF input.cardNo > 0:
  existing = oCard.findFirst({ CardNo, Removed: false })
  IF found → oRunner.Card = existing.Id
```

This ensures the FK is set at registration time, even if the card was scanned before the runner was created.

### 5b. runner.update — Auto-Populate Times on Status→OK

When an admin manually changes a runner's status to OK (e.g., correcting a DNF), the server automatically derives StartTime and FinishTime from the runner's oCard:

```
IF status changed to OK:
  IF StartTime === 0 OR FinishTime === 0:
    result = performReadout(client, runnerId)
    IF result.timing.finishTime !== 0:
      Fill missing StartTime and/or FinishTime from readout
```

This prevents the situation where a runner is marked OK but has no placement because times are zero.

---

## 6. Stale Punch Detection (Three Layers)

SI cards retain punches from previous races until explicitly cleared. Oxygen uses three independent layers to detect stale data:

```
Layer 1: Client DOW Check          Layer 2: Foreign Control Check       Layer 3: Match Score
(DeviceManager)                    (storeReadout server-side)           (readout query)

isPunchDataFresh()                 Compare punch codes against          computeMatchScore()
                                   oControl table
Extracts day-of-week from                                              Scores 0.0–1.0: course
SI card PTD byte.                  If MAJORITY of punches are           match rate minus foreign
If DOW ≠ today/yesterday           foreign → not relevant.              punch penalty (0.10 each).
→ stale.                           Tolerates a few foreign              Score ≥ 0.2 → readout.
                                   punches (misconfigured               Score < 0.2 → pre-start.

Catches: Stale data from           Catches: Stale data from             Catches: Coincidental
2+ days ago. Accepts               different competitions.               overlap, low match rate.
yesterday for night-O.             Tolerates minority foreign.

Result: punchesFresh               Result: punchesRelevant              Result: matchScore (0–1)
(passed to storeReadout)           (guards oCard write)                 (determines readout vs pre-start)
```

All three layers work independently. A card must pass all applicable checks to be treated as a valid readout. The scoring approach ensures that a single misconfigured control or accidental punch doesn't invalidate an entire readout, while completely stale cards from different events are still rejected.

---

## 7. Kiosk Protocol

### 7a. Architecture

The kiosk runs in a separate browser window (or tab) displaying a self-service screen for runners. It communicates with the admin window via the BroadcastChannel API — no network required, works even offline.

```
┌─────────────────┐     BroadcastChannel      ┌──────────────────┐
│  Admin Window    │ ◄══════════════════════► │  Kiosk Window     │
│  (DeviceManager) │  "oxygen-kiosk-{nameId}" │  (KioskPage)      │
│  (RegDialog)     │                           │                   │
│  (CompShell)     │                           │                   │
└─────────────────┘                            └──────────────────┘
```

Channel name: `oxygen-kiosk-{competitionNameId}` — scoped to a specific competition.

### 7b. Message Types

| Message | Direction | When | Payload |
|---------|-----------|------|---------|
| `card-reading` | Admin → Kiosk | Card physically detected | `{ cardNumber }` |
| `card-readout` | Admin → Kiosk | Card fully read, action determined | `{ card: { action, runnerName, status, runningTime, ... } }` |
| `card-removed` | Admin → Kiosk | Card removed from reader | — |
| `registration-state` | Admin → Kiosk | Form data changed (heartbeat, every 2s) | `{ form: { name, className, ... }, ready }` |
| `registration-complete` | Admin → Kiosk | Registration submitted successfully | `{ runner: { name, className, startTime, ... } }` |
| `kiosk-reset` | Admin → Kiosk | Reset to idle (dialog closed, ESC, sticky clear) | — |
| `kiosk-ping` | Both directions | Heartbeat (every 5s during registration) | `{ from: "admin" \| "kiosk" }` |
| `kiosk-print-receipt` | Kiosk → Admin | Kiosk needs receipt printed | `{ runnerId }` |

### 7c. Kiosk State Machine

```
                    card-reading
        idle ─────────────────────▶ reading
         ▲                             │
         │                        card-readout
    auto-reset                    (action determined)
    (15-20s)                           │
         │            ┌────────────────┼────────────────┐
         │            │                │                │
         │       action=readout   action=pre-start  action=register
         │            │                │                │
         │            ▼                ▼                ▼
         │      ┌──────────┐    ┌──────────┐    ┌─────────────────┐
         │      │ card-done│    │ card-done│    │ registration-   │
         │      │ (2s)     │    │ (2s)     │    │ waiting         │
         │      └────┬─────┘    └────┬─────┘    │ (live form      │
         │           │               │          │  preview)       │
         │           ▼               ▼          └────────┬────────┘
         │      ┌──────────┐    ┌──────────┐             │
         │      │ readout  │    │ pre-start│    registration-complete
         │      │ screen   │    │ screen   │             │
         │      └────┬─────┘    └────┬─────┘             ▼
         │           │               │          ┌─────────────────┐
         │           │               │          │ registration-   │
         └───────────┴───────────────┴──────────┤ complete (20s)  │
                                                └─────────────────┘
```

Registration goes directly to `registration-waiting` (no `card-done` transition), since the admin needs to fill the form.

### 7d. Kiosk Screens

**Idle** — Competition name, animated SI card slot, "Insert Card" prompt, live clock.

**Reading** — Animated spinner, "Do Not Remove Card" warning, card number display.

**Card Done** — Success checkmark animation, 2-second transition to result screen.

**Readout** — The main result display:
- Status badge (green OK, red MP, amber DNF)
- Runner name, club, class
- Running time (large)
- Position in class (rank/total)
- Controls matched vs. expected
- Missing controls list (if MP)
- Class results table
- Auto-triggers receipt print

**Pre-Start** — For registered runners who haven't raced:
- Ready/Not Ready badge (based on clear+check validation)
- Course info and distance
- Start time with live countdown ("3 minutes 42 seconds to start")

**Registration Waiting** — While admin fills the form:
- Animated spinner
- Live preview of form data (name, club, class, payment)
- Swish QR code (if applicable)
- 15-second watchdog timer (resets on each `registration-state` message)

**Registration Complete** — After successful registration:
- Green checkmark
- Runner name, club, class
- Assigned start time
- Auto-resets to idle after 20 seconds

### 7e. Standalone Mode

The kiosk can operate independently with its own SI reader (no admin window needed). In standalone mode:

- Kiosk creates its own DeviceManager connection
- Card events are processed locally
- State transitions follow the same logic
- Registration dialog can still be opened (kiosk acts as both admin and display)

Configured via the settings gear icon: "Standalone mode" checkbox.

### 7f. Receipt Printing

The kiosk delegates printing to the admin window (which holds the WebUSB printer connection):

1. Kiosk readout screen detects finish → sends `kiosk-print-receipt` with `runnerId`
2. Admin's CompetitionShell receives message → fetches receipt data via `race.finishReceipt`
3. Admin prints via PrinterContext (WebUSB ESC/POS)

---

## 8. Registration Dialog

### 8a. Trigger

The dialog opens when DeviceManager determines `action = "register"` (no runner found for the scanned card). In sticky mode (kiosk workflow), it stays open between registrations and auto-fills from the next card scan.

### 8b. Pre-Fill Priority

Data sources are applied in strict priority order:

1. **DB runner** (`runner.findByCard`) — If a runner already exists with this CardNo, pre-fill from DB. This always wins.
2. **Eventor lookup** (`eventor.lookupByCardNo`) — If no DB match, check the Swedish Orienteering Federation's database by card number.
3. **Card owner data** (SI card memory) — Only if no DB match AND no Eventor match AND name is empty. Filtered through `isRealOwnerName()`.

```typescript
function isRealOwnerName(firstName?: string, lastName?: string): boolean {
  if (!firstName && !lastName) return false;
  if (firstName && /^\d+$/.test(firstName.trim())) return false;     // "8488001"
  if (lastName && /sportident/i.test(lastName)) return false;        // "SPORTident Sweden"
  return true;
}
```

This filters SPORTident factory defaults (card number as first name, "SPORTident Sweden" as last name) which appear on cards that were never personalized.

Non-name fields (birth year, sex, phone, club) are filled from owner data immediately since they don't conflict with DB lookups.

### 8c. Name Autocomplete

When typing ≥2 characters, the dialog searches two sources:

1. **Eventor club members** — Members of the selected club (if available)
2. **Global runner database** — All runners synced from Eventor

Results are deduplicated, limited to 12, and navigable with arrow keys.

### 8d. Submission

Creates the runner via `runner.create()` with all form fields. After success:

1. Sends `registration-complete` to kiosk
2. Prints registration receipt (if printer connected)
3. Invalidates caches (runner list, dashboard)
4. In sticky mode: clears form, waits 3 seconds, sends `kiosk-reset`

---

## 9. Data Flow: Complete Sequence Diagrams

### Registration (New Runner)

```
Runner inserts SI card
    │
    ▼
WebSerial reads card data
    │
    ▼
DeviceManager.addRecentCard()
    ├── isPunchDataFresh() → punchesFresh
    ├── storeReadout({ punchesFresh }) → backup to oxygen_card_readouts
    │                                    (oCard skipped: empty/stale card)
    ├── cardReadout.readout() → { found: false }
    ├── action = "register"
    └── BroadcastChannel → card-readout { action: "register" }
                                    │
    ┌───────────────────────────────┘
    │                               │
    ▼                               ▼
Admin: RegistrationDialog      Kiosk: registration-waiting
    │                               ▲
    ├── findByCard(cardNo) → null   │
    ├── eventor.lookupByCardNo()    │
    ├── ownerData pre-fill          │
    │                               │
    ├── registration-state ─────────┘  (every 2s)
    │
    ▼
Admin submits form
    ├── runner.create({ cardNo, name, classId, ... })
    │       └── Links existing oCard if found
    ├── registration-complete ──────▶ Kiosk: registration-complete
    └── Print registration receipt
```

### Readout (Existing Runner with Race Data)

```
Runner inserts SI card after racing
    │
    ▼
WebSerial reads card data
    │
    ▼
DeviceManager.addRecentCard()
    ├── isPunchDataFresh() → true
    ├── storeReadout({ punchesFresh: true })
    │       ├── Foreign control check → punchesRelevant: true
    │       ├── Backup to oxygen_card_readouts
    │       ├── oCard created/updated (all guards pass)
    │       │       ├── ReadId dedup check
    │       │       └── Runner linking (oRunner.Card = oCard.Id)
    │       └── return { cardId, punchesRelevant: true }
    │
    ├── cardReadout.readout()
    │       └── performReadout()
    │               ├── Load oCard punches (runner-linked)
    │               ├── Load free punches (oPunch / radio)
    │               ├── Merge + sort by time
    │               ├── matchPunchesToCourse()
    │               └── return { timing, controls, status }
    │
    ├── action = "readout" (punchesMatchCourse: true)
    ├── applyResult() → write Status/FinishTime/StartTime to oRunner
    └── BroadcastChannel → card-readout { action: "readout", status: "OK", ... }
                                    │
                                    ▼
                            Kiosk: card-done (2s) → readout screen
                                    │
                                    ├── Display result (OK/MP/DNF, time, position)
                                    └── kiosk-print-receipt → Admin prints finish receipt
```

### Pre-Start (Registered Runner, No Race Data)

```
Runner inserts SI card at start (card cleared or stale)
    │
    ▼
DeviceManager.addRecentCard()
    ├── isPunchDataFresh() → false (stale) or true (empty)
    ├── storeReadout() → oCard NOT written (guards fail)
    ├── cardReadout.readout() → { found: true, punchesMatchCourse: false }
    ├── action = "pre-start"
    └── BroadcastChannel → card-readout { action: "pre-start" }
                                    │
                                    ▼
                            Kiosk: card-done (2s) → pre-start screen
                                    │
                                    ├── Ready/Not Ready badge
                                    ├── Course info
                                    └── Start time countdown
```

---

## 10. MeOS Compatibility

### oCard Table

The `oCard` table is shared between Oxygen and MeOS. Both systems can read and write to it. Key compatibility points:

- **Punch string format**: Both use `"{type}-{seconds}.{tenths};"` but MeOS may add `@unit` suffixes (e.g., `41-36120.0@42;`). Oxygen's `parsePunches()` strips these.
- **ReadId**: Both compute the same hash for deduplication. Oxygen's `computeReadId()` matches MeOS's `SICard::calculateHash`.
- **Multiple oCard rows**: When both systems create oCards for the same CardNo, Oxygen prefers the runner-linked one. The runner FK (`oRunner.Card`) is the authoritative link.

### Time Format

All times in the database are **deciseconds since midnight** (seconds × 10):

```
10:00:00 → 360000 ds
10:02:00 → 361200 ds
10:12:00 → 367200 ds
```

MeOS may encode times with a DOW component, producing values that look negative or very large. Oxygen's `matchPunchesToCourse()` computes `runningTime = finishTime - startTime`, which gives the correct duration regardless of the absolute time encoding.

### Counter Increments

Every write to `oRunner` or `oCard` must call `incrementCounter()` to update the `oCounter` table. This is how MeOS detects external changes and refreshes its view.
