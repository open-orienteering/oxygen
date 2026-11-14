/** An in-memory Cache Storage for the offline tests (Node has no `caches`). */

import type { CacheLike, CacheStorageLike } from "../offline-store";

const ORIGIN = "http://oxygen.test";
const abs = (key: string): string => new URL(key, ORIGIN).href;

export class MemoryCache implements CacheLike {
  readonly entries = new Map<string, { body: ArrayBuffer; init: ResponseInit }>();
  async match(key: string): Promise<Response | undefined> {
    const e = this.entries.get(abs(key));
    return e ? new Response(e.body.slice(0), e.init) : undefined;
  }
  async put(key: string, res: Response): Promise<void> {
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    this.entries.set(abs(key), { body: await res.arrayBuffer(), init: { status: res.status, headers } });
  }
  async delete(key: string): Promise<boolean> {
    return this.entries.delete(abs(key));
  }
  async keys(): Promise<readonly { url: string }[]> {
    return [...this.entries.keys()].map((url) => ({ url }));
  }
  /** Paths (and queries) held. */
  paths(): string[] {
    return [...this.entries.keys()].map((u) => {
      const x = new URL(u);
      return `${x.pathname}${x.search}`;
    });
  }
}

export class MemoryCaches implements CacheStorageLike {
  readonly caches = new Map<string, MemoryCache>();
  async open(name: string): Promise<MemoryCache> {
    let c = this.caches.get(name);
    if (!c) this.caches.set(name, (c = new MemoryCache()));
    return c;
  }
  get(name: string): MemoryCache {
    return this.caches.get(name) ?? new MemoryCache();
  }
}
