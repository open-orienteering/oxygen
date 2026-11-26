import { describe, expect, it } from "vitest";
import { classifyProbe, probeSession } from "../session-probe";

const r = (type: string, status: number, contentType = "") => ({ type, status, contentType });

describe("classifyProbe (WEB-04)", () => {
  it("no answer is unreachable", () => expect(classifyProbe(null)).toBe("unreachable"));
  it("a redirect (IAP sign-in) is expired", () => {
    expect(classifyProbe(r("opaqueredirect", 0))).toBe("expired");
    expect(classifyProbe(r("basic", 302, "text/html"))).toBe("expired");
  });
  it("an HTML login page or a proxy 401/403 is expired", () => {
    expect(classifyProbe(r("basic", 200, "text/html; charset=utf-8"))).toBe("expired");
    expect(classifyProbe(r("basic", 401, "text/plain"))).toBe("expired");
    expect(classifyProbe(r("basic", 403, ""))).toBe("expired");
  });
  it("a JSON answer from our server is ok, also a tRPC 401; a JSON 5xx is unreachable", () => {
    expect(classifyProbe(r("basic", 200, "application/json"))).toBe("ok");
    expect(classifyProbe(r("basic", 401, "application/json"))).toBe("ok");
    expect(classifyProbe(r("basic", 500, "application/json"))).toBe("unreachable");
  });
  it("a proxy's 502/503/504 is unreachable", () => {
    for (const s of [502, 503, 504]) expect(classifyProbe(r("basic", s, "text/html"))).toBe("unreachable");
  });
});

describe("probeSession", () => {
  it("never asks a venue node (no IAP there)", async () => {
    let called = false;
    const f = (async () => { called = true; return new Response("{}"); }) as typeof fetch;
    expect(await probeSession(f, "http://box.local:3002")).toBe("unreachable");
    expect(called).toBe(false);
  });
  it("asks without following redirects or caching, and classifies", async () => {
    let init: RequestInit | undefined;
    let url = "";
    const f = (async (u: string, i?: RequestInit) => {
      url = u;
      init = i;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    expect(await probeSession(f)).toBe("ok");
    expect(url).toBe("/trpc/users.me");
    expect(init?.redirect).toBe("manual");
    expect(init?.cache).toBe("no-store");
  });
  it("a throwing fetch is unreachable", async () => {
    const f = (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch;
    expect(await probeSession(f)).toBe("unreachable");
  });
});
