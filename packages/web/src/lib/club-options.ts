/**
 * Club choices for the registration dialog and the bulk "Set club" action
 * (WEB-06, WEB-10, WEB-11).
 *
 * A club is a name plus an optional Eventor id. The roster (`club.list`)
 * gives free-text clubs `id: 0`, the same value the pickers used for
 * "No club", so a key built from the id alone could not tell them apart.
 * Every choice is therefore keyed by a string:
 *
 *   ""              No club
 *   "e:<eventorId>" an Eventor club
 *   "n:<lowercase>" a free-text club (no Eventor id)
 */

export type ClubKey = string;

export const NO_CLUB: ClubKey = "";

export type ClubOptionSource = "roster" | "adhoc" | "directory";

export interface ClubOption {
  key: ClubKey;
  name: string;
  /** Eventor organisation id; absent for a free-text club. */
  eventorId?: number;
  source: ClubOptionSource;
}

/** What a registration or bulk edit submits for a club key. */
export interface ResolvedClub {
  clubName: string;
  /** Null clears the Eventor link (a free-text club or No club). */
  eventorClubId: number | null;
}

export function clubKey(club: { eventorId?: number | null; name?: string | null }): ClubKey {
  if (club.eventorId && club.eventorId > 0) return `e:${club.eventorId}`;
  const name = club.name?.trim() ?? "";
  return name ? `n:${name.toLowerCase()}` : NO_CLUB;
}

/** The roster as options: Eventor clubs by id, free-text clubs by name. */
export function rosterClubOptions(
  clubs: ReadonlyArray<{ id: number; name: string; extId?: number }> | undefined,
): ClubOption[] {
  const out: ClubOption[] = [];
  for (const c of clubs ?? []) {
    const eventorId = c.extId && c.extId > 0 ? c.extId : c.id > 0 ? c.id : undefined;
    const key = clubKey({ eventorId, name: c.name });
    if (key === NO_CLUB) continue;
    out.push({ key, name: c.name, eventorId, source: "roster" });
  }
  return out;
}

/**
 * Roster first (in its order), then clubs picked from outside it (a name
 * suggestion, a card lookup, a directory search) and then directory results.
 * The first occurrence of a key wins.
 */
export function mergeClubOptions(...lists: ReadonlyArray<ReadonlyArray<ClubOption>>): ClubOption[] {
  const seen = new Set<ClubKey>();
  const out: ClubOption[] = [];
  for (const list of lists) {
    for (const o of list) {
      if (o.key === NO_CLUB || seen.has(o.key)) continue;
      seen.add(o.key);
      out.push(o);
    }
  }
  return out;
}

export function findClubOption(options: ReadonlyArray<ClubOption>, key: ClubKey): ClubOption | undefined {
  return key === NO_CLUB ? undefined : options.find((o) => o.key === key);
}

/**
 * The name and Eventor id to store for a key. An unknown key resolves to
 * No club only for `""`; any other unknown key keeps the name it encodes
 * (an `n:` key) or the bare id (an `e:` key, whose name the server fills
 * from the club directory).
 */
export function resolveClubKey(options: ReadonlyArray<ClubOption>, key: ClubKey): ResolvedClub {
  if (key === NO_CLUB) return { clubName: "", eventorClubId: null };
  const o = findClubOption(options, key);
  if (o) return { clubName: o.name, eventorClubId: o.eventorId ?? null };
  if (key.startsWith("e:")) {
    const id = Number(key.slice(2));
    return { clubName: "", eventorClubId: Number.isInteger(id) && id > 0 ? id : null };
  }
  return { clubName: key.startsWith("n:") ? key.slice(2) : "", eventorClubId: null };
}

/**
 * The option for a club that came with a suggestion or a lookup: the roster
 * entry when the club is already in the event, else an ad-hoc option to keep
 * beside the roster so the pick is shown and submitted as given (WEB-11).
 */
export function optionForClub(
  roster: ReadonlyArray<ClubOption>,
  club: { eventorId?: number | null; name?: string | null },
): ClubOption | null {
  const key = clubKey(club);
  if (key === NO_CLUB) return null;
  const inRoster = roster.find((o) => o.key === key);
  if (inRoster) return inRoster;
  const name = club.name?.trim() ?? "";
  if (!name && key.startsWith("e:")) return null; // an id with no name to show
  return {
    key,
    name,
    eventorId: club.eventorId && club.eventorId > 0 ? club.eventorId : undefined,
    source: "adhoc",
  };
}

/** Directory clubs from the cached runner DB (`eventorId → name`) whose name contains `query`; the offline stand-in for `club.searchDirectory`. */
export function searchCachedClubs(
  clubs: Readonly<Record<number | string, string>> | undefined,
  query: string,
  limit = 30,
): ClubOption[] {
  const q = query.trim().toLowerCase();
  if (!clubs || q.length < 2) return [];
  const out: ClubOption[] = [];
  for (const [id, name] of Object.entries(clubs)) {
    if (out.length >= limit) break;
    const eventorId = Number(id);
    if (!name || !(eventorId > 0) || !name.toLowerCase().includes(q)) continue;
    out.push({ key: clubKey({ eventorId, name }), name, eventorId, source: "directory" });
  }
  return out;
}

/** True when `query` matches no option label: the picker then also searches the club directory. */
export function noRosterMatch(options: ReadonlyArray<ClubOption>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return false;
  return !options.some((o) => o.name.toLowerCase().includes(q));
}
