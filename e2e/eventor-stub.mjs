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
