/**
 * Pure merge rules of the Eventor import and sync (review package 5, no
 * database access, docs/system/eventor-sync.md).
 *
 * A re-sync must not undo what the desk did. Every runner and class carries a
 * snapshot of the values the last import/sync stored. An Eventor value is
 * applied only when
 *
 *   1. Eventor has an opinion (a card of 0, an unknown class, an empty
 *      nationality are "no opinion", never "clear it"), and
 *   2. the local value still equals the snapshot (nobody edited it since).
 *
 * Without a snapshot (a row from before the snapshot existed) nothing is
 * written; the sync seeds the snapshot and reports the difference.
 */

// ─── Card numbers ───────────────────────────────────────────────────────────

const INT32_MAX = 2_147_483_647;

/** Clamp a number into signed-INT32 range; non-finite → 0. */
export function clampInt32(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n > INT32_MAX) return INT32_MAX;
  if (n < -INT32_MAX - 1) return -INT32_MAX - 1;
  return n | 0;
}

/**
 * Normalize an Eventor card number for storage. The `runners` table uses
 * NULL — not 0 — for "no card" and enforces a partial unique index on
 * (event_id, card_no) WHERE removed = false, so writing 0 for a second
 * cardless runner would violate the constraint. Non-positive → null.
 */
export function normalizeCardNo(raw: number | null | undefined): number | null {
  const v = clampInt32(raw ?? 0);
  return v > 0 ? v : null;
}

/**
 * Card-number claimer for one import/sync pass, guarding the partial
 * unique index on (event_id, card_no). The first owner to claim a card
 * keeps it; a later claim by a different owner gets `fallback` instead
 * (null for creates, the runner's current card for sync updates).
 * Eventor data does contain duplicate card numbers (shared/loaned
 * cards, data-entry mistakes), and one bad pair must not abort the
 * whole import.
 */
export function makeCardNoClaimer(
  existing: Iterable<{ ownerKey: string; cardNo: number | null }> = [],
): (
  raw: number | null | undefined,
  ownerKey: string,
  fallback?: number | null,
) => number | null {
  const ownerByCard = new Map<number, string>();
  for (const e of existing) {
    if (e.cardNo != null && e.cardNo > 0) ownerByCard.set(e.cardNo, e.ownerKey);
  }
  return (raw, ownerKey, fallback = null) => {
    const v = normalizeCardNo(raw);
    if (v === null) return null;
    const owner = ownerByCard.get(v);
    if (owner !== undefined && owner !== ownerKey) return fallback;
    ownerByCard.set(v, ownerKey);
    return v;
  };
}

// ─── The field rule ─────────────────────────────────────────────────────────

export interface FieldMerge {
  /** Apply Eventor's value to the local row. */
  write: boolean;
  /** The local value differs from Eventor's. */
  differs: boolean;
  /**
   * A local value was kept over a different Eventor value that is new to us
   * (Eventor changed it since the snapshot, or there is no snapshot): what
   * the sync preview calls "kept local". A local edit Eventor never
   * contradicted is not counted.
   */
  kept: boolean;
}

/**
 * One field. `next === undefined` is "Eventor has no opinion"; `prev ===
 * undefined` is "no snapshot of this field".
 */
export function mergeField<T>(
  local: T,
  prev: T | undefined,
  next: T | undefined,
): FieldMerge {
  if (next === undefined) return { write: false, differs: false, kept: false };
  if (prev === undefined) {
    const differs = local !== next;
    return { write: false, differs, kept: differs };
  }
  if (local === prev) return { write: local !== next, differs: false, kept: false };
  const differs = local !== next;
  return { write: false, differs, kept: differs && next !== prev };
}

/**
 * The runner has done something at the desk or in the forest: a card read
 * out, a finish time, or a result status. Such a runner is never cancelled or
 * moved to another class by a sync.
 */
export function hasLocalActivity(r: {
  cardId: string | null;
  finishTime: number;
  status: string;
}): boolean {
  return (
    r.cardId != null ||
    // Stored relative: a finish before ZeroTime is negative (RES-05).
    r.finishTime !== 0 ||
    !["unknown", "no_timing", "cancel"].includes(r.status)
  );
}

// ─── Snapshots ──────────────────────────────────────────────────────────────

/** What the last sync stored or saw for a runner; every key optional (a partial one is valid). */
export interface RunnerSnapshot {
  name?: string;
  card_no?: number | null;
  /** Eventor's class id (not the local uuid). */
  class_eventor_id?: number | null;
  club_eventor_id?: number | null;
  club_name?: string;
  birth_year?: number;
  sex?: string;
  nationality?: string;
  /** false once the sync saw the runner missing from Eventor. */
  present?: boolean;
  /** The sync itself cancelled her (not the desk): only then is she reinstated. */
  cancelled_by_sync?: boolean;
  synced_at?: string;
}

export interface ClassSnapshot {
  name?: string;
  sex?: string;
  low_age?: number;
  high_age?: number;
  /** null = Eventor gave no answer when the class was created. */
  no_timing?: boolean | null;
  sort_index?: number;
  class_type?: string;
}

const EMPTY_RUNNER_SNAPSHOT = {
  name: "",
  card_no: null,
  class_eventor_id: null,
  club_eventor_id: null,
  club_name: "",
  birth_year: 0,
  sex: "",
  nationality: "",
} as const;

export function asRunnerSnapshot(raw: unknown): RunnerSnapshot | null {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as RunnerSnapshot) : null;
}

export function asClassSnapshot(raw: unknown): ClassSnapshot | null {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as ClassSnapshot) : null;
}

function sameSnapshot(a: object | null, b: object): boolean {
  if (!a) return false;
  const strip = (o: object) => {
    const { synced_at: _s, ...rest } = o as Record<string, unknown>;
    return JSON.stringify(Object.entries(rest).sort(([x], [y]) => x.localeCompare(y)));
  };
  return strip(a) === strip(b);
}

// ─── What differs from Eventor (shown beside a runner) ──────────────────────

export type EventorDiffField =
  | "name"
  | "cardNo"
  | "classId"
  | "club"
  | "birthYear"
  | "sex"
  | "nationality";

export const EVENTOR_DIFF_FIELDS: readonly EventorDiffField[] = [
  "name",
  "cardNo",
  "classId",
  "club",
  "birthYear",
  "sex",
  "nationality",
];

export interface RunnerLocalView {
  name: string;
  cardNo: number | null;
  /** Eventor id of the runner's local class, null when it has none. */
  classEventorId: number | null;
  eventorClubId: number | null;
  birthYear: number;
  sex: string;
  nationality: string;
}

export interface EventorDiffEntry {
  field: EventorDiffField;
  /** For `classId` the Eventor class id; for `club` the club name. */
  local: string | number | null;
  eventor: string | number | null;
  /** The local club name, for the `club` field (the id is compared). */
}

/**
 * The fields where the runner's current value differs from what Eventor last
 * said. One function for the runner list marker and the detail view.
 */
export function runnerEventorDiff(
  local: RunnerLocalView & { clubName: string },
  snap: RunnerSnapshot | null,
): EventorDiffEntry[] {
  if (!snap) return [];
  const out: EventorDiffEntry[] = [];
  if (snap.name && snap.name !== local.name) {
    out.push({ field: "name", local: local.name, eventor: snap.name });
  }
  if (snap.card_no != null && snap.card_no !== local.cardNo) {
    out.push({ field: "cardNo", local: local.cardNo, eventor: snap.card_no });
  }
  if (snap.class_eventor_id != null && snap.class_eventor_id !== local.classEventorId) {
    out.push({ field: "classId", local: local.classEventorId, eventor: snap.class_eventor_id });
  }
  if (snap.club_eventor_id != null && snap.club_eventor_id !== local.eventorClubId) {
    out.push({ field: "club", local: local.clubName, eventor: snap.club_name ?? "" });
  }
  if (
    snap.club_eventor_id != null &&
    snap.club_eventor_id === local.eventorClubId &&
    snap.club_name &&
    snap.club_name !== local.clubName
  ) {
    out.push({ field: "club", local: local.clubName, eventor: snap.club_name });
  }
  if (snap.birth_year && snap.birth_year !== local.birthYear) {
    out.push({ field: "birthYear", local: local.birthYear, eventor: snap.birth_year });
  }
  if (snap.sex && snap.sex !== local.sex) {
    out.push({ field: "sex", local: local.sex, eventor: snap.sex });
  }
  if (snap.nationality && snap.nationality !== local.nationality) {
    out.push({ field: "nationality", local: local.nationality, eventor: snap.nationality });
  }
  return out;
}

// ─── Class plan ─────────────────────────────────────────────────────────────

export interface EventorClassInput {
  classId: number;
  name: string;
  sex: string;
  lowAge: number;
  highAge: number;
  sequence: number;
  classType: string;
  noTiming?: boolean;
}

export interface ExistingClass {
  id: string;
  name: string;
  eventorId: number | null;
  sortIndex: number;
  sex: string;
  lowAge: number;
  highAge: number;
  noTiming: boolean;
  classType: string;
  snapshot: ClassSnapshot | null;
}

export interface ClassData {
  name?: string;
  sex?: string;
  lowAge?: number;
  highAge?: number;
  noTiming?: boolean;
  sortIndex?: number;
  classType?: string;
}

export interface ClassPlan {
  creates: Array<{
    eventorId: number;
    data: Required<ClassData>;
    snapshot: ClassSnapshot;
  }>;
  updates: Array<{
    id: string;
    eventorId: number;
    data: ClassData;
    snapshot: ClassSnapshot | null;
  }>;
  /** Classes with at least one local value kept over a different Eventor one. */
  keptLocal: number;
  /** Eventor did not say which classes are no-timing (export/classes failed). */
  detailsIncomplete: boolean;
}

export function planClassSync(input: {
  existing: ExistingClass[];
  eventor: EventorClassInput[];
}): ClassPlan {
  const byEventorId = new Map(
    input.existing.filter((c) => c.eventorId !== null).map((c) => [c.eventorId as number, c]),
  );
  const plan: ClassPlan = {
    creates: [],
    updates: [],
    keptLocal: 0,
    detailsIncomplete: input.eventor.some((c) => c.noTiming === undefined),
  };
  let maxSortIdx = Math.max(0, ...input.existing.map((c) => c.sortIndex));
  const seenNew = new Set<number>();

  for (const ec of input.eventor) {
    const row = byEventorId.get(ec.classId);
    const classType = (ec.classType ?? "").substring(0, 81);
    if (!row) {
      if (seenNew.has(ec.classId)) continue;
      seenNew.add(ec.classId);
      maxSortIdx += 10;
      const sortIndex = ec.sequence > 0 ? ec.sequence : maxSortIdx;
      plan.creates.push({
        eventorId: ec.classId,
        data: {
          name: ec.name,
          sex: ec.sex || "",
          lowAge: ec.lowAge,
          highAge: ec.highAge,
          noTiming: ec.noTiming ?? false,
          sortIndex,
          classType,
        },
        snapshot: {
          name: ec.name,
          sex: ec.sex || "",
          low_age: ec.lowAge,
          high_age: ec.highAge,
          no_timing: ec.noTiming ?? null,
          sort_index: sortIndex,
          class_type: classType,
        },
      });
      continue;
    }

    const prev = row.snapshot ?? {};
    const data: ClassData = {};
    const snap: ClassSnapshot = { ...prev };
    let kept = false;
    const field = <T>(
      local: T,
      prevVal: T | undefined,
      next: T | undefined,
      key: keyof ClassData,
      snapKey: keyof ClassSnapshot,
    ) => {
      const m = mergeField(local, prevVal, next);
      if (m.write) (data as Record<string, unknown>)[key] = next;
      if (m.kept) kept = true;
      if (next !== undefined) (snap as Record<string, unknown>)[snapKey] = next;
    };
    field(row.name, prev.name, ec.name || undefined, "name", "name");
    field(row.sex, prev.sex, ec.sex || "", "sex", "sex");
    field(row.lowAge, prev.low_age, ec.lowAge, "lowAge", "low_age");
    field(row.highAge, prev.high_age, ec.highAge, "highAge", "high_age");
    // A class created while Eventor gave no no-timing answer stored `false`.
    field(
      row.noTiming,
      row.snapshot ? (prev.no_timing ?? false) : undefined,
      ec.noTiming,
      "noTiming",
      "no_timing",
    );
    field(row.sortIndex, prev.sort_index, ec.sequence > 0 ? ec.sequence : undefined, "sortIndex", "sort_index");
    field(row.classType, prev.class_type, classType || undefined, "classType", "class_type");

    if (kept) plan.keptLocal++;
    const snapChanged = !sameSnapshot(row.snapshot, snap);
    if (Object.keys(data).length > 0 || snapChanged) {
      plan.updates.push({
        id: row.id,
        eventorId: ec.classId,
        data,
        snapshot: snapChanged ? snap : null,
      });
    }
  }
  return plan;
}

// ─── Runner plan ────────────────────────────────────────────────────────────

export interface EntryInput {
  personName: string;
  personId: number;
  birthYear: number;
  sex: string;
  nationality: string;
  organisationId: number;
  organisationName: string;
  classId: number;
  cardNo: number;
  eventorEntryId: number;
  entryDate: number;
  entryTime: number;
  fee: number;
  paid: number;
  taxable: number;
  rankingScore: number;
  noTiming: boolean;
}

export interface ResultInput {
  personId: number;
  personName: string;
  birthYear: number;
  sex: string;
  nationality: string;
  organisationId: number;
  organisationName: string;
  classId: number;
  cardNo: number;
  startTime: number;
  finishTime: number;
  status: number;
  bib: string;
}

export interface ExistingRunner {
  id: string;
  /** null for a runner created from an entry that had no person id. */
  eventorPersonId: number | null;
  /** The Eventor entry id; the match key when there is no person id. */
  eventorEntryId: number | null;
  /** In a class that has no Eventor id (made or moved to at the desk). */
  classLocalOnly?: boolean;
  removed: boolean;
  name: string;
  cardNo: number | null;
  cardId: string | null;
  /** Eventor id of the runner's local class, null when none or a local-only class. */
  classEventorId: number | null;
  eventorClubId: number | null;
  clubName: string;
  birthYear: number;
  sex: string;
  nationality: string;
  startTime: number;
  finishTime: number;
  /** Prisma enum name (`unknown`, `cancel`, …). */
  status: string;
  entrySource: number;
  entryDate: number;
  entryTime: number;
  feeCents: number;
  paidCents: number;
  taxableCents: number;
  rank: number;
  snapshot: RunnerSnapshot | null;
}

export interface RunnerData {
  name?: string;
  /** Backfilled when an entry that had no person id gains one. */
  eventorPersonId?: number;
  cardNo?: number | null;
  /** Eventor id of the (known) class to move the runner to. */
  classEventorId?: number;
  clubName?: string;
  eventorClubId?: number;
  birthYear?: number;
  sex?: string;
  nationality?: string;
  entrySource?: number;
  entryDate?: number;
  entryTime?: number;
  feeCents?: number;
  paidCents?: number;
  taxableCents?: number;
  rank?: number;
  status?: string;
}

export interface RunnerCreate {
  personId: number;
  eventorEntryId: number | null;
  name: string;
  classEventorId: number | null;
  clubName: string;
  eventorClubId: number | null;
  cardNo: number | null;
  birthYear: number;
  sex: string;
  nationality: string;
  entryDate: number;
  entryTime: number;
  /** Absolute deciseconds (the caller converts with `toRelative`); 0 = none. */
  startTime: number;
  finishTime: number;
  status: string;
  bib: string;
  feeCents: number;
  paidCents: number;
  taxableCents: number;
  rank: number;
  snapshot: RunnerSnapshot;
}

export interface RunnerPlan {
  creates: RunnerCreate[];
  updates: Array<{
    id: string;
    name: string;
    data: RunnerData;
    /** null = snapshot unchanged. */
    snapshot: RunnerSnapshot | null;
  }>;
  cancels: Array<{ id: string; name: string; snapshot: RunnerSnapshot }>;
  /** Missing from Eventor but with local activity: only marked "gone". */
  heldBack: Array<{ id: string; name: string; snapshot: RunnerSnapshot }>;
  counts: {
    added: number;
    updated: number;
    keptLocal: number;
    wouldCancel: number;
    heldBack: number;
    reinstated: number;
    classChangeBlocked: number;
    cardConflicts: number;
    /** A second entry of a person already in this pass (only the first is used). */
    duplicateEntries: number;
    /** Entries or results with neither a person id nor an entry id: nothing to match on. */
    skippedNoId: number;
    /** Persons only in the results, not created by a re-sync (only the first import takes results). */
    skippedResultsOnly: number;
  };
}

const CANCEL = "cancel";

export function planRunnerSync(input: {
  /**
   * true only for the first import of an event, which alone may write times,
   * status and bib from the results (docs/system/eventor-sync.md, rule 4).
   */
  firstImport?: boolean;
  /** Stamped as `entry_source` on runners that have none. */
  eventorEventId: number;
  /** Every Eventor-linked runner of the event, removed ones included. */
  existing: ExistingRunner[];
  /** Cards of every non-removed runner (the claimer's start state). */
  cardOwners: Array<{ ownerKey: string; cardNo: number | null }>;
  entries: EntryInput[];
  results: ResultInput[];
  /** Eventor class ids that exist (or will exist) locally. */
  knownClassEventorIds: ReadonlySet<number>;
  clubNameByEventorId: ReadonlyMap<number, string>;
  now?: Date;
}): RunnerPlan {
  const now = (input.now ?? new Date()).toISOString();
  const claimCardNo = makeCardNoClaimer(input.cardOwners);
  const keyOf = (personId: number | null, entryId: number | null): string | null =>
    personId != null && personId > 0 ? `p${personId}` : entryId != null && entryId > 0 ? `e${entryId}` : null;
  const byKey = new Map<string, ExistingRunner>();
  for (const r of input.existing) {
    const k = keyOf(r.eventorPersonId, r.eventorEntryId);
    if (k) byKey.set(k, r);
  }
  // Runners created from an entry without a person id: found by entry id when
  // the entry later gains a person id.
  const byEntryNoPerson = new Map<number, ExistingRunner>();
  for (const r of input.existing) {
    if ((r.eventorPersonId == null || r.eventorPersonId <= 0) && r.eventorEntryId != null && r.eventorEntryId > 0) {
      byEntryNoPerson.set(r.eventorEntryId, r);
    }
  }
  const firstImport = input.firstImport === true;
  const resultsByPerson = new Map<number, ResultInput>();
  for (const r of input.results) {
    if (r.personId > 0 && !resultsByPerson.has(r.personId)) resultsByPerson.set(r.personId, r);
  }
  const plan: RunnerPlan = {
    creates: [],
    updates: [],
    cancels: [],
    heldBack: [],
    counts: {
      added: 0,
      updated: 0,
      keptLocal: 0,
      wouldCancel: 0,
      heldBack: 0,
      reinstated: 0,
      classChangeBlocked: 0,
      cardConflicts: 0,
      duplicateEntries: 0,
      skippedNoId: 0,
      skippedResultsOnly: 0,
    },
  };
  const c = plan.counts;
  const seen = new Set<string>();
  const knownClass = (id: number): number | undefined =>
    id > 0 && input.knownClassEventorIds.has(id) ? id : undefined;
  const clubName = (id: number, fallback: string) =>
    input.clubNameByEventorId.get(id) ?? fallback;

  // ── Entries ──
  for (const entry of input.entries) {
    const key = keyOf(entry.personId, entry.eventorEntryId);
    if (!key) {
      c.skippedNoId++;
      continue;
    }
    if (seen.has(key)) {
      c.duplicateEntries++;
      continue;
    }
    seen.add(key);
    const result = firstImport && entry.personId > 0 ? resultsByPerson.get(entry.personId) : undefined;
    let found = byKey.get(key);
    let backfillPerson = false;
    if (!found && entry.personId > 0 && entry.eventorEntryId > 0) {
      found = byEntryNoPerson.get(entry.eventorEntryId);
      if (found) {
        byEntryNoPerson.delete(entry.eventorEntryId);
        backfillPerson = true;
        seen.add(`e${entry.eventorEntryId}`);
      }
    }

    if (!found) {
      const ownerKey =
        entry.eventorEntryId > 0 ? `entry:${entry.eventorEntryId}` : `person:${entry.personId}`;
      plan.creates.push(
        buildCreate(claimCardNo, {
          personId: entry.personId,
          eventorEntryId: entry.eventorEntryId > 0 ? entry.eventorEntryId : null,
          name: entry.personName,
          classEventorId: knownClass(entry.classId) ?? null,
          eventorClubId: entry.organisationId > 0 ? entry.organisationId : null,
          clubName:
            entry.organisationId > 0
              ? clubName(entry.organisationId, entry.organisationName)
              : (entry.organisationName ?? ""),
          requestedCard: result?.cardNo || entry.cardNo,
          ownerKey,
          birthYear: entry.birthYear,
          sex: entry.sex,
          nationality: (result?.nationality || entry.nationality || "").substring(0, 7),
          entryDate: entry.entryDate,
          entryTime: entry.entryTime,
          startTime: result?.startTime ?? 0,
          finishTime: result?.finishTime ?? 0,
          status: result
            ? statusName(result.status)
            : entry.noTiming
              ? "no_timing"
              : "unknown",
          bib: (result?.bib ?? "").substring(0, 17),
          feeCents: clampInt32(entry.fee),
          paidCents: clampInt32(entry.paid),
          taxableCents: clampInt32(entry.taxable),
          rank: Math.round(entry.rankingScore),
          now,
        }),
      );
      c.added++;
      continue;
    }
    if (found.removed) continue; // deleted at the desk: never brought back

    const prev = found.snapshot ?? {};
    const data: RunnerData = {};
    const snap: RunnerSnapshot = { ...EMPTY_RUNNER_SNAPSHOT, ...prev };
    let kept = false;

    // name, birth year, sex, nationality: the plain rule.
    const plain = <T>(
      local: T,
      prevVal: T | undefined,
      next: T | undefined,
      key: "name" | "birthYear" | "sex" | "nationality",
      snapKey: "name" | "birth_year" | "sex" | "nationality",
    ) => {
      const m = mergeField(local, prevVal, next);
      if (m.write) (data as Record<string, unknown>)[key] = next;
      if (m.kept) kept = true;
      if (next !== undefined) (snap as Record<string, unknown>)[snapKey] = next;
    };
    plain(found.name, prev.name, entry.personName || undefined, "name", "name");
    plain(found.birthYear, prev.birth_year, entry.birthYear > 0 ? entry.birthYear : undefined, "birthYear", "birth_year");
    plain(found.sex, prev.sex, entry.sex || undefined, "sex", "sex");
    plain(
      found.nationality,
      prev.nationality,
      entry.nationality ? entry.nationality.substring(0, 7) : undefined,
      "nationality",
      "nationality",
    );

    // Club: the Eventor id and the name go together.
    {
      const next = entry.organisationId > 0 ? entry.organisationId : undefined;
      const m = mergeField<number | null>(found.eventorClubId, prev.club_eventor_id, next);
      const localOnlyClub =
        found.eventorClubId == null && found.clubName !== "" && found.clubName !== (prev.club_name ?? "");
      if (m.write && next !== undefined && localOnlyClub) {
        kept = true;
      } else if (m.write && next !== undefined) {
        const name = clubName(next, entry.organisationName);
        data.eventorClubId = next;
        data.clubName = name;
      }
      if (m.kept) kept = true;
      if (next !== undefined) {
        const name = clubName(next, entry.organisationName);
        // The club was renamed in Eventor under the same id: follow it while the
        // local name is still the one the last sync stored.
        if (
          !m.write &&
          found.eventorClubId === next &&
          prev.club_name !== undefined &&
          found.clubName === prev.club_name &&
          name !== found.clubName
        ) {
          data.clubName = name;
        }
        snap.club_eventor_id = next;
        snap.club_name = name;
      }
    }

    // Class: a runner who has started stays in the class she runs.
    {
      const next = knownClass(entry.classId);
      const m = mergeField<number | null>(found.classEventorId, prev.class_eventor_id, next);
      if (m.write && next !== undefined && found.classLocalOnly) {
        // Moved at the desk into a class Eventor does not know: not undone.
        kept = true;
      } else if (m.write && next !== undefined) {
        if (hasLocalActivity(found) || found.startTime !== 0) {
          c.classChangeBlocked++;
          kept = true;
        } else {
          data.classEventorId = next;
        }
      }
      if (m.kept) kept = true;
      if (next !== undefined) snap.class_eventor_id = next;
    }

    // Card.
    {
      const next = normalizeCardNo(entry.cardNo) ?? undefined;
      const m = mergeField<number | null>(found.cardNo, prev.card_no, next);
      if (next !== undefined) {
        if (m.write) {
          if (found.cardId != null) {
            kept = true;
            snap.card_no = next;
          } else if (claimCardNo(next, found.id, found.cardNo) === next) {
            data.cardNo = next;
            snap.card_no = next;
          } else {
            // Another runner holds Eventor's card: kept as is, but Eventor's card is
            // recorded so the runner shows as differing. Swaps are not resolved here.
            c.cardConflicts++;
            kept = true;
            snap.card_no = next;
          }
        } else {
          if (m.kept) kept = true;
          snap.card_no = next;
        }
      }
    }

    if (backfillPerson) data.eventorPersonId = entry.personId;

    // Fill-if-empty fields.
    if (found.entrySource === 0) data.entrySource = clampInt32(input.eventorEventId);
    if (found.entryDate === 0 && entry.entryDate) data.entryDate = entry.entryDate;
    if (found.entryTime === 0 && entry.entryTime) data.entryTime = entry.entryTime;
    if (found.feeCents === 0 && entry.fee > 0) data.feeCents = clampInt32(entry.fee);
    if (found.paidCents === 0 && entry.paid > 0) data.paidCents = clampInt32(entry.paid);
    if (found.taxableCents === 0 && entry.taxable > 0) data.taxableCents = clampInt32(entry.taxable);
    if (found.rank === 0 && entry.rankingScore > 0) data.rank = Math.round(entry.rankingScore);

    // Presence: only the sync's own cancel is undone.
    if (found.status === CANCEL && !result && prev.cancelled_by_sync === true) {
      data.status = entry.noTiming ? "no_timing" : "unknown";
      c.reinstated++;
    }
    if (found.status !== CANCEL || data.status !== undefined) delete snap.cancelled_by_sync;
    snap.present = true;

    if (kept) c.keptLocal++;
    pushUpdate(plan, found, data, snap, now);
  }

  // ── Results-only persons: seen (never cancelled), created when new ──
  for (const result of input.results) {
    if (result.personId <= 0) {
      c.skippedNoId++;
      continue;
    }
    const key = `p${result.personId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const found = byKey.get(key);
    if (found) {
      if (!found.removed && found.snapshot?.present === false) {
        pushUpdate(plan, found, {}, { ...found.snapshot, present: true }, now);
      }
      continue;
    }
    if (!firstImport) {
      // Only the first import takes results: no times or status from a re-sync.
      c.skippedResultsOnly++;
      continue;
    }
    plan.creates.push(
      buildCreate(claimCardNo, {
        personId: result.personId,
        eventorEntryId: null,
        name: result.personName,
        classEventorId: knownClass(result.classId) ?? null,
        eventorClubId: result.organisationId > 0 ? result.organisationId : null,
        clubName:
          result.organisationId > 0
            ? clubName(result.organisationId, result.organisationName)
            : (result.organisationName ?? ""),
        requestedCard: result.cardNo,
        ownerKey: `person:${result.personId}`,
        birthYear: result.birthYear,
        sex: result.sex,
        nationality: (result.nationality ?? "").substring(0, 7),
        entryDate: 0,
        entryTime: 0,
        startTime: result.startTime,
        finishTime: result.finishTime,
        status: statusName(result.status),
        bib: (result.bib ?? "").substring(0, 17),
        feeCents: 0,
        paidCents: 0,
        taxableCents: 0,
        rank: 0,
        now,
      }),
    );
    c.added++;
  }

  // ── Missing from Eventor ──
  for (const r of input.existing) {
    const k = keyOf(r.eventorPersonId, r.eventorEntryId);
    if (r.removed || (k && seen.has(k))) continue;
    if (r.status === CANCEL) continue; // already out; a manual cancel stays manual
    const snap: RunnerSnapshot = { ...(r.snapshot ?? {}), present: false, synced_at: now };
    if (hasLocalActivity(r)) {
      plan.heldBack.push({ id: r.id, name: r.name, snapshot: snap });
      c.heldBack++;
    } else {
      // Marked so that only a cancel made here is ever undone here.
      plan.cancels.push({ id: r.id, name: r.name, snapshot: { ...snap, cancelled_by_sync: true } });
      c.wouldCancel++;
    }
  }

  // A new runner whose card another runner holds keeps Eventor's card in the
  // snapshot (so the difference shows) and is counted; it is not resolved here.
  for (const cr of plan.creates) {
    if (cr.snapshot.card_no != null && cr.cardNo !== cr.snapshot.card_no) c.cardConflicts++;
  }

  return plan;
}

function pushUpdate(
  plan: RunnerPlan,
  found: ExistingRunner,
  data: RunnerData,
  snap: RunnerSnapshot,
  now: string,
): void {
  const changed = !sameSnapshot(found.snapshot, snap);
  const hasData = Object.keys(data).length > 0;
  if (!hasData && !changed) return;
  if (hasData) plan.counts.updated++;
  plan.updates.push({
    id: found.id,
    name: found.name,
    data,
    snapshot: changed ? { ...snap, synced_at: now } : null,
  });
}

function statusName(value: number): string {
  const names: Record<number, string> = {
    0: "unknown",
    1: "ok",
    2: "no_timing",
    3: "missing_punch",
    4: "dnf",
    5: "dq",
    6: "over_max_time",
    15: "out_of_competition",
    20: "dns",
    21: "cancel",
    99: "not_competing",
  };
  return names[value] ?? "unknown";
}

function buildCreate(claim: ReturnType<typeof makeCardNoClaimer>, a: {
  personId: number;
  eventorEntryId: number | null;
  name: string;
  classEventorId: number | null;
  eventorClubId: number | null;
  clubName: string;
  requestedCard: number;
  ownerKey: string;
  birthYear: number;
  sex: string;
  nationality: string;
  entryDate: number;
  entryTime: number;
  startTime: number;
  finishTime: number;
  status: string;
  bib: string;
  feeCents: number;
  paidCents: number;
  taxableCents: number;
  rank: number;
  now: string;
}): RunnerCreate {
  // claimed null = no card in Eventor, or another runner holds it. The snapshot
  // keeps Eventor's card either way, so a held card shows as a difference.
  const cardNo = claim(a.requestedCard, a.ownerKey);
  return {
    personId: a.personId,
    eventorEntryId: a.eventorEntryId,
    name: a.name,
    classEventorId: a.classEventorId,
    clubName: a.clubName,
    eventorClubId: a.eventorClubId,
    cardNo,
    birthYear: a.birthYear,
    sex: a.sex,
    nationality: a.nationality,
    entryDate: a.entryDate,
    entryTime: a.entryTime,
    startTime: a.startTime,
    finishTime: a.finishTime,
    status: a.status,
    bib: a.bib,
    feeCents: a.feeCents,
    paidCents: a.paidCents,
    taxableCents: a.taxableCents,
    rank: a.rank,
    snapshot: {
      name: a.name,
      card_no: normalizeCardNo(a.requestedCard),
      class_eventor_id: a.classEventorId,
      club_eventor_id: a.eventorClubId,
      club_name: a.clubName,
      birth_year: a.birthYear,
      sex: a.sex,
      nationality: a.nationality,
      present: true,
      synced_at: a.now,
    },
  };
}
