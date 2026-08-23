import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateApiKey } from "../eventor.js";

const ORGANISATION_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Organisation>
  <OrganisationId>1234</OrganisationId>
  <Name>Stub OK</Name>
</Organisation>`;

/**
 * Capture the URLs the Eventor client actually requests. The client calls
 * bare `fetch`, so stubbing the global is enough to observe it without any
 * network access.
 */
function captureRequestedUrls(): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      urls.push(String(url));
      return new Response(ORGANISATION_XML, { status: 200 });
    }),
  );
  return urls;
}

describe("Eventor base URL resolution", () => {
  beforeEach(() => {
    delete process.env.EVENTOR_API_BASE_URL;
  });

  afterEach(() => {
    delete process.env.EVENTOR_API_BASE_URL;
    vi.unstubAllGlobals();
  });

  it("targets the live prod host when no override is set", async () => {
    const urls = captureRequestedUrls();

    await validateApiKey("key", "prod");

    expect(urls).toEqual([
      "https://eventor.orientering.se/api/organisation/apiKey",
    ]);
  });

  it("targets the live test host when no override is set", async () => {
    const urls = captureRequestedUrls();

    await validateApiKey("key", "test");

    expect(urls).toEqual([
      "https://eventor-sweden-test.orientering.se/api/organisation/apiKey",
    ]);
  });

  it("redirects to the override host when EVENTOR_API_BASE_URL is set", async () => {
    process.env.EVENTOR_API_BASE_URL = "http://127.0.0.1:4300/";
    const urls = captureRequestedUrls();

    await validateApiKey("key", "prod");

    expect(urls).toEqual(["http://127.0.0.1:4300/organisation/apiKey"]);
  });

  it("applies the override to both environments", async () => {
    process.env.EVENTOR_API_BASE_URL = "http://127.0.0.1:4300/";
    const urls = captureRequestedUrls();

    await validateApiKey("key", "test");

    expect(urls).toEqual(["http://127.0.0.1:4300/organisation/apiKey"]);
  });

  it("keeps the override's path prefix when the trailing slash is missing", async () => {
    // `new URL(relative, base)` resolves against the base's *directory*, so
    // an override of ".../api" without the trailing slash would otherwise
    // silently drop the "/api" segment.
    process.env.EVENTOR_API_BASE_URL = "http://127.0.0.1:4300/api";
    const urls = captureRequestedUrls();

    await validateApiKey("key", "prod");

    expect(urls).toEqual(["http://127.0.0.1:4300/api/organisation/apiKey"]);
  });

  it("is read at call time so the stub can be pointed at mid-process", async () => {
    const urls = captureRequestedUrls();

    await validateApiKey("key", "prod");
    process.env.EVENTOR_API_BASE_URL = "http://127.0.0.1:4300/";
    await validateApiKey("key", "prod");

    expect(urls).toEqual([
      "https://eventor.orientering.se/api/organisation/apiKey",
      "http://127.0.0.1:4300/organisation/apiKey",
    ]);
  });
});
