import { describe, it, expect, afterEach } from "vitest";
import {
  DEFAULTS,
  RenderBusyError,
  Semaphore,
  evictForInsert,
  intSetting,
  precacheBlockDelayMs,
  precacheEnabled,
  precacheMaxZoom,
  precacheMinZoom,
  renderMaxQueue,
} from "../map-render-limits.js";

describe("intSetting", () => {
  it("falls back to the default when unset or empty", () => {
    expect(intSetting(undefined, 4, 1)).toBe(4);
    expect(intSetting("", 4, 1)).toBe(4);
  });

  it("accepts a valid override", () => {
    expect(intSetting("8", 4, 1)).toBe(8);
  });

  it("rejects garbage, fractions and values below the minimum", () => {
    expect(intSetting("lots", 4, 1)).toBe(4);
    expect(intSetting("0", 4, 1)).toBe(4);
    expect(intSetting("-2", 4, 1)).toBe(4);
    expect(intSetting("2.5", 4, 1)).toBe(4);
  });

  it("allows a minimum of zero when the setting permits it", () => {
    expect(intSetting("0", 4, 0)).toBe(0);
  });
});

describe("DEFAULTS", () => {
  // A window is blockTiles*256*supersample px per side plus the bounding-box
  // slack of a rotated block, so these have to stay small enough that a few
  // concurrent renders fit a 4 GiB container.
  it("keeps the default window well inside the pixel clamp", () => {
    const sidePx = DEFAULTS.blockTiles * 256 * DEFAULTS.supersample;
    // Allow for a rotated block's bounding box being up to sqrt(2) larger.
    const worstCase = sidePx * Math.SQRT2 * (sidePx * Math.SQRT2);
    expect(worstCase).toBeLessThanOrEqual(DEFAULTS.windowMaxPixels);
  });

  it("renders more than one tile per window so the SVG parse amortizes", () => {
    expect(DEFAULTS.blockTiles).toBeGreaterThan(1);
  });
});

describe("pre-cache settings", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("is on unless explicitly switched off", () => {
    delete process.env.MAP_TILE_PRECACHE;
    expect(precacheEnabled()).toBe(true);
    process.env.MAP_TILE_PRECACHE = "on";
    expect(precacheEnabled()).toBe(true);
    process.env.MAP_TILE_PRECACHE = "OFF";
    expect(precacheEnabled()).toBe(false);
    process.env.MAP_TILE_PRECACHE = " off ";
    expect(precacheEnabled()).toBe(false);
  });

  it("pauses between blocks by default so background work stays polite", () => {
    delete process.env.MAP_PRECACHE_BLOCK_DELAY_MS;
    expect(precacheBlockDelayMs()).toBeGreaterThan(0);
    process.env.MAP_PRECACHE_BLOCK_DELAY_MS = "0";
    expect(precacheBlockDelayMs()).toBe(0);
  });

  // An inverted span would make the progress denominator zero and the
  // pre-cache loop a no-op, so the ceiling is clamped up to the floor.
  it("never lets the ceiling fall below the floor", () => {
    process.env.MAP_PRECACHE_MIN_ZOOM = "12";
    process.env.MAP_PRECACHE_MAX_ZOOM = "9";
    expect(precacheMaxZoom()).toBe(12);
  });

  it("uses the module defaults when unset", () => {
    delete process.env.MAP_PRECACHE_MIN_ZOOM;
    delete process.env.MAP_PRECACHE_MAX_ZOOM;
    expect(precacheMinZoom()).toBeLessThan(precacheMaxZoom());
  });
});

describe("evictForInsert", () => {
  it("evicts oldest entries until an insert stays within the cap", () => {
    const cache = new Map<string, number>([["a", 1], ["b", 2], ["c", 3]]);
    evictForInsert(cache, 3);
    expect([...cache.keys()]).toEqual(["b", "c"]);
  });

  it("evicts everything when the cap is 1", () => {
    const cache = new Map<string, number>([["a", 1], ["b", 2]]);
    evictForInsert(cache, 1);
    expect(cache.size).toBe(0);
  });

  it("does nothing while there is room", () => {
    const cache = new Map<string, number>([["a", 1]]);
    evictForInsert(cache, 3);
    expect(cache.size).toBe(1);
  });
});

describe("Semaphore", () => {
  it("runs tasks immediately up to the limit", async () => {
    const sem = new Semaphore(2);
    let running = 0;
    let peak = 0;
    const task = async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
    };
    await Promise.all([sem.run(task), sem.run(task), sem.run(task), sem.run(task)]);
    expect(peak).toBe(2);
  });

  it("returns the task's value", async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => 42)).resolves.toBe(42);
  });

  // A throwing render must not leak a permit, or the renderer wedges after
  // a handful of bad maps.
  it("releases the permit when a task throws", async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(sem.run(async () => "ok")).resolves.toBe("ok");
  });

  // The pre-cache must not put a user behind a whole background sweep.
  it("serves foreground waiters before background ones", async () => {
    const sem = new Semaphore(1);
    const order: string[] = [];
    const blocker = sem.run(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    // Both queue behind the blocker; the background one arrived first.
    const bg = sem.run(async () => { order.push("background"); }, { background: true });
    const fg = sem.run(async () => { order.push("foreground"); });
    await Promise.all([blocker, bg, fg]);
    expect(order).toEqual(["foreground", "background"]);
  });

  it("still runs background work when nothing competes", async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => "bg", { background: true })).resolves.toBe("bg");
  });

  it("serialises when the limit is 1", async () => {
    const sem = new Semaphore(1);
    const order: string[] = [];
    const a = sem.run(async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 10));
      order.push("a-end");
    });
    const b = sem.run(async () => {
      order.push("b-start");
    });
    await Promise.all([a, b]);
    expect(order).toEqual(["a-start", "a-end", "b-start"]);
  });

  // Cloud Run holds a request open for up to 300 s; a tile that would wait
  // longer than that behind other renders must be refused immediately so
  // the client can back off and retry instead of the platform 504-ing it.
  describe("maxQueue", () => {
    function deferred() {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      return { promise, resolve };
    }

    it("rejects a foreground task once the foreground queue is full", async () => {
      const sem = new Semaphore(1);
      const gate = deferred();
      const blocker = sem.run(() => gate.promise);
      const release = gate.resolve;
      const waiting = sem.run(async () => "waited", { maxQueue: 1 });
      await expect(
        sem.run(async () => "refused", { maxQueue: 1 }),
      ).rejects.toBeInstanceOf(RenderBusyError);
      expect(sem.foregroundWaiting).toBe(1);
      release();
      await expect(waiting).resolves.toBe("waited");
      await blocker;
    });

    it("runs immediately when a permit is free, regardless of maxQueue", async () => {
      const sem = new Semaphore(1);
      await expect(sem.run(async () => "ok", { maxQueue: 0 })).resolves.toBe("ok");
    });

    it("never refuses background work and does not count it towards the bound", async () => {
      const sem = new Semaphore(1);
      const gate = deferred();
      const blocker = sem.run(() => gate.promise);
      const release = gate.resolve;
      const bg1 = sem.run(async () => "bg1", { background: true, maxQueue: 0 });
      const bg2 = sem.run(async () => "bg2", { background: true, maxQueue: 0 });
      // Only background waiters so far: a bounded foreground task still fits.
      const fg = sem.run(async () => "fg", { maxQueue: 1 });
      expect(sem.foregroundWaiting).toBe(1);
      release();
      await expect(Promise.all([bg1, bg2, fg])).resolves.toEqual(["bg1", "bg2", "fg"]);
      await blocker;
    });

    it("waits without limit when maxQueue is not given", async () => {
      const sem = new Semaphore(1);
      const gate = deferred();
      const blocker = sem.run(() => gate.promise);
      const release = gate.resolve;
      const many = Array.from({ length: 20 }, (_, i) => sem.run(async () => i));
      expect(sem.foregroundWaiting).toBe(20);
      release();
      await expect(Promise.all(many)).resolves.toHaveLength(20);
      await blocker;
    });
  });
});

describe("renderMaxQueue", () => {
  const saved = process.env.MAP_RENDER_MAX_QUEUE;
  afterEach(() => {
    if (saved === undefined) delete process.env.MAP_RENDER_MAX_QUEUE;
    else process.env.MAP_RENDER_MAX_QUEUE = saved;
  });

  it("defaults to a handful of blocks so a full queue answers well inside a 300 s request cap", () => {
    delete process.env.MAP_RENDER_MAX_QUEUE;
    expect(renderMaxQueue()).toBe(DEFAULTS.renderMaxQueue);
    expect(DEFAULTS.renderMaxQueue).toBeGreaterThanOrEqual(2);
    expect(DEFAULTS.renderMaxQueue).toBeLessThanOrEqual(8);
  });

  it("accepts zero to refuse any queueing at all", () => {
    process.env.MAP_RENDER_MAX_QUEUE = "0";
    expect(renderMaxQueue()).toBe(0);
  });
});
