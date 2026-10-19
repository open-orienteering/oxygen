import { describe, it, expect } from "vitest";
import { authoriseSourceAccess, contentDisposition, sliceRanges, type SourceAccessQueries } from "../map-store/source-routes.js";
import type { AuthUser } from "../auth.js";

describe("sliceRanges", () => {
  it("covers the blob in fixed slices with a short last one", () => {
    expect(sliceRanges(0, 4)).toEqual([]);
    expect(sliceRanges(3, 4)).toEqual([{ start: 0, end: 2 }]);
    expect(sliceRanges(8, 4)).toEqual([{ start: 0, end: 3 }, { start: 4, end: 7 }]);
    expect(sliceRanges(9, 4)).toEqual([{ start: 0, end: 3 }, { start: 4, end: 7 }, { start: 8, end: 8 }]);
  });
  it("refuses a non-positive slice size", () => {
    expect(() => sliceRanges(10, 0)).toThrow();
  });
});

describe("contentDisposition", () => {
  it("is an attachment with an ASCII fallback and an RFC 5987 UTF-8 name", () => {
    expect(contentDisposition("map.ocd")).toBe(`attachment; filename="map.ocd"; filename*=UTF-8''map.ocd`);
    expect(contentDisposition('Skåne "nord".ocd')).toBe(`attachment; filename="Sk_ne _nord_.ocd"; filename*=UTF-8''Sk%C3%A5ne%20%22nord%22.ocd`);
    expect(contentDisposition("a'b(1)*.ocd")).toBe(`attachment; filename="a'b(1)*.ocd"; filename*=UTF-8''a%27b%281%29%2A.ocd`);
  });
});

describe("authoriseSourceAccess", () => {
  const hash = "b".repeat(64);
  const user: AuthUser = { id: "u1", email: "u@x", displayName: "U", isAdmin: false, active: true };
  const admin: AuthUser = { ...user, id: "a1", isAdmin: true };
  const pin = { eventId: 7n, eventDate: new Date("2026-06-01"), fileName: "event.ocd", fromClubLibrary: false };
  const queries = (over: Partial<SourceAccessQueries> = {}): SourceAccessQueries => ({
    eventPinsSource: async (ev, h) => (ev === "itest" && h === hash ? pin : null),
    userHasCapability: async () => false,
    clubVersionUploaders: async () => [],
    ...over,
  });
  const base = { hash, authEnabled: true, user: null, kioskKey: null, eventNameId: null };
  const manager = (over: Partial<SourceAccessQueries> = {}) =>
    queries({ userHasCapability: async (id, _d, u, cap) => id === 7n && cap === "event.manage" && (u.id === "u1" || u.isAdmin), ...over });

  it("lets everything through when auth is off", async () => {
    expect(await authoriseSourceAccess({ ...base, authEnabled: false }, queries())).toEqual({ ok: true, fileName: null });
  });
  it("lets an event manager take the event's own upload, under the event's file name", async () => {
    expect(await authoriseSourceAccess({ ...base, user, eventNameId: "itest" }, manager())).toEqual({ ok: true, fileName: "event.ocd" });
    expect(await authoriseSourceAccess({ ...base, user, eventNameId: "other" }, manager())).toEqual({ ok: false, status: 403 });
    // courses.view (or any capability short of event.manage) is not enough.
    expect(await authoriseSourceAccess({ ...base, user, eventNameId: "itest" }, queries({ userHasCapability: async (_i, _d, _u, cap) => cap === "courses.view" }))).toEqual({ ok: false, status: 403 });
  });
  it("keeps a map copied from the club library to instance admins", async () => {
    const fromClub = manager({ eventPinsSource: async () => ({ ...pin, fromClubLibrary: true }) });
    expect(await authoriseSourceAccess({ ...base, user, eventNameId: "itest" }, fromClub)).toEqual({ ok: false, status: 403 });
    expect(await authoriseSourceAccess({ ...base, user: admin, eventNameId: "itest" }, fromClub)).toEqual({ ok: true, fileName: "event.ocd" });
  });
  it("never accepts the kiosk key", async () => {
    expect(await authoriseSourceAccess({ ...base, eventNameId: "itest", kioskKey: "secret" }, queries())).toEqual({ ok: false, status: 401 });
  });
  it("lets the uploader of a club version or an admin take a club source, nobody else", async () => {
    const club = queries({ clubVersionUploaders: async (h) => (h === hash ? ["u1", null] : []) });
    expect(await authoriseSourceAccess({ ...base, user }, club)).toEqual({ ok: true, fileName: null });
    expect(await authoriseSourceAccess({ ...base, user: { ...user, id: "u2" } }, club)).toEqual({ ok: false, status: 403 });
    expect(await authoriseSourceAccess({ ...base, user: admin }, club)).toEqual({ ok: true, fileName: null });
    expect(await authoriseSourceAccess(base, club)).toEqual({ ok: false, status: 401 });
    // An admin gets no source that no club version references.
    expect(await authoriseSourceAccess({ ...base, user: admin }, queries())).toEqual({ ok: false, status: 403 });
  });
});
