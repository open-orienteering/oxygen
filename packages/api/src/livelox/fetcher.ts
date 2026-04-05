/**
 * HTTP client for the Livelox public API.
 *
 * The API is undocumented — endpoints were reverse-engineered from the
 * Livelox viewer JavaScript bundle.
 */

const LIVELOX_BASE = "https://www.livelox.com";

/** Headers required by the Livelox API (mimics an XHR from the viewer page). */
const HEADERS: HeadersInit = {
  "Content-Type": "application/json",
  "X-Requested-With": "XMLHttpRequest",
  Origin: "https://www.livelox.com",
};

// ─── Raw response types (Livelox-specific) ──────────────────

export interface LiveloxClassInfo {
  general: {
    event: {
      id: number;
      name: string;
      timeZone: string;
      timeInterval: { start: string; end: string };
    };
    class: {
      id: number;
      name: string;
      participantCount: number;
      boundingBox: {
        south: number;
        north: number;
        west: number;
        east: number;
      };
    };
  };
  personalized?: {
    routeAccessResult?: {
      classBlobUrl?: string;
    };
  };
}

export interface LiveloxClassBlob {
  map: {
    url: string;
    width: number;
    height: number;
    rotation: number;
    mapScale?: number;
    boundingBox: {
      south: number;
      north: number;
      west: number;
      east: number;
      center: { latitude: number; longitude: number };
    };
    defaultProjection: {
      matrix: number[][];
      origin: { latitude: number; longitude: number };
    };
    images: Array<{
      url: string;
      width: number;
      height: number;
      isThumbnail: boolean;
    }>;
  };
  tileData: {
    mapTileInfo: {
      mapTiles: Array<{
        x: number;
        y: number;
        width: number;
        height: number;
        url: string;
      }>;
      imageInfo: {
        width: number;
        height: number;
        defaultProjection: {
          matrix: number[][];
          origin: { latitude: number; longitude: number };
        };
        resolution: number;
      };
    };
    imageFormat: string;
  };
  courses: Array<{
    id: number;
    name: string;
    length?: number;
    controls: Array<{
      control: {
        numericCode: number;
        type: number; // 0=start, 1=control, 2=finish
        position: { latitude: number; longitude: number };
        code: string;
      };
    }>;
  }>;
  participants: Array<{
    id: number;
    classId: number;
    firstName: string;
    lastName: string;
    /** Present in some blob versions — contains Eventor person ID via system=0. */
    person?: {
      externalIdentifiers?: Array<{ system: number; id: string }>;
    };
    routeData?: string;
    timeInterval?: { start: string; end: string };
    routePositionTimeOffset?: number;
    result?: {
      status: number;
      rank?: number;
      time?: number; // milliseconds
      timeBehind?: number;
      organisationName?: string;
      /** Eventor org ID via system=0. */
      organisationExternalIdentifier?: { system: number; id: string };
      splitTimeData?: number[];
    };
    isDeleted?: boolean;
  }>;
  createdTime: string;
  /** EPSG code for projected route data (e.g. 3006 = SWEREF99 TM). Absent for lat/lng routes. */
  projectionEpsgCode?: number;
}

// ─── API functions ──────────────────────────────────────────

export interface LiveloxEventSummary {
  id: number;
  name: string;
  classes: Array<{ id: number; name: string; participantCount: number }>;
}

/**
 * Find a Livelox event by its numeric event ID by searching around a date.
 * The Livelox SearchEvents endpoint is used since there is no public
 * direct-lookup endpoint.
 */
export async function fetchLiveloxEventClasses(
  liveloxEventId: number,
  /** ISO date string (YYYY-MM-DD) used to narrow the search window. */
  eventDate?: string,
): Promise<LiveloxEventSummary> {
  // Build a ±2 day window around the event date, or fall back to "pastMonth".
  let body: Record<string, unknown>;
  if (eventDate) {
    const d = new Date(eventDate);
    const from = new Date(d);
    from.setDate(from.getDate() - 2);
    const to = new Date(d);
    to.setDate(to.getDate() + 2);
    body = {
      organisedByMyOrganisationsOnly: false,
      timePeriod: "custom",
      from: from.toISOString().split("T")[0],
      to: to.toISOString().split("T")[0],
      text: null,
      competitionsOnly: false,
      orderBy: "relevance",
      userLocation: null,
      properties: null,
      maxNumberOfResults: 500,
    };
  } else {
    body = {
      organisedByMyOrganisationsOnly: false,
      timePeriod: "pastMonth",
      from: null,
      to: null,
      text: null,
      competitionsOnly: false,
      orderBy: "relevance",
      userLocation: null,
      properties: null,
      maxNumberOfResults: 500,
    };
  }

  const resp = await fetch(`${LIVELOX_BASE}/Home/SearchEvents`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    throw new Error(`Livelox SearchEvents failed: ${resp.status}`);
  }

  const events = (await resp.json()) as LiveloxEventSummary[];
  const event = events.find((e) => e.id === liveloxEventId);
  if (!event) {
    throw new Error(
      `Livelox event ${liveloxEventId} not found in search results`,
    );
  }
  return event;
}

/**
 * Fetch class info and extract the classBlobUrl.
 */
export async function fetchClassInfo(classId: number): Promise<{
  classBlobUrl: string;
  eventName: string;
  className: string;
}> {
  const resp = await fetch(`${LIVELOX_BASE}/Data/ClassInfo`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ classIds: [classId] }),
  });

  if (!resp.ok) {
    throw new Error(`Livelox ClassInfo request failed: ${resp.status}`);
  }

  const data = (await resp.json()) as Record<string, unknown>;
  const general = data.general as Record<string, unknown> | undefined;

  // classBlobUrl lives at general.classBlobUrl (top-level, not nested)
  const classBlobUrl = (general?.classBlobUrl as string) ?? undefined;

  if (!classBlobUrl) {
    throw new Error(
      "No classBlobUrl found — the class may be hidden or require a subscription",
    );
  }

  const event = general?.event as { name?: string } | undefined;
  const cls = general?.class as { name?: string } | undefined;

  return {
    classBlobUrl,
    eventName: event?.name ?? "Unknown event",
    className: cls?.name ?? "Unknown class",
  };
}

/**
 * Fetch the full class blob from Azure storage.
 */
export async function fetchClassBlob(
  blobUrl: string,
): Promise<LiveloxClassBlob> {
  const resp = await fetch(blobUrl);
  if (!resp.ok) {
    throw new Error(`Livelox blob fetch failed: ${resp.status}`);
  }
  return resp.json() as Promise<LiveloxClassBlob>;
}
