#!/usr/bin/env node
/**
 * Minimal Eventor API stub for the E2E stack.
 *
 * Three tests in `event.spec.ts` need a configured Eventor API key before
 * the Runner Database / Club Sync panels render. The only way to configure
 * one is `eventor.validateKey`, which persists the key *only* if Eventor
 * validates it — so those tests used to depend on eventor.orientering.se
 * being reachable, and on it accepting a key that is really just the
 * expanded i18n placeholder. Both assumptions fail: the service goes down,
 * and a made-up key gets a 403.
 *
 * This stub serves the handful of endpoints the suite touches. The API is
 * pointed at it via `EVENTOR_API_BASE_URL` (see `eventorBaseUrl` in
 * `packages/api/src/eventor.ts`), wired up in `playwright.config.ts`.
 *
 * Unhandled endpoints deliberately return 404 with the path in the body
 * rather than a plausible-looking empty document: a test that starts
 * calling new Eventor surface should fail loudly and tell you which
 * handler to add here, not silently assert against fabricated emptiness.
 *
 * Usage: EVENTOR_STUB_PORT=4300 node e2e/eventor-stub.mjs
 */
import { createServer } from "node:http";
import { inflateRawSync } from "node:zlib";

const PORT = Number(process.env.EVENTOR_STUB_PORT ?? 4300);

/** Organisation returned for any accepted key. Mirrors IOF/Eventor shape. */
const ORGANISATION_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Organisation>
  <OrganisationId>1234</OrganisationId>
  <Name>E2E Test Club</Name>
</Organisation>`;

/**
 * Events are dated today so they land inside whatever window the caller
 * asks for — the import panel defaults to a six-month range around now,
 * and a fixed date would silently age out of it.
 */
function eventListXml() {
  const today = new Date().toISOString().slice(0, 10);
  const events = [
    { id: 90001, name: "E2E Stub Sprint" },
    { id: 90002, name: "E2E Stub Middle" },
    { id: 90003, name: "E2E Stub Long" },
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<EventList>
${events
  .map(
    (e) => `  <Event>
    <EventId>${e.id}</EventId>
    <Name>${e.name}</Name>
    <StartDate><Date>${today}</Date></StartDate>
    <EventClassificationId>3</EventClassificationId>
    <Organiser>
      <OrganisationId>1234</OrganisationId>
      <Name>E2E Test Club</Name>
    </Organiser>
  </Event>`,
  )
  .join("\n")}
</EventList>`;
}

/**
 * One event (90001, "E2E Stub Sprint") also serves classes, entries and
 * results, in two scenarios the sync spec switches between with
 * `POST /__scenario/<n>` (no ApiKey needed; the stub keeps the number):
 *
 *   1  Andersson (card 500001) and Berg (no card), class H21 / H35
 *   2  Andersson's card is 500002, Berg has withdrawn, Carlsson entered
 *
 * Stub person ids 1001-1003, class ids 9001-9002. Every other event answers
 * these endpoints with 404 like any unhandled path.
 */
const SYNC_EVENT_ID = "90001";
let scenario = 1;

/**
 * Upload behaviour, switched with `POST /__upload/<ok|stall>`. "stall"
 * accepts a POST to /import/* and never answers it, so the API's upload
 * deadline (EVENTOR_UPLOAD_TIMEOUT_MS, 2 s on the E2E stack) is what ends it.
 */
let uploadMode = "ok";
/** The text of the last POST /import/*, for tests that check what was sent (`GET /__lastUpload`, no ApiKey). */
let lastUpload = "";

/** The uploads are one-entry zips: the entry's text, or the body as is when it is no zip. */
function uploadText(body) {
  if (body.length > 30 && body.readUInt32LE(0) === 0x04034b50) {
    const start = 30 + body.readUInt16LE(26) + body.readUInt16LE(28);
    try {
      return body.readUInt16LE(8) === 0 ? body.subarray(start).toString("utf8") : inflateRawSync(body.subarray(start)).toString("utf8");
    } catch {
      // Fall through to the raw text.
    }
  }
  return body.toString("utf8");
}

function syncEntries() {
  const entry = (id, personId, given, family, cardNo, classId) => `  <Entry>
    <EntryId>${id}</EntryId>
    <Competitor>
      <Person sex="M">
        <PersonId>${personId}</PersonId>
        <PersonName><Family>${family}</Family><Given>${given}</Given></PersonName>
        <BirthDate><Date>1990-01-01</Date></BirthDate>
      </Person>${cardNo ? `\n      <CCard><CCardId>${cardNo}</CCardId></CCard>` : ""}
    </Competitor>
    <EntryClass><EventClassId>${classId}</EventClassId></EntryClass>
  </Entry>`;
  const rows =
    scenario === 1
      ? [
          entry(1, 1001, "Anna", "Andersson", 500001, 9001),
          entry(2, 1002, "Bo", "Berg", 0, 9002),
        ]
      : [
          entry(1, 1001, "Anna", "Andersson", 500002, 9001),
          entry(3, 1003, "Cia", "Carlsson", 500003, 9001),
        ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<EntryList>\n${rows.join("\n")}\n</EntryList>`;
}

const SYNC_CLASSES = `<?xml version="1.0" encoding="UTF-8"?>
<EventClassList>
  <EventClass sex="M" lowAge="0" highAge="0" sequence="1">
    <EventClassId>9001</EventClassId><Name>H21</Name><ClassShortName>H21</ClassShortName>
    <ClassType><Name>Open</Name></ClassType>
  </EventClass>
  <EventClass sex="M" lowAge="35" highAge="0" sequence="2">
    <EventClassId>9002</EventClassId><Name>H35</Name><ClassShortName>H35</ClassShortName>
    <ClassType><Name>Open</Name></ClassType>
  </EventClass>
</EventClassList>`;

const SYNC_EXPORT_CLASSES = `<?xml version="1.0" encoding="UTF-8"?>
<ClassList>
  <Class resultListMode="Default"><Name>H21</Name></Class>
  <Class resultListMode="Default"><Name>H35</Name></Class>
</ClassList>`;

function send(res, status, body, contentType = "application/xml") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const apiKey = req.headers.apikey;

  // Test control: pick the sync scenario (no ApiKey, not an Eventor endpoint).
  const control = /^\/__scenario\/(\d+)$/.exec(pathname);
  if (req.method === "POST" && control) {
    scenario = Number(control[1]);
    send(res, 200, JSON.stringify({ scenario }), "application/json");
    return;
  }

  if (req.method === "GET" && pathname === "/__lastUpload") {
    send(res, 200, lastUpload, "text/plain");
    return;
  }

  const uploadControl = /^\/__upload\/(ok|stall)$/.exec(pathname);
  if (req.method === "POST" && uploadControl) {
    uploadMode = uploadControl[1];
    send(res, 200, JSON.stringify({ uploadMode }), "application/json");
    return;
  }

  // Every Eventor endpoint is key-authenticated, and the client maps 403
  // onto EventorAuthError. Keep that contract so the "bad key" UI path
  // stays reachable from tests.
  if (!apiKey) {
    send(res, 403, "<Error>Missing ApiKey header</Error>");
    return;
  }

  if (req.method === "GET" && pathname === "/organisation/apiKey") {
    send(res, 200, ORGANISATION_XML);
    return;
  }

  if (req.method === "GET" && pathname === "/events") {
    send(res, 200, eventListXml());
    return;
  }

  if (req.method === "POST" && pathname.startsWith("/import/")) {
    // Drain the body; in stall mode then say nothing at all.
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      lastUpload = uploadText(Buffer.concat(chunks));
      if (uploadMode === "stall") return;
      send(res, 200, "<ImportResult />");
    });
    return;
  }

  const eventParam = new URL(req.url, `http://127.0.0.1:${PORT}`).searchParams;
  const forSyncEvent =
    (eventParam.get("eventId") ?? eventParam.get("eventIds")) === SYNC_EVENT_ID;
  if (req.method === "GET" && forSyncEvent) {
    if (pathname === "/eventclasses") return send(res, 200, SYNC_CLASSES);
    if (pathname === "/entries") return send(res, 200, syncEntries());
    if (pathname === "/export/classes") return send(res, 200, SYNC_EXPORT_CLASSES);
    if (pathname === "/results/event") return send(res, 200, "<ResultList />");
    if (pathname === "/starts/event/iofxml") return send(res, 200, "<StartList />");
  }

  console.warn(`[eventor-stub] unhandled ${req.method} ${pathname}`);
  send(
    res,
    404,
    `<Error>eventor-stub has no handler for ${req.method} ${pathname}</Error>`,
  );
});

// No host argument: bind dual-stack so Playwright's readiness probe reaches
// the port whether it resolves to 127.0.0.1 or ::1.
server.listen(PORT, () => {
  console.log(`[eventor-stub] listening on :${PORT}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
