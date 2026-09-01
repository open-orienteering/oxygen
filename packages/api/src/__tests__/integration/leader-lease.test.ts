/**
 * Integration tests for the cluster-wide leader lease.
 *
 * The interesting properties are all database properties — atomic
 * take-over, mutual exclusion between two holders, expiry measured
 * against the server clock — so they are tested against real Postgres
 * rather than a fake. Each test uses its own lease name so suites can
 * never interfere with each other, and drops the row afterwards
 * (`instance_lease` is global, so cleanup is the caller's job).
 */

import { describe, it, expect, afterEach } from "vitest";
import { randomBytes } from "crypto";
import { prisma } from "../../db.js";
import { dbLeaseStore, leaseHolder } from "../../leader.js";

const store = dbLeaseStore(prisma);
const usedNames: string[] = [];

function leaseName(label: string): string {
  const name = `test-${label}-${randomBytes(4).toString("hex")}`;
  usedNames.push(name);
  return name;
}

afterEach(async () => {
  if (usedNames.length === 0) return;
  await prisma().instanceLease.deleteMany({
    where: { name: { in: usedNames.splice(0) } },
  });
});

describe("leader lease", () => {
  it("grants the lease to the first caller and refuses the second", async () => {
    const name = leaseName("exclusive");

    expect(await store.acquire(name, "instance-a", 60_000)).toBe(true);
    expect(await store.acquire(name, "instance-b", 60_000)).toBe(false);

    const holder = await leaseHolder(prisma(), name);
    expect(holder?.holderId).toBe("instance-a");
  });

  it("lets the holder renew without resetting when it first took over", async () => {
    const name = leaseName("renew");

    expect(await store.acquire(name, "instance-a", 60_000)).toBe(true);
    const first = await leaseHolder(prisma(), name);

    expect(await store.acquire(name, "instance-a", 60_000)).toBe(true);
    const second = await leaseHolder(prisma(), name);

    // `acquiredAt` is how long this instance has been leader, so a
    // renewal must not disturb it. The expiry has to move, otherwise
    // renewing would not keep the lease alive.
    expect(second?.acquiredAt.getTime()).toBe(first?.acquiredAt.getTime());
    expect(second?.expiresAt.getTime()).toBeGreaterThanOrEqual(
      first?.expiresAt.getTime() ?? 0,
    );
  });

  it("hands an expired lease to whoever asks next", async () => {
    const name = leaseName("takeover");

    // A zero TTL expires the lease at the current transaction's `now()`,
    // so the next statement's `now()` is already past it. That keeps the
    // test deterministic — no sleeping on a wall clock.
    expect(await store.acquire(name, "instance-a", 0)).toBe(true);
    expect(await store.acquire(name, "instance-b", 60_000)).toBe(true);

    const holder = await leaseHolder(prisma(), name);
    expect(holder?.holderId).toBe("instance-b");

    // The new holder now owns it outright.
    expect(await store.acquire(name, "instance-a", 60_000)).toBe(false);
  });

  it("frees the lease on release, and ignores a release from a non-holder", async () => {
    const name = leaseName("release");

    expect(await store.acquire(name, "instance-a", 60_000)).toBe(true);

    await store.release(name, "instance-b");
    expect(await store.acquire(name, "instance-c", 60_000)).toBe(false);

    await store.release(name, "instance-a");
    expect(await leaseHolder(prisma(), name)).toBeNull();
    expect(await store.acquire(name, "instance-c", 60_000)).toBe(true);
  });

  it("elects exactly one leader when instances start simultaneously", async () => {
    const name = leaseName("race");
    const holders = ["a", "b", "c", "d", "e", "f"];

    const results = await Promise.all(
      holders.map((h) => store.acquire(name, `instance-${h}`, 60_000)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = holders[results.indexOf(true)];
    const holder = await leaseHolder(prisma(), name);
    expect(holder?.holderId).toBe(`instance-${winner}`);
  });

  it("reports no holder for a lease nobody has taken", async () => {
    expect(await leaseHolder(prisma(), leaseName("absent"))).toBeNull();
  });
});
