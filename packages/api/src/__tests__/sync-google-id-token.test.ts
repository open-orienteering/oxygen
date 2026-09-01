/**
 * Unit tests for the optional Google service-account ID-token auth on
 * venue → cloud sync calls (sync/googleIdToken.ts). When the cloud runs
 * behind IAP, SYNC_GOOGLE_AUDIENCE turns the static sync headers into an
 * async provider that attaches `Authorization: Bearer <ID token>`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  makeSyncHeaders,
  syncGoogleAudience,
  _setIdTokenFetcher,
} from "../sync/googleIdToken.js";

const BASE = { "x-event-id": "itest", "x-oxygen-sync-secret": "s3cret" };

afterEach(() => {
  delete process.env.SYNC_GOOGLE_AUDIENCE;
  _setIdTokenFetcher(null);
});

describe("syncGoogleAudience", () => {
  it("is null when the env var is unset or blank", () => {
    delete process.env.SYNC_GOOGLE_AUDIENCE;
    expect(syncGoogleAudience()).toBeNull();
    process.env.SYNC_GOOGLE_AUDIENCE = "   ";
    expect(syncGoogleAudience()).toBeNull();
  });

  it("returns the trimmed audience when set", () => {
    process.env.SYNC_GOOGLE_AUDIENCE = " client-id.apps.googleusercontent.com ";
    expect(syncGoogleAudience()).toBe("client-id.apps.googleusercontent.com");
  });
});

describe("makeSyncHeaders", () => {
  it("returns the static headers unchanged when no audience is configured", () => {
    delete process.env.SYNC_GOOGLE_AUDIENCE;
    expect(makeSyncHeaders(BASE)).toBe(BASE);
  });

  it("returns an async provider attaching a Bearer ID token when configured", async () => {
    process.env.SYNC_GOOGLE_AUDIENCE = "my-audience";
    const fetcher = vi.fn(async (audience: string) => `tok-for-${audience}`);
    _setIdTokenFetcher(fetcher);

    const headers = makeSyncHeaders(BASE);
    expect(typeof headers).toBe("function");
    const resolved = await (headers as () => Promise<Record<string, string>>)();
    expect(resolved).toEqual({
      ...BASE,
      authorization: "Bearer tok-for-my-audience",
    });
    expect(fetcher).toHaveBeenCalledWith("my-audience");
  });

  it("fetches a token on every call so refresh is delegated to the fetcher", async () => {
    process.env.SYNC_GOOGLE_AUDIENCE = "aud";
    let n = 0;
    _setIdTokenFetcher(async () => `tok-${++n}`);

    const provider = makeSyncHeaders(BASE) as () => Promise<
      Record<string, string>
    >;
    expect((await provider()).authorization).toBe("Bearer tok-1");
    expect((await provider()).authorization).toBe("Bearer tok-2");
  });

  it("propagates fetcher failures instead of sending an unauthenticated call", async () => {
    process.env.SYNC_GOOGLE_AUDIENCE = "aud";
    _setIdTokenFetcher(async () => {
      throw new Error("no key file");
    });
    const provider = makeSyncHeaders(BASE) as () => Promise<
      Record<string, string>
    >;
    await expect(provider()).rejects.toThrow("no key file");
  });
});
