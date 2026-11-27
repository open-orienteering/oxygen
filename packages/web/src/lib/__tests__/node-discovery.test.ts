/**
 * Unit tests for node discovery + LNA transport (pivot Step 5): local-network
 * URL classification, the LNA fetch annotation, candidate parsing, and the
 * probe/selection logic with an injected fetch.
 */

import { describe, it, expect } from "vitest";
import {
  isLocalNetworkUrl,
  lnaInit,
  probeCandidate,
  selectActiveNode,
  getVenueCandidates,
  setVenueCandidates,
} from "../node-discovery";

describe("isLocalNetworkUrl", () => {
  it("classifies private / loopback / mDNS targets as local", () => {
    expect(isLocalNetworkUrl("http://192.168.1.10:3001")).toBe(true);
    expect(isLocalNetworkUrl("http://10.0.0.5:3001")).toBe(true);
    expect(isLocalNetworkUrl("http://172.16.0.1")).toBe(true);
    expect(isLocalNetworkUrl("http://172.31.255.1")).toBe(true);
    expect(isLocalNetworkUrl("http://169.254.1.1")).toBe(true);
    expect(isLocalNetworkUrl("http://oxygen-box.local:3001")).toBe(true);
    expect(isLocalNetworkUrl("http://localhost:3001")).toBe(true);
  });

  it("classifies public targets as non-local", () => {
    expect(isLocalNetworkUrl("https://oxygen.example.com")).toBe(false);
    expect(isLocalNetworkUrl("http://172.32.0.1")).toBe(false); // outside 172.16/12
    expect(isLocalNetworkUrl("http://8.8.8.8")).toBe(false);
    expect(isLocalNetworkUrl("not a url")).toBe(false);
  });
});

describe("lnaInit", () => {
  it("annotates local targets with targetAddressSpace", () => {
    const init = lnaInit("http://192.168.1.10:3001", { method: "POST" });
    expect(
      (init as { targetAddressSpace?: string }).targetAddressSpace,
    ).toBe("local");
    expect(init.method).toBe("POST");
  });

  it("leaves public targets untouched", () => {
    const init = lnaInit("https://oxygen.example.com", { method: "POST" });
    expect("targetAddressSpace" in init).toBe(false);
  });
});

describe("venue candidates (localStorage)", () => {
  it("parses, trims and validates the pinned list", () => {
    // The lib test environment is node — provide a minimal localStorage.
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    try {
      setVenueCandidates(" http://192.168.1.10:3001/ , http://backup.local:3001 , nonsense ");
      expect(getVenueCandidates()).toEqual([
        "http://192.168.1.10:3001",
        "http://backup.local:3001",
      ]);
      setVenueCandidates("");
      expect(getVenueCandidates()).toEqual([]);
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});

describe("probeCandidate", () => {
  it("healthy when /ready answers 200 with status ok (and /health is not asked)", async () => {
    const urls: string[] = [];
    const fetchImpl = async (u: string) => {
      urls.push(u);
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    };
    expect(await probeCandidate("http://192.168.1.10:3001", fetchImpl)).toBe(true);
    expect(urls).toEqual(["http://192.168.1.10:3001/ready"]);
  });

  it("unhealthy when /ready answers 503, without falling back to /health", async () => {
    const urls: string[] = [];
    const fetchImpl = async (u: string) => {
      urls.push(u);
      return new Response(JSON.stringify({ status: "unavailable", reason: "database" }), { status: 503 });
    };
    expect(await probeCandidate("http://x", fetchImpl)).toBe(false);
    expect(urls).toEqual(["http://x/ready"]);
  });

  it("falls back to /health when /ready is 404 (an older box)", async () => {
    const fetchImpl = async (u: string) =>
      u.endsWith("/ready")
        ? new Response("Not Found", { status: 404 })
        : new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    expect(await probeCandidate("http://x", fetchImpl)).toBe(true);
  });

  it("falls back to /health when /ready answers HTML (SPA fallback)", async () => {
    const fetchImpl = async (u: string) =>
      u.endsWith("/ready")
        ? new Response("<!doctype html><title>oxygen</title>", { status: 200 })
        : new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    expect(await probeCandidate("http://x", fetchImpl)).toBe(true);
  });

  it("healthy when the box only knows /health and it answers 200 ok", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    expect(await probeCandidate("http://192.168.1.10:3001", fetchImpl)).toBe(true);
  });

  it("unhealthy on non-200, bad body, or network error", async () => {
    expect(
      await probeCandidate("http://x", async () => new Response("", { status: 503 })),
    ).toBe(false);
    expect(
      await probeCandidate(
        "http://x",
        async () => new Response("not json", { status: 200 }),
      ),
    ).toBe(false);
    expect(
      await probeCandidate("http://x", async () => {
        throw new TypeError("Failed to fetch");
      }),
    ).toBe(false);
  });
});

describe("selectActiveNode", () => {
  it("picks the first healthy candidate", async () => {
    const probe = async (url: string) => url.includes("backup");
    expect(
      await selectActiveNode(["http://primary:3001", "http://backup:3001"], probe),
    ).toBe("http://backup:3001");
  });

  it("falls back to cloud (empty string) when nothing is healthy", async () => {
    expect(await selectActiveNode(["http://a", "http://b"], async () => false)).toBe("");
  });

  it("cloud fallback with no candidates at all", async () => {
    expect(await selectActiveNode([], async () => true)).toBe("");
  });
});
