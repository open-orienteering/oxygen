import { XMLParser, XMLBuilder } from "fast-xml-parser";
import AdmZip from "adm-zip";
import { type EventorEnvironment } from "@oxygen/shared";

const EVENTOR_URLS: Record<EventorEnvironment, string> = {
  prod: "https://eventor.orientering.se/api/",
  test: "https://eventor-sweden-test.orientering.se/api/",
};


const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Always parse as array for list elements
  isArray: (_name, jpath) => {
    const arrayPaths = [
      "EventList.Event",
      "EventClassList.EventClass",
      "EntryList.Entry",
      "EntryList.PersonEntry",
      "OrganisationList.Organisation",
      "ClassList.Class",
      "ResultList.ClassResult",
      "ResultList.ClassResult.PersonResult",
      "CompetitorList.Competitor",
      "Competitor.ControlCard",
    ];
    return arrayPaths.includes(jpath);
  },
});

// ─── Types ──────────────────────────────────────────────────

export interface EventorOrganisation {
  id: number;
  name: string;
}

export interface EventorEvent {
  eventId: number;
  name: string;
  date: string;
  classification: string;
  classificationId: number;
  organiserName: string;
  organiserId: number;
  /** URL to the event's external page (e.g. Livelox), if set on Eventor. */
  webUrl?: string;
}

export interface EventorEventClass {
  classId: number;
  name: string;
  shortName: string;
  sex: string;      // "M", "F", or "B" (both)
  lowAge: number;    // 0 = no lower age limit
  highAge: number;   // 0 = no upper age limit
  sequence: number;  // Eventor sort order
  classType: string; // e.g. "Åldersklasser", "Öppna klasser"
  noTiming: boolean; // resultListMode == "UnorderedNoTimes"
}

export interface EventorEntry {
  personName: string;        // "Family, Given"
  personId: number;
  birthYear: number;
  sex: string;               // "M" or "F"
  nationality: string;       // alpha3, e.g. "SWE"
  organisationId: number;
  organisationName: string;
  organisationShortName: string;
  organisationCountry: string; // alpha3, e.g. "SWE"
  classId: number;
  className: string;
  cardNo: number;
  eventorEntryId: number;
  entryDate: number;         // YYYYMMDD as int
  entryTime: number;         // deciseconds from midnight
  // Fee data from <AssignedFee> — stored as integer (minor currency units × 100)
  fee: number;
  paid: number;
  taxable: number;
  // Ranking score from <Score>
  rankingScore: number;      // 0 if not present
  // Whether this runner is in a non-timed class
  noTiming: boolean;         // true if <Extensions><TimePresentation>false
}

export interface EventorClub {
  id: number;
  name: string;
  shortName: string;
  countryCode: string;       // alpha3, e.g. "SWE"
  // Address fields (from bulk organisations endpoint)
  careOf: string;
  street: string;
  city: string;
  zip: string;
  email: string;
  phone: string;
  webUrl: string;
}

export interface EventorResult {
  personId: number;
  personName: string;
  birthYear: number;
  sex: string;
  nationality: string;
  organisationId: number;
  organisationName: string;
  organisationShortName: string;
  organisationCountry: string;
  classId: number;
  cardNo: number;
  startTime: number;    // deciseconds from midnight
  finishTime: number;   // deciseconds from midnight
  status: number;       // MeOS status code
  startNo: number;      // result position (used as startNo/bib equivalent)
  bib: string;          // BibNumber string from result, e.g. "123" or "H4"
}

export interface ResultForUpload {
  personExtId?: string;
  name: string;
  classExtId?: string;
  className: string;
  clubExtId?: string;
  clubName?: string;
  cardNo?: number;
  startTime?: number; // ds from midnight
  finishTime?: number; // ds from midnight
  status: number; // MeOS status
  place?: number; // 1-based, 0 or undefined = no placement
  noTiming?: boolean; // class has no timing/ranking
  // Fee data (integer currency units, e.g. 15000 = 150.00 SEK when factor=100)
  fee?: number;
  cardFee?: number;
  paid?: number;
  taxable?: number;
  isLateFee?: boolean; // derived from class fee comparison
  // Person/result fields
  birthYear?: number;
  nationality?: string;
  bib?: string;
  // Split times per control
  splitTimes?: {
    controlCode: number;
    time?: number; // seconds from start (undefined = no time available)
    status: "ok" | "missing" | "additional";
  }[];
}

/**
 * Map Eventor CompetitorStatus value to MeOS status code.
 */
const EVENTOR_STATUS_MAP: Record<string, number> = {
  OK: 1,
  MisPunch: 3,
  DidNotFinish: 4,
  Disqualified: 5,
  OverTime: 6,
  DidNotStart: 20,
  Cancelled: 21,
  NotCompeting: 99,
};

// ─── Helpers ────────────────────────────────────────────────

async function eventorFetch(
  endpoint: string,
  apiKey: string,
  env: EventorEnvironment = "prod",
  params?: Record<string, string>,
): Promise<string> {
  const url = new URL(endpoint, EVENTOR_URLS[env]);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  const resp = await fetch(url.toString(), {
    headers: { ApiKey: apiKey },
  });

  if (resp.status === 403) {
    throw new Error("Invalid API key or insufficient permissions");
  }
  if (!resp.ok) {
    throw new Error(`Eventor API error: ${resp.status} ${resp.statusText}`);
  }

  return resp.text();
}

function safeInt(val: unknown): number {
  if (val === undefined || val === null || val === "") return 0;
  // XML elements with attributes become objects like { "#text": 123, "@_attr": "x" }
  if (typeof val === "object" && val !== null) {
    const obj = val as Record<string, unknown>;
    if ("#text" in obj) return safeInt(obj["#text"]);
    return 0;
  }
  const n = parseInt(String(val), 10);
  return isNaN(n) ? 0 : n;
}

function safeStr(val: unknown): string {
  if (val === undefined || val === null) return "";
  // XML elements with attributes become objects like { "#text": "value", "@_attr": "x" }
  if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    if ("#text" in obj) return String(obj["#text"]);
    return "";
  }
  return String(val);
}

const CLASSIFICATION_NAMES: Record<number, string> = {
  1: "Championship",
  2: "National",
  3: "District",
  4: "Local",
  5: "Club",
  6: "International",
};

/**
 * ISO 3166-1 numeric → alpha-3 mapping.
 * Covers Nordic, European, and other countries commonly seen in orienteering.
 */
const COUNTRY_NUMERIC_TO_ALPHA3: Record<number, string> = {
  // Nordic
  752: "SWE", 578: "NOR", 246: "FIN", 208: "DNK", 352: "ISL",
  // Baltic
  233: "EST", 428: "LVA", 440: "LTU",
  // Central/Western Europe
  756: "CHE", 276: "DEU", 40: "AUT", 250: "FRA", 56: "BEL",
  528: "NLD", 442: "LUX", 826: "GBR", 372: "IRL",
  // Southern Europe
  380: "ITA", 724: "ESP", 620: "PRT",
  // Eastern Europe
  616: "POL", 203: "CZE", 703: "SVK", 348: "HUN", 642: "ROU",
  100: "BGR", 804: "UKR", 643: "RUS", 112: "BLR",
  // Balkan
  191: "HRV", 705: "SVN", 688: "SRB", 70: "BIH",
  807: "MKD", 499: "MNE", 8: "ALB",
  // Other
  840: "USA", 124: "CAN", 36: "AUS", 554: "NZL",
  392: "JPN", 156: "CHN", 410: "KOR",
};

/** Convert a numeric ISO 3166-1 country ID to alpha-3, or return "" if unknown. */
function countryIdToAlpha3(numericId: number): string {
  return COUNTRY_NUMERIC_TO_ALPHA3[numericId] ?? "";
}

/**
 * Extract alpha-3 country code from Eventor XML fragments.
 * Handles two formats:
 *   1. `<Country><Alpha3 value="SWE"/>...</Country>` (from single-org and entry orgs)
 *   2. `<CountryId value="752"/>` (from bulk orgs and inline entries)
 */
function extractCountryCode(obj: Record<string, unknown>): string {
  // Format 1: Country > Alpha3
  const country = obj.Country as Record<string, unknown> | undefined;
  if (country) {
    const alpha3 = country.Alpha3 as Record<string, unknown> | undefined;
    if (alpha3) {
      const val = safeStr(alpha3["@_value"] ?? "");
      if (val) return val;
    }
  }
  // Format 2: CountryId (numeric)
  const countryId = obj.CountryId as Record<string, unknown> | undefined;
  if (countryId) {
    const numericId = safeInt(countryId["@_value"] ?? 0);
    if (numericId > 0) return countryIdToAlpha3(numericId);
  }
  return "";
}

/**
 * Parse a "YYYY-MM-DD" date string into YYYYMMDD integer (MeOS format).
 */
function dateToMeosInt(dateStr: string): number {
  if (!dateStr || dateStr.length < 10) return 0;
  const n = parseInt(dateStr.replace(/-/g, ""), 10);
  return isNaN(n) ? 0 : n;
}

/**
 * Parse a "HH:MM:SS" time string into deciseconds from midnight (MeOS format).
 */
function timeToMeosDs(timeStr: string): number {
  if (!timeStr) return 0;
  const parts = timeStr.split(":");
  if (parts.length < 2) return 0;
  const h = parseInt(parts[0], 10) || 0;
  const m = parseInt(parts[1], 10) || 0;
  const s = parseInt(parts[2], 10) || 0;
  return (h * 3600 + m * 60 + s) * 10;
}

function formatIofTime(date: string, deciseconds: number): string {
  const seconds = Math.floor(deciseconds / 10);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  // MeOS times are local, IOF 3.0 prefers Z for simplicity unless timezone is specified
  return `${date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// MeOS RunnerStatus → IOF 3.0 ResultStatus string (for upload)
function meosStatusToIof(meosStatus: number, hasFinishTime: boolean): string {
  switch (meosStatus) {
    case 1: return "OK";
    case 2: return hasFinishTime ? "OK" : "NotCompeting"; // NoTiming
    case 3: return "MissingPunch";
    case 4: return "DidNotFinish";
    case 5: return "Disqualified";
    case 6: return "OverTime"; // StatusMAX
    case 15: return hasFinishTime ? "NotCompeting" : "NotCompeting"; // OutOfCompetition
    case 20: return "DidNotStart";
    case 21: return "Cancelled";
    case 99: return "DidNotEnter"; // StatusNotCompetiting
    default: return hasFinishTime ? "OK" : "DidNotStart";
  }
}

// ─── API Functions ──────────────────────────────────────────

/**
 * Validate an API key and return the organisation it belongs to.
 */
export async function validateApiKey(
  apiKey: string,
  env: EventorEnvironment = "prod",
): Promise<EventorOrganisation> {
  const xml = await eventorFetch("organisation/apiKey", apiKey, env);
  const parsed = parser.parse(xml);
  const org = parsed.Organisation;
  if (!org) throw new Error("Invalid API key — no organisation returned");

  return {
    id: safeInt(org.OrganisationId),
    name: safeStr(org.Name),
  };
}

/**
 * Fetch events for a given organisation within a date range.
 */
export async function fetchEvents(
  apiKey: string,
  orgId: number,
  fromDate: string,
  toDate: string,
  env: EventorEnvironment = "prod",
): Promise<EventorEvent[]> {
  const xml = await eventorFetch("events", apiKey, env, {
    fromDate,
    toDate,
    organisationIds: String(orgId),
    includeEntryBreaks: "true",
    includeAttributes: "true",
  });

  const parsed = parser.parse(xml);
  const eventList = parsed.EventList;
  if (!eventList || !eventList.Event) return [];

  const events: EventorEvent[] = [];
  for (const ev of eventList.Event) {
    const startDate = ev.StartDate;
    const date = startDate?.Date ?? "";

    // Classification can be nested or a simple id
    const classId = safeInt(
      ev.EventClassificationId ?? ev.EventClassification?.["@_id"],
    );

    // Organiser info — Eventor XML may nest as <Organiser> or <Organisation>
    // with child <OrganisationId> and <Name>, or as attributes.
    const organiser = ev.Organiser ?? ev.Organisation ?? {};
    const organiserId = safeInt(
      organiser.OrganisationId ?? organiser["@_id"] ?? 0,
    );
    // Name is the human-readable org name — never fall back to the numeric ID
    const organiserName = safeStr(organiser.Name ?? "");

    const webUrl = safeStr(ev.WebURL ?? "");
    events.push({
      eventId: safeInt(ev.EventId),
      name: safeStr(ev.Name),
      date: safeStr(date),
      classificationId: classId,
      classification: CLASSIFICATION_NAMES[classId] ?? `Type ${classId}`,
      organiserName,
      organiserId,
      ...(webUrl ? { webUrl } : {}),
    });
  }

  return events;
}

/**
 * Fetch the WebURL and date for a single event from Eventor.
 * Used to resolve a Livelox (or other external) link from an Eventor event ID.
 */
export async function fetchEventWebUrl(
  apiKey: string,
  eventId: number,
  env: EventorEnvironment = "prod",
): Promise<{ webUrl: string; date: string; name: string } | null> {
  try {
    const xml = await eventorFetch(`event/${eventId}`, apiKey, env);
    const parsed = parser.parse(xml);
    const ev = parsed.Event ?? parsed;
    const webUrl = safeStr(ev.WebURL ?? "");
    const date = safeStr(ev.StartDate?.Date ?? ev.StartDate ?? "");
    const name = safeStr(ev.Name ?? "");
    if (!webUrl) return null;
    return { webUrl, date, name };
  } catch {
    return null;
  }
}

/**
 * Fetch the organiser name and ID for a single event.
 * Lightweight — only parses the Organiser element from the event XML.
 */
export async function fetchEventOrganiser(
  apiKey: string,
  eventId: number,
  env: EventorEnvironment = "prod",
): Promise<{ name: string; id: number } | null> {
  try {
    const xml = await eventorFetch(`event/${eventId}`, apiKey, env);
    const parsed = parser.parse(xml);
    const ev = parsed.Event ?? parsed;
    const rawOrganiser = ev.Organiser ?? ev.Organisation ?? {};
    // Eventor XML nests as <Organiser><Organisation>...</Organisation></Organiser>
    const org = rawOrganiser.Organisation ?? rawOrganiser;
    const id = safeInt(org.OrganisationId ?? org["@_id"] ?? 0);
    const name = safeStr(org.Name ?? "");
    if (!name && !id) return null;
    return { name, id };
  } catch {
    return null;
  }
}

/**
 * Fetch classes for a given event.
 *
 * Uses the Eventor native endpoint for class IDs and metadata, then enriches
 * with the IOF 3.0 export endpoint (same as MeOS uses) which has resultListMode.
 */
export async function fetchEventClasses(
  apiKey: string,
  eventId: number,
  env: EventorEnvironment = "prod",
): Promise<EventorEventClass[]> {
  // Primary source: Eventor's native eventclasses (has EventClassId)
  const xml = await eventorFetch("eventclasses", apiKey, env, {
    eventId: String(eventId),
  });

  const parsed = parser.parse(xml);
  const classList = parsed.EventClassList;
  if (!classList || !classList.EventClass) return [];

  const ecArr = Array.isArray(classList.EventClass)
    ? classList.EventClass
    : [classList.EventClass];

  const classes = ecArr.map(
    (ec: Record<string, unknown>): EventorEventClass => {
      const classTypeObj = ec.ClassType as Record<string, unknown> | undefined;
      return {
        classId: safeInt(ec.EventClassId),
        name: safeStr(ec.Name ?? (ec.ClassShortName || "")),
        shortName: safeStr(ec.ClassShortName ?? ec.Name ?? ""),
        sex: safeStr(ec["@_sex"] ?? ""),
        lowAge: safeInt(ec["@_lowAge"] ?? 0),
        highAge: safeInt(ec["@_highAge"] ?? 0),
        sequence: safeInt(ec["@_sequence"] ?? 0),
        classType: safeStr(classTypeObj?.Name ?? ""),
        noTiming: false,
      };
    },
  );

  // Enrich with resultListMode from IOF 3.0 export endpoint
  try {
    const noTimingNames = await fetchNoTimingClassNames(apiKey, eventId, env);
    for (const cls of classes) {
      if (noTimingNames.has(cls.name)) {
        cls.noTiming = true;
      }
    }
  } catch {
    // IOF 3.0 endpoint not available — noTiming stays false
  }

  return classes;
}

/**
 * Fetch class names that have resultListMode="UnorderedNoTimes" from
 * the IOF 3.0 export/classes endpoint.
 */
async function fetchNoTimingClassNames(
  apiKey: string,
  eventId: number,
  env: EventorEnvironment,
): Promise<Set<string>> {
  const xml = await eventorFetch("export/classes", apiKey, env, {
    eventId: String(eventId),
    version: "3.0",
  });

  const parsed = parser.parse(xml);
  const classList = parsed.ClassList;
  if (!classList || !classList.Class) return new Set();

  const classes = Array.isArray(classList.Class)
    ? classList.Class
    : [classList.Class];

  const noTimingNames = new Set<string>();
  for (const cls of classes as Record<string, unknown>[]) {
    const mode = safeStr(cls["@_resultListMode"] ?? "");
    if (mode === "UnorderedNoTimes") {
      noTimingNames.add(safeStr(cls.Name ?? ""));
    }
  }
  return noTimingNames;
}

/**
 * Fetch entries (registered competitors) for an event.
 * Eventor uses `eventIds` (plural) and returns `Entry > Competitor > Person`.
 */
export async function fetchEntries(
  apiKey: string,
  eventId: number,
  env: EventorEnvironment = "prod",
): Promise<EventorEntry[]> {
  const xml = await eventorFetch("entries", apiKey, env, {
    eventIds: String(eventId),
    includePersonElement: "true",
    includeOrganisationElement: "true",
  });

  const parsed = parser.parse(xml);
  const entryList = parsed.EntryList;
  if (!entryList || !entryList.Entry) return [];

  // Ensure Entry is always an array
  const rawEntries = Array.isArray(entryList.Entry)
    ? entryList.Entry
    : [entryList.Entry];

  const entries: EventorEntry[] = [];
  for (const entry of rawEntries) {
    const competitor = entry.Competitor ?? {};
    const person = competitor.Person ?? {};
    const personName = person.PersonName ?? {};
    const given = safeStr(personName.Given ?? "");
    const family = safeStr(personName.Family ?? "");
    const fullName = family
      ? `${family}, ${given}`.trim()
      : given;

    // Organisation — can be nested inside Competitor
    const org = (competitor.Organisation ?? {}) as Record<string, unknown>;
    const orgId = safeInt(org.OrganisationId ?? 0);
    const orgName = safeStr(org.Name ?? "");
    const orgShortName = safeStr(org.ShortName ?? "");
    const orgCountryCode = extractCountryCode(org);

    // Person nationality
    const personNat = (person.Nationality ?? {}) as Record<string, unknown>;
    const personCountryCode = extractCountryCode(personNat);

    // Class info — Eventor uses EntryClass > EventClassId
    const entryClass = entry.EntryClass ?? {};
    const classId = safeInt(entryClass.EventClassId ?? 0);

    // Card number — Eventor uses CCard > CCardId
    const ccard = competitor.CCard ?? {};
    const cardNo = safeInt(ccard.CCardId ?? 0);

    // Person details
    const personId = safeInt(person.PersonId ?? competitor.PersonId ?? 0);
    const birthDate = safeStr(person.BirthDate?.Date ?? "");
    const birthYear = birthDate ? safeInt(birthDate.substring(0, 4)) : 0;
    const sex = safeStr(person["@_sex"] ?? "");

    const entryId = safeInt(entry.EntryId ?? 0);

    // Entry date/time
    const entryDateObj = entry.EntryDate ?? {};
    const entryDateStr = safeStr(entryDateObj.Date ?? "");
    const entryClockStr = safeStr(entryDateObj.Clock ?? "");

    // Fee data from <AssignedFee> — mirrors MeOS's getAssignedFee()
    // Eventor may have multiple AssignedFee elements (entry fee + card fee etc.)
    const assignedFees = entry.AssignedFee
      ? (Array.isArray(entry.AssignedFee) ? entry.AssignedFee : [entry.AssignedFee])
      : [];
    let rawFee = 0, rawPaid = 0, rawTaxable = 0;
    for (const af of assignedFees) {
      const feeAmt = af.Fee as Record<string, unknown> | undefined;
      const paidAmt = af.PaidFee as Record<string, unknown> | undefined;
      if (feeAmt) {
        // Amount may be an attribute @_amount or a text node
        const feeVal = parseFloat(String(feeAmt["@_amount"] ?? feeAmt["#text"] ?? 0));
        // percentage modifier (OLA/Eventor quirk)
        const pct = parseFloat(String((af.Percentage as Record<string, unknown>)?.["@_value"] ?? 0));
        rawFee += feeVal + feeVal * (pct / 100);
        rawTaxable += feeVal;
      }
      if (paidAmt) {
        const paidVal = parseFloat(String(paidAmt["@_amount"] ?? paidAmt["#text"] ?? 0));
        rawPaid += paidVal;
      }
    }
    // Store as integer (multiply by 100, round — matches MeOS's interpretCurrency for SEK)
    const fee = Math.round(rawFee * 100);
    const paid = Math.round(rawPaid * 100);
    const taxable = Math.round(rawTaxable * 100);

    // Ranking score from <Score>
    const scoreRaw = entry.Score ?? 0;
    const rankingScore = parseFloat(String(scoreRaw)) || 0;

    // NoTiming from <Extensions><TimePresentation>false
    let noTiming = false;
    const extensions = entry.Extensions ?? {};
    const timePresRaw = (extensions as Record<string, unknown>).TimePresentation;
    if (timePresRaw !== undefined) {
      const timePres = String(timePresRaw).toLowerCase();
      noTiming = timePres === "false" || timePres === "0";
    }

    entries.push({
      personName: fullName,
      personId,
      birthYear,
      sex: sex === "M" ? "M" : sex === "F" ? "F" : "",
      nationality: personCountryCode,
      organisationId: orgId,
      organisationName: orgName,
      organisationShortName: orgShortName,
      organisationCountry: orgCountryCode,
      classId,
      className: "", // Will be resolved from eventclasses
      cardNo,
      eventorEntryId: entryId,
      entryDate: dateToMeosInt(entryDateStr),
      entryTime: timeToMeosDs(entryClockStr),
      fee,
      paid,
      taxable,
      rankingScore,
      noTiming,
    });
  }

  return entries;
}

/**
 * Fetch all clubs from Eventor.
 */
export async function fetchClubs(
  apiKey: string,
  env: EventorEnvironment = "prod",
): Promise<EventorClub[]> {
  const xml = await eventorFetch("organisations", apiKey, env);
  const parsed = parser.parse(xml);
  const orgList = parsed.OrganisationList;
  if (!orgList || !orgList.Organisation) return [];

  return orgList.Organisation.map(
    (org: Record<string, unknown>): EventorClub => {
      // Extract country code (handles both Country>Alpha3 and CountryId formats)
      const countryCode = extractCountryCode(org);

      // Extract address — Eventor may have multiple Address elements, pick the first
      const addressRaw = org.Address;
      const address = (
        Array.isArray(addressRaw) ? addressRaw[0] : addressRaw ?? {}
      ) as Record<string, unknown>;

      // Extract contact info
      const teleRaw = org.Tele;
      const tele = (
        Array.isArray(teleRaw) ? teleRaw[0] : teleRaw ?? {}
      ) as Record<string, unknown>;

      return {
        id: safeInt(org.OrganisationId),
        name: safeStr(org.Name),
        shortName: safeStr(org.ShortName ?? ""),
        countryCode,
        careOf: safeStr(address["@_careOf"] ?? ""),
        street: safeStr(address["@_street"] ?? ""),
        city: safeStr(address["@_city"] ?? ""),
        zip: safeStr(address["@_zipCode"] ?? ""),
        email: safeStr(tele["@_mailAddress"] ?? ""),
        phone: safeStr(tele["@_phoneNumber"] || tele["@_mobilePhoneNumber"] || ""),
        webUrl: safeStr(tele["@_webURL"] ?? ""),
      };
    },
  );
}

/**
 * Fetch only clubs referenced in entries (more efficient than fetching all).
 */
export async function fetchReferencedClubs(
  apiKey: string,
  entries: EventorEntry[],
): Promise<Map<number, EventorClub>> {
  const orgIds = new Set(entries.map((e) => e.organisationId).filter((id) => id > 0));
  if (orgIds.size === 0) return new Map();

  // The entries endpoint already includes organisation details when includeOrganisationElement=true
  // So we can build our club map directly from entries
  const clubMap = new Map<number, EventorClub>();
  for (const entry of entries) {
    if (entry.organisationId > 0 && !clubMap.has(entry.organisationId)) {
      clubMap.set(entry.organisationId, {
        id: entry.organisationId,
        name: entry.organisationName,
        shortName: entry.organisationShortName,
        countryCode: entry.organisationCountry || "",
        careOf: "",
        street: "",
        city: "",
        zip: "",
        email: "",
        phone: "",
        webUrl: "",
      });
    }
  }

  return clubMap;
}

/**
 * Fetch results for a completed event.
 * Returns an empty array if no results are available.
 */
export async function fetchResults(
  apiKey: string,
  eventId: number,
  env: EventorEnvironment = "prod",
): Promise<EventorResult[]> {
  const xml = await eventorFetch("results/event", apiKey, env, {
    eventId: String(eventId),
  });

  const parsed = parser.parse(xml);
  const resultList = parsed.ResultList;
  if (!resultList || !resultList.ClassResult) return [];

  const classResults = Array.isArray(resultList.ClassResult)
    ? resultList.ClassResult
    : [resultList.ClassResult];

  const results: EventorResult[] = [];

  for (const cr of classResults) {
    // Get the class ID from the EventClass element
    const eventClass = cr.EventClass ?? {};
    const classId = safeInt(eventClass.EventClassId ?? 0);

    const personResults = cr.PersonResult;
    if (!personResults) continue;

    const prList = Array.isArray(personResults) ? personResults : [personResults];

    for (const pr of prList) {
      const person = (pr.Person ?? {}) as Record<string, unknown>;
      const personName = (person.PersonName ?? {}) as Record<string, unknown>;
      const given = safeStr(personName.Given ?? "");
      const family = safeStr(personName.Family ?? "");
      const fullName = family ? `${family}, ${given}`.trim() : given;

      const personId = safeInt(person.PersonId ?? 0);
      const birthDate = safeStr(
        ((person.BirthDate ?? {}) as Record<string, unknown>).Date ?? "",
      );
      const birthYear = birthDate ? safeInt(birthDate.substring(0, 4)) : 0;
      const sex = safeStr(person["@_sex"] ?? "");

      // Person nationality
      const personNat = (person.Nationality ?? {}) as Record<string, unknown>;
      const personCountryCode = extractCountryCode(personNat);

      // Organisation
      const org = (pr.Organisation ?? {}) as Record<string, unknown>;
      const orgId = safeInt(org.OrganisationId ?? 0);
      const orgName = safeStr(org.Name ?? "");
      const orgShortName = safeStr(org.ShortName ?? "");
      const orgCountryCode = extractCountryCode(org);

      // Result block
      const result = (pr.Result ?? {}) as Record<string, unknown>;
      const cardNo = safeInt(result.CCardId ?? 0);

      // Start/finish times — parse Clock to deciseconds from midnight
      const startTimeObj = (result.StartTime ?? {}) as Record<string, unknown>;
      const finishTimeObj = (result.FinishTime ?? {}) as Record<string, unknown>;
      const startTime = timeToMeosDs(safeStr(startTimeObj.Clock ?? ""));
      const finishTime = timeToMeosDs(safeStr(finishTimeObj.Clock ?? ""));

      // Status
      const statusObj = (result.CompetitorStatus ?? {}) as Record<string, unknown>;
      const statusStr = safeStr(statusObj["@_value"] ?? "");
      const status = EVENTOR_STATUS_MAP[statusStr] ?? 0;

      // Position and bib
      const resultPosition = safeInt(result.ResultPosition ?? 0);
      const bib = safeStr(result.BibNumber ?? "");

      results.push({
        personId,
        personName: fullName,
        birthYear,
        sex: sex === "M" ? "M" : sex === "F" ? "F" : "",
        nationality: personCountryCode,
        organisationId: orgId,
        organisationName: orgName,
        organisationShortName: orgShortName,
        organisationCountry: orgCountryCode,
        classId,
        cardNo,
        startTime,
        finishTime,
        status,
        startNo: resultPosition,
        bib,
      });
    }
  }

  return results;
}

// ─── Competitors (club member lookup) ────────────────────────

export interface EventorCompetitor {
  personId: number;
  name: string;           // "Family, Given"
  birthYear: number;
  sex: string;            // "M" or "F"
  nationality: string;    // alpha3, e.g. "SWE"
  cardNo: number;         // SI card number (0 if none)
  organisationId: number;
}

/**
 * Fetch all competitors (members) for a given club/organisation.
 * Endpoint: GET /api/competitors?organisationId={id}
 */
export async function fetchCompetitors(
  apiKey: string,
  organisationId: number,
  env: EventorEnvironment = "prod",
): Promise<EventorCompetitor[]> {
  const xml = await eventorFetch("competitors", apiKey, env, {
    organisationId: String(organisationId),
  });

  const parsed = parser.parse(xml);
  const competitorList = parsed.CompetitorList;
  if (!competitorList || !competitorList.Competitor) return [];

  const rawItems = Array.isArray(competitorList.Competitor)
    ? competitorList.Competitor
    : [competitorList.Competitor];

  const competitors: EventorCompetitor[] = [];
  for (const comp of rawItems) {
    const person = comp.Person ?? {};
    const personName = person.PersonName ?? {};
    const given = safeStr(personName.Given ?? "");
    const family = safeStr(personName.Family ?? "");
    const fullName = family ? `${family}, ${given}`.trim() : given;

    const personId = safeInt(person.PersonId ?? comp.PersonId ?? 0);
    const birthDate = safeStr(person.BirthDate?.Date ?? "");
    const birthYear = birthDate ? safeInt(birthDate.substring(0, 4)) : 0;
    const sex = safeStr(person["@_sex"] ?? "");

    // SI card
    const ccard = comp.CCard ?? person.CCard ?? {};
    const cardNo = safeInt(ccard.CCardId ?? 0);

    // Nationality
    const personNat = (person.Nationality ?? {}) as Record<string, unknown>;
    const personCountryCode = extractCountryCode(personNat);

    // Organisation
    const org = (comp.Organisation ?? {}) as Record<string, unknown>;
    const orgId = safeInt(org.OrganisationId ?? organisationId);

    competitors.push({
      personId,
      name: fullName,
      birthYear,
      sex: sex === "M" ? "M" : sex === "F" ? "F" : "",
      nationality: personCountryCode,
      cardNo,
      organisationId: orgId,
    });
  }

  return competitors;
}

// ─── Cached Competitors (Global Runner DB) ──────────────────

export interface CachedCompetitor {
  extId: number;         // Eventor Person ID
  name: string;          // "Family, Given"
  cardNo: number;        // SI card number (0 if none)
  clubEventorId: number; // Eventor organisation ID
  clubName: string;      // Organisation name (from embedded data)
  birthYear: number;
  sex: string;           // "M" or "F" or ""
  nationality: string;   // alpha3
}

/**
 * Download the full cached competitors database from Eventor.
 * Endpoint: GET /api/export/cachedcompetitors?includePreselectedClasses=false&zip=true&version=3.0
 * Returns a ZIP containing an IOF 3.0 CompetitorList XML.
 */
export async function fetchCachedCompetitors(
  apiKey: string,
  env: EventorEnvironment = "prod",
): Promise<CachedCompetitor[]> {
  const url = new URL("export/cachedcompetitors", EVENTOR_URLS[env]);
  url.searchParams.set("includePreselectedClasses", "false");
  url.searchParams.set("zip", "true");
  url.searchParams.set("version", "3.0");

  const res = await fetch(url.toString(), {
    headers: { ApiKey: apiKey },
  });

  if (!res.ok) {
    throw new Error(
      `Eventor cachedcompetitors failed: ${res.status} ${res.statusText}`,
    );
  }

  // Response is a ZIP file
  const zipBuffer = Buffer.from(await res.arrayBuffer());
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();
  if (entries.length === 0) {
    throw new Error("Eventor cachedcompetitors: ZIP is empty");
  }

  // Extract the first (only) XML file from the ZIP
  const xmlData = entries[0].getData().toString("utf-8");
  const parsed = parser.parse(xmlData);

  const competitorList = parsed.CompetitorList;
  if (!competitorList || !competitorList.Competitor) return [];

  const rawItems = Array.isArray(competitorList.Competitor)
    ? competitorList.Competitor
    : [competitorList.Competitor];

  const competitors: CachedCompetitor[] = [];
  for (const comp of rawItems) {
    const person = comp.Person ?? {};
    const pname = person.Name ?? {};
    const given = safeStr(pname.Given ?? "");
    const family = safeStr(pname.Family ?? "");
    const fullName = family ? `${family}, ${given}`.trim() : given;

    if (!fullName) continue;

    // Person ID (IOF 3.0 uses <Id> element)
    const extId = safeInt(person.Id ?? 0);

    // Birth date → year
    const birthDate = safeStr(person.BirthDate ?? "");
    const birthYear = birthDate ? safeInt(birthDate.substring(0, 4)) : 0;

    // Sex attribute
    const sex = safeStr(person["@_sex"] ?? "");

    // Nationality (truncate to 3 chars to fit CHAR(3))
    const nat = person.Nationality ?? {};
    const nationality = safeStr(
      typeof nat === "object" && nat !== null
        ? (nat as Record<string, unknown>)["@_code"] ?? ""
        : "",
    ).substring(0, 3);

    // SI card (IOF 3.0 uses <ControlCard>)
    let cardNo = 0;
    const cards = comp.ControlCard;
    if (Array.isArray(cards)) {
      for (const card of cards) {
        const pSystem = card?.["@_punchingSystem"];
        if (!pSystem || pSystem === "SI") {
          cardNo = safeInt(typeof card === "object" ? card["#text"] ?? card : card);
          if (cardNo > 0) break;
        }
      }
    } else if (cards) {
      cardNo = safeInt(typeof cards === "object" ? (cards as Record<string, unknown>)["#text"] ?? cards : cards);
    }

    // Organisation
    const org = comp.Organisation ?? {};
    const clubEventorId = safeInt(
      typeof org === "object" && org !== null
        ? (org as Record<string, unknown>).Id ?? 0
        : 0,
    );
    const clubName = safeStr(
      typeof org === "object" && org !== null
        ? (org as Record<string, unknown>).Name ?? ""
        : "",
    );

    competitors.push({
      extId,
      name: fullName,
      cardNo,
      clubEventorId,
      clubName,
      birthYear,
      sex: sex === "M" ? "M" : sex === "F" ? "F" : "",
      nationality,
    });
  }

  return competitors;
}

// ─── Club Logos ──────────────────────────────────────────────

/**
 * Fetch a club logo as a PNG buffer via the authenticated Eventor API.
 * Always fetches from prod-Eventor since test-Eventor shares the same org IDs
 * and prod is the authoritative source for logos.
 */
export async function fetchClubLogo(
  organisationId: number,
  apiKey: string,
  type: "SmallIcon" | "LargeIcon" = "SmallIcon",
): Promise<Uint8Array | null> {
  const url = new URL("organisation/logo", EVENTOR_URLS["prod"]);
  url.searchParams.set("organisationId", String(organisationId));
  url.searchParams.set("type", type);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url.toString(), {
        headers: { ApiKey: apiKey },
        signal: controller.signal,
      });
      if (!res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/**
 * Format a currency amount for IOF XML output.
 * MeOS stores amounts as integers (e.g. 15000 = 150.00 SEK when factor=100).
 */
function formatCurrencyAmount(amount: number, factor: number): string {
  if (factor <= 1) return String(amount);
  const whole = Math.floor(amount / factor);
  const frac = amount % factor;
  return `${whole}.${String(frac).padStart(2, "0")}`;
}

/**
 * Build an IOF Amount element with optional currency attribute.
 */
function iofAmount(tag: string, amount: number, factor: number, currencyCode: string): Record<string, unknown> | null {
  if (amount <= 0) return null;
  const value = formatCurrencyAmount(amount, factor);
  if (currencyCode) {
    return { [tag]: { "@_currency": currencyCode, "#text": value } };
  }
  return { [tag]: value };
}

/**
 * Build AssignedFee element(s) for a runner, matching MeOS writeAssignedFee.
 */
function buildAssignedFee(
  r: ResultForUpload,
  factor: number,
  currencyCode: string,
): Record<string, unknown>[] {
  const fee = r.fee ?? 0;
  const taxable = r.taxable ?? 0;
  const cardFee = r.cardFee ?? 0;
  let paid = r.paid ?? 0;

  if (fee === 0 && taxable === 0 && paid === 0) return [];

  // Deduct card rental from paid (card rental has its own ServiceRequest)
  if (paid >= cardFee && cardFee > 0) {
    paid -= cardFee;
  }

  const feeType = r.isLateFee ? "Late" : "Normal";
  const assignedFee: Record<string, unknown> = {
    Fee: {
      "@_type": feeType,
      Name: "Entry fee",
      ...iofAmount("Amount", fee, factor, currencyCode),
      ...iofAmount("TaxableAmount", taxable, factor, currencyCode),
    },
    ...iofAmount("PaidAmount", paid, factor, currencyCode),
  };

  return [{ AssignedFee: assignedFee }];
}

/**
 * Build ServiceRequest for card rental, matching MeOS writeRentalCardService.
 */
function buildCardRentalService(
  cardFee: number,
  paid: number,
  factor: number,
  currencyCode: string,
): Record<string, unknown> | null {
  if (cardFee <= 0) return null;
  const paidCard = paid >= cardFee;
  return {
    ServiceRequest: {
      Service: { "@_type": "RentalCard", Name: "Card Rental" },
      RequestedQuantity: 1,
      AssignedFee: {
        Fee: {
          Name: "Card Rental Fee",
          ...iofAmount("Amount", cardFee, factor, currencyCode),
        },
        ...(paidCard ? iofAmount("PaidAmount", cardFee, factor, currencyCode) : {}),
      },
    },
  };
}

/**
 * Upload results to Eventor.
 * Only enabled for Test-Eventor for safety.
 */
export async function uploadResults(
  apiKey: string,
  eventExtId: string,
  eventName: string,
  eventDate: string,
  results: ResultForUpload[],
  env: EventorEnvironment = "prod",
  currencyCode = "",
  currencyFactor = 100,
): Promise<void> {
  const factor = currencyFactor > 0 ? currencyFactor : 1;

  // Group by class
  const classMap = new Map<string, ResultForUpload[]>();
  for (const r of results) {
    const key = r.classExtId || r.className;
    if (!classMap.has(key)) classMap.set(key, []);
    classMap.get(key)!.push(r);
  }

  const builder = new XMLBuilder({
    ignoreAttributes: false,
    format: true,
  });

  const zeroTimeISO = formatIofTime(eventDate, 0);

  const obj = {
    ResultList: {
      "@_xmlns": "http://www.orienteering.org/datastandard/3.0",
      "@_xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
      "@_iofVersion": "3.0",
      "@_status": "Snapshot",
      "@_createTime": new Date().toISOString(),
      "@_creator": "Oxygen",
      Event: {
        Id: eventExtId,
        Name: eventName,
        StartTime: {
          Date: eventDate,
          Time: zeroTimeISO.split("T")[1],
        },
      },
      ClassResult: Array.from(classMap.entries()).map(([classKey, runners]) => ({
        Class: {
          Id: runners[0].classExtId,
          Name: runners[0].className,
        },
        PersonResult: runners.map((r) => {
          let family: string, given: string;
          if (r.name.includes(",")) {
            const parts = r.name.split(",");
            family = parts[0]?.trim() || "";
            given = parts[1]?.trim() || "";
          } else {
            const name = r.name.trim();
            const lastSpace = name.lastIndexOf(" ");
            if (lastSpace > 0) {
              given = name.substring(0, lastSpace);
              family = name.substring(lastSpace + 1);
            } else {
              family = name;
              given = name;
            }
          }

          const hasTiming = !r.noTiming;
          const statusStr = meosStatusToIof(r.status, (r.finishTime ?? 0) > 0);
          const runningTime = hasTiming && r.status === 1 && r.finishTime && r.startTime && r.finishTime > r.startTime
            ? Math.round((r.finishTime - r.startTime) / 10)
            : undefined;

          // Fee elements (matching MeOS writeAssignedFee + writeRentalCardService)
          const assignedFees = buildAssignedFee(r, factor, currencyCode);
          const cardRental = buildCardRentalService(r.cardFee ?? 0, r.paid ?? 0, factor, currencyCode);

          // Split times (matching MeOS iof30interface.cpp:3646-3706)
          const splitTimeElements = (r.splitTimes ?? []).map((s) => {
            if (s.status === "missing") {
              return { "@_status": "Missing", ControlCode: s.controlCode };
            }
            const el: Record<string, unknown> = {};
            if (s.status === "additional") el["@_status"] = "Additional";
            el.ControlCode = s.controlCode;
            if (s.time != null && s.time > 0 && hasTiming) el.Time = s.time;
            return el;
          });

          return {
            Person: {
              ...(r.personExtId ? { Id: r.personExtId } : {}),
              Name: {
                Family: family,
                Given: given,
              },
              ...(r.birthYear && r.birthYear > 1900 ? { BirthDate: `${r.birthYear}-01-01` } : {}),
              ...(r.nationality ? { Nationality: { "@_code": r.nationality } } : {}),
            },
            ...(r.clubName
              ? {
                  Organisation: {
                    ...(r.clubExtId ? { Id: r.clubExtId } : {}),
                    Name: r.clubName,
                  },
                }
              : {}),
            Result: {
              ...(r.bib ? { BibNumber: r.bib } : {}),
              ...(r.startTime && r.startTime > 0 ? { StartTime: formatIofTime(eventDate, r.startTime) } : {}),
              ...(hasTiming && r.finishTime && r.finishTime > 0 ? { FinishTime: formatIofTime(eventDate, r.finishTime) } : {}),
              ...(runningTime !== undefined ? { Time: runningTime } : {}),
              ...(r.place && r.place > 0 ? { Position: r.place } : {}),
              Status: statusStr,
              ...(splitTimeElements.length > 0 ? { SplitTime: splitTimeElements } : {}),
              ...(r.cardNo && r.cardNo > 0
                ? { ControlCard: r.cardNo }
                : {}),
              ...Object.assign({}, ...assignedFees),
              ...(cardRental ?? {}),
            },
          };
        }),
      })),
    },
  };

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build(obj)}`;

  // Debug: write XML to /tmp for inspection
  const fs = await import("fs/promises");
  await fs.writeFile("/tmp/eventor-resultlist.xml", xml, "utf-8");
  console.log(`[Eventor] Result XML written to /tmp/eventor-resultlist.xml (${xml.length} bytes, ${results.length} runners)`);

  const zip = new AdmZip();
  zip.addFile("resultlist.xml", Buffer.from(xml, "utf-8"));
  const zipBuffer = new Uint8Array(zip.toBuffer());

  const url = new URL("import/resultlist", EVENTOR_URLS[env]);
  console.log(`[Eventor] Uploading to ${url.toString()} (env=${env})`);
  const resp = await fetch(url.toString(), {
    method: "POST",
    headers: {
      ApiKey: apiKey,
    },
    body: zipBuffer,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Eventor upload failed: ${resp.status} ${text}`);
  }
}

/**
 * Upload start list to Eventor.
 * Only enabled for Test-Eventor for safety.
 */
export async function uploadStartList(
  apiKey: string,
  eventExtId: string,
  eventName: string,
  eventDate: string,
  runners: ResultForUpload[],
  env: EventorEnvironment = "prod",
): Promise<void> {
  // Group by class
  const classMap = new Map<string, ResultForUpload[]>();
  for (const r of runners) {
    const key = r.classExtId || r.className;
    if (!classMap.has(key)) classMap.set(key, []);
    classMap.get(key)!.push(r);
  }

  const builder = new XMLBuilder({
    ignoreAttributes: false,
    format: true,
  });

  const zeroTimeISO = formatIofTime(eventDate, 0);

  const obj = {
    StartList: {
      "@_xmlns": "http://www.orienteering.org/datastandard/3.0",
      "@_xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
      "@_iofVersion": "3.0",
      "@_createTime": new Date().toISOString(),
      "@_creator": "Oxygen",
      Event: {
        Id: eventExtId,
        Name: eventName,
        StartTime: {
          Date: eventDate,
          Time: zeroTimeISO.split("T")[1],
        },
      },
      ClassStart: Array.from(classMap.entries()).map(([classKey, runners]) => ({
        Class: {
          Id: runners[0].classExtId,
          Name: runners[0].className,
        },
        PersonStart: runners.map((r) => {
          let family: string, given: string;
          if (r.name.includes(",")) {
            const parts = r.name.split(",");
            family = parts[0]?.trim() || "";
            given = parts[1]?.trim() || "";
          } else {
            const name = r.name.trim();
            const lastSpace = name.lastIndexOf(" ");
            if (lastSpace > 0) {
              given = name.substring(0, lastSpace);
              family = name.substring(lastSpace + 1);
            } else {
              family = name;
              given = name;
            }
          }

          return {
            Person: {
              ...(r.personExtId ? { Id: r.personExtId } : {}),
              Name: {
                Family: family,
                Given: given,
              },
            },
            ...(r.clubName
              ? {
                  Organisation: {
                    ...(r.clubExtId ? { Id: r.clubExtId } : {}),
                    Name: r.clubName,
                  },
                }
              : {}),
            Start: {
              ...(r.startTime && r.startTime > 0
                ? { StartTime: formatIofTime(eventDate, r.startTime) }
                : {}),
              ...(r.cardNo && r.cardNo > 0
                ? { ControlCard: r.cardNo }
                : {}),
            },
          };
        }),
      })),
    },
  };

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build(obj)}`;

  const zip = new AdmZip();
  zip.addFile("startlist.xml", Buffer.from(xml, "utf-8"));
  const zipBuffer = new Uint8Array(zip.toBuffer());

  const url = new URL("import/startlist", EVENTOR_URLS[env]);
  const resp = await fetch(url.toString(), {
    method: "POST",
    headers: {
      ApiKey: apiKey,
    },
    body: zipBuffer,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Eventor upload failed: ${resp.status} ${text}`);
  }
}
