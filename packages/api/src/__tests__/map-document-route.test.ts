import { describe, it, expect } from "vitest";
import { authoriseDocumentAccess, negotiateEncoding, parseRangeHeader, type DocumentAccessQueries } from "../map-store/routes.js";
import { documentHeaderSummary } from "../map-store/documents.js";
import type { AuthUser } from "../auth.js";
import type { mapDocument } from "@oxygen/shared";

describe("parseRangeHeader", () => {
  it("parses closed, open-ended and suffix ranges against the size", () => {
    expect(parseRangeHeader(undefined, 100)).toEqual({ kind: "none" });
    expect(parseRangeHeader("bytes=0-9", 100)).toEqual({ kind: "range", start: 0, end: 9 });
    expect(parseRangeHeader("bytes=90-", 100)).toEqual({ kind: "range", start: 90, end: 99 });
    expect(parseRangeHeader("bytes=-10", 100)).toEqual({ kind: "range", start: 90, end: 99 });
    expect(parseRangeHeader("bytes=50-500", 100)).toEqual({ kind: "range", start: 50, end: 99 }); // clamped
    expect(parseRangeHeader("bytes=-500", 100)).toEqual({ kind: "range", start: 0, end: 99 });
  });
  it("is unsatisfiable past the end or inverted, and ignores multi-range / other units", () => {
    expect(parseRangeHeader("bytes=100-", 100)).toEqual({ kind: "unsatisfiable" });
    expect(parseRangeHeader("bytes=20-10", 100)).toEqual({ kind: "unsatisfiable" });
    expect(parseRangeHeader("bytes=-0", 100)).toEqual({ kind: "unsatisfiable" });
    expect(parseRangeHeader("bytes=0-0", 0)).toEqual({ kind: "unsatisfiable" });
    expect(parseRangeHeader("bytes=0-1,5-9", 100)).toEqual({ kind: "ignored" });
    expect(parseRangeHeader("items=0-1", 100)).toEqual({ kind: "ignored" });
    expect(parseRangeHeader("bytes=-", 100)).toEqual({ kind: "ignored" });
  });
});

describe("negotiateEncoding", () => {
  it("prefers brotli, then gzip, honouring q=0 and wildcards", () => {
    expect(negotiateEncoding(undefined)).toBeNull();
    expect(negotiateEncoding("gzip, deflate, br")).toBe("br");
    expect(negotiateEncoding("gzip, deflate")).toBe("gzip");
    expect(negotiateEncoding("br;q=0, gzip")).toBe("gzip");
    expect(negotiateEncoding("identity")).toBeNull();
    expect(negotiateEncoding("*")).toBe("br");
    expect(negotiateEncoding("gzip;q=0, *;q=0")).toBeNull();
  });
});

describe("authoriseDocumentAccess", () => {
  const hash = "a".repeat(64);
  const user: AuthUser = { id: "u1", email: "u@x", displayName: "U", isAdmin: false, active: true };
  const pin = { eventId: 7n, eventDate: new Date("2026-06-01"), kioskKey: "secret" };
  const queries = (over: Partial<DocumentAccessQueries> = {}): DocumentAccessQueries => ({
    eventPinsDocument: async (ev, h) => (ev === "itest" && h === hash ? pin : null),
    userHasCapability: async () => false,
    clubVersionHasDocument: async () => false,
    ...over,
  });
  const base = { hash, authEnabled: true, user: null, kioskKey: null, eventNameId: null };

  it("lets everything through when auth is off", async () => {
    expect(await authoriseDocumentAccess({ ...base, authEnabled: false }, queries())).toEqual({ ok: true });
  });
  it("accepts the event's kiosk key when the event pins the document", async () => {
    expect(await authoriseDocumentAccess({ ...base, eventNameId: "itest", kioskKey: "secret" }, queries())).toEqual({ ok: true });
    expect(await authoriseDocumentAccess({ ...base, eventNameId: "itest", kioskKey: "wrong" }, queries())).toEqual({ ok: false, status: 401 });
    expect(await authoriseDocumentAccess({ ...base, eventNameId: "other", kioskKey: "secret" }, queries())).toEqual({ ok: false, status: 401 });
  });
  it("accepts a user with courses.view on a pinning event, 403 otherwise", async () => {
    const caps = queries({ userHasCapability: async (id, _d, u, cap) => id === 7n && u.id === "u1" && cap === "courses.view" });
    expect(await authoriseDocumentAccess({ ...base, user, eventNameId: "itest" }, caps)).toEqual({ ok: true });
    expect(await authoriseDocumentAccess({ ...base, user, eventNameId: "itest" }, queries())).toEqual({ ok: false, status: 403 });
    expect(await authoriseDocumentAccess({ ...base, user }, caps)).toEqual({ ok: false, status: 403 });
  });
  it("accepts any signed-in user for a club-library version, never an anonymous one", async () => {
    const club = queries({ clubVersionHasDocument: async (h) => h === hash });
    expect(await authoriseDocumentAccess({ ...base, user }, club)).toEqual({ ok: true });
    expect(await authoriseDocumentAccess(base, club)).toEqual({ ok: false, status: 401 });
  });
});

describe("documentHeaderSummary", () => {
  it("drops the symbol and string tables and keeps counts", () => {
    const header = { format: { version: 1, importer: "ocad-2" }, mapScale: 10000, symbols: [{}, {}, {}], strings: ["a"], bounds: { minX: 0 } } as unknown as mapDocument.MapDocumentHeader;
    const s = documentHeaderSummary(header);
    expect(s).toEqual({ format: { version: 1, importer: "ocad-2" }, mapScale: 10000, bounds: { minX: 0 }, symbolCount: 3, stringCount: 1 });
    expect(s).not.toHaveProperty("symbols");
  });
});
