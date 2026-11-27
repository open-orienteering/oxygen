/**
 * The delivery-mark backfill of migration 20261125120000_venue_shipping_lease
 * (review H1/M4). The block between the `backfill:begin/end` markers runs
 * here against freshly inserted rows with `pushed_at` reset to NULL, scoped
 * to this suite's events so parallel suites keep their marks.
 *
 * The rule marks an entry delivered only when it was received before the
 * acquire time of the event's latest lease; see the migration comment.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";

const SQL = readFileSync(
  resolve(__dirname, "../../../prisma/migrations/20261125120000_venue_shipping_lease/migration.sql"),
  "utf8",
);
const block = SQL.slice(SQL.indexOf("-- backfill:begin") + "-- backfill:begin".length, SQL.indexOf("-- backfill:end"));
const SCOPED = block.replace("WHERE j.event_id = x.event_id", "WHERE j.event_id = x.event_id AND j.event_id = ANY($1::bigint[])");

let ctx: TestEventContext;
const extra: TestEventContext[] = [];

const T0 = new Date("2026-06-01T10:00:00Z");
const BEFORE = new Date("2026-06-01T09:00:00Z");
const AFTER = new Date("2026-06-01T11:00:00Z");

async function entry(ec: TestEventContext, label: string, receivedAt: Date) {
  return ec.db.journalEntry.create({
    data: {
      eventId: ec.eventId,
      type: "test.entry",
      stationId: label,
      clientTimestamp: receivedAt,
      receivedAt,
      payload: {},
      pushedAt: null,
    },
  });
}

async function backfill(ids: bigint[]) {
  // Prisma's raw API cannot bind an array parameter into the extracted block
  // unchanged, so inline the (numeric) ids.
  const list = `ARRAY[${ids.map((i) => `${i.toString()}`).join(",")}]::bigint[]`;
  await ctx.db.$executeRawUnsafe(SCOPED.replace("$1::bigint[]", list));
}

async function marks(ec: TestEventContext): Promise<Record<string, boolean>> {
  const rows = await ec.db.journalEntry.findMany({ where: { eventId: ec.eventId } });
  return Object.fromEntries(rows.map((r) => [r.stationId, r.pushedAt !== null]));
}

beforeAll(async () => {
  expect(SCOPED).not.toBe(block);
  ctx = await createTestEvent("bfplain");
  for (const n of ["cloud", "boxactive", "boxin", "cloudrel"]) extra.push(await createTestEvent(`bf${n}`));
});

afterAll(async () => {
  for (const e of extra) await e.cleanup();
  await ctx.cleanup();
  await disconnect();
});

describe("journal pushed_at backfill", () => {
  it("plain event, no lease and no sync state: everything delivered", async () => {
    await entry(ctx, "a", BEFORE);
    await entry(ctx, "b", AFTER);
    await backfill([ctx.eventId]);
    expect(await marks(ctx)).toEqual({ a: true, b: true });
  });

  it("cloud with an active lease: entries before the acquire are delivered, later ones ship", async () => {
    const [cloud] = extra;
    await cloud.db.eventLease.create({ data: { eventId: cloud.eventId, holderNodeId: "box-1", acquiredAt: T0 } });
    await entry(cloud, "pre1", BEFORE);
    await entry(cloud, "pre2", new Date(T0.getTime() - 1));
    await entry(cloud, "during", AFTER);
    await backfill([cloud.eventId]);
    expect(await marks(cloud)).toEqual({ pre1: true, pre2: true, during: false });
  });

  it("box with an active lease: entries before the acquire delivered, its own later ones NULL", async () => {
    const box = extra[1];
    await box.db.journalSyncState.create({ data: { peerId: "peer", eventId: box.eventId } });
    await box.db.eventLease.create({ data: { eventId: box.eventId, holderNodeId: "box-1", acquiredAt: T0 } });
    await entry(box, "old", BEFORE);
    await entry(box, "mine1", AFTER);
    await entry(box, "mine2", AFTER);
    await backfill([box.eventId]);
    expect(await marks(box)).toEqual({ old: true, mine1: false, mine2: false });
  });

  it("box with a checked-in event and an unshipped tail: the tail stays NULL", async () => {
    const box = extra[2];
    await box.db.journalSyncState.create({
      data: { peerId: "peer", eventId: box.eventId, pushedHlc: 99n * 65536n, pushedId: "zzz" },
    });
    await box.db.eventLease.create({
      data: { eventId: box.eventId, holderNodeId: "box-1", acquiredAt: T0, releasedAt: AFTER },
    });
    await entry(box, "tail1", AFTER);
    await entry(box, "tail2", new Date(AFTER.getTime() + 60_000));
    await backfill([box.eventId]);
    // Even entries under the legacy push cursor stay NULL: the HLC watermark skipped late ones.
    expect(await marks(box)).toEqual({ tail1: false, tail2: false });
  });

  it("cloud whose lease was released: everything delivered", async () => {
    const cloud = extra[3];
    await cloud.db.eventLease.create({
      data: { eventId: cloud.eventId, holderNodeId: "box-1", acquiredAt: T0, releasedAt: AFTER },
    });
    await entry(cloud, "during", new Date(T0.getTime() + 1000));
    await backfill([cloud.eventId]);
    expect(await marks(cloud)).toEqual({ during: true });
  });

  it("is idempotent and leaves a delivered mark alone", async () => {
    const [cloud] = extra;
    const before = await cloud.db.journalEntry.findMany({ where: { eventId: cloud.eventId }, orderBy: { id: "asc" } });
    await backfill([cloud.eventId]);
    const after = await cloud.db.journalEntry.findMany({ where: { eventId: cloud.eventId }, orderBy: { id: "asc" } });
    expect(after.map((r) => r.pushedAt?.getTime() ?? null)).toEqual(before.map((r) => r.pushedAt?.getTime() ?? null));
  });
});
