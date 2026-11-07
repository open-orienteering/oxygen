/**
 * Red exit: a run that matches another variant (slice F, row F6c; user
 * answer 3, 2026-11-07; docs/registration-and-readout.md §4f, §5c;
 * docs/course-controls-and-matching.md "Forked courses and variants"):
 *
 *   - performReadout names the pooled variants the punches validate fully
 *     against (`otherVariantMatches`) and changes nothing else
 *   - the dashboard carries the class pools (`coursePoolIds`) and the
 *     variant keys for the offline readout
 *   - cardReadout.acceptVariant switches the runner's variant by hand,
 *     applies status / times, journals runner.updated + result.applied,
 *     and refuses (writing nothing) a course outside the pool, the current
 *     course, and a variant the punches do not fully match
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { WireCourseStructure } from "@oxygen/shared";
import { RunnerStatus } from "@oxygen/shared";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";

let ctx: TestEventContext;
let caller: ReturnType<typeof makeCaller>;
let S: number;
let F: number;
const site: Record<number, number> = {};

type Items = WireCourseStructure["items"];
const ctl = (siteId: number): Items[number] => ({ siteId });
const group = (id: string, alts: number[][]): Items[number] => ({
  kind: "variation",
  id,
  alternatives: alts.map((ids, i) => ({ label: String.fromCharCode(65 + i), items: ids.map((siteId) => ({ siteId })) })),
});

/** A root `name`: 31 → (A 32 | B 33 | C 35 when `three`) → 34. */
async function forkedCourse(name: string, three = false) {
  const { id } = await caller.course.create({ name });
  const alts = three ? [[site[32]], [site[33]], [site[35]]] : [[site[32]], [site[33]]];
  await caller.course.setStructure({
    courseId: id,
    structure: {
      version: 1,
      id: "x",
      orderMode: "ordered",
      items: [ctl(S), ctl(site[31]), group("g", alts), ctl(site[34]), ctl(F)],
    },
  });
  const variants = await caller.course.variantList({ courseId: id });
  return { id, variants, key: (k: string) => variants.find((v) => v.variantKey === k)!.courseId };
}

/** A card read: start 10:00, finish 11:00, the given codes in between. */
const read = (cardNo: number, codes: number[], finish = true) => ({
  cardNo,
  cardType: "SI Card 9",
  startTime: 360000,
  finishTime: finish ? 396000 : null,
  punches: codes.map((controlCode, i) => ({ controlCode, time: 366000 + i * 6000 })),
});

async function entriesDuring(fn: () => Promise<unknown>) {
  const head = await ctx.db.journalEntry.findFirst({
    where: { eventId: ctx.eventId },
    orderBy: { hlc: "desc" },
    select: { hlc: true },
  });
  await fn();
  return ctx.db.journalEntry.findMany({
    where: { eventId: ctx.eventId, hlc: { gt: head?.hlc ?? 0n } },
    orderBy: { hlc: "asc" },
  });
}

async function runnerRow(seq: number) {
  return ctx.db.runner.findFirstOrThrow({
    where: { eventId: ctx.eventId, seq },
    select: { status: true, finishTime: true, course: { select: { seq: true } } },
  });
}

let card = 710000;
const nextCard = () => ++card;

beforeAll(async () => {
  ctx = await createTestEvent("variant_accept");
  caller = makeCaller(ctx.event);
  S = (await caller.control.create({ status: 4, xpos: 10, ypos: 10 })).id;
  F = (await caller.control.create({ status: 5, xpos: 90, ypos: 10 })).id;
  for (const [code, x] of [[31, 20], [32, 30], [33, 40], [34, 50], [35, 60]] as const) {
    site[code] = (await caller.control.create({ codes: String(code), xpos: x, ypos: 20 })).id;
  }
});

afterAll(async () => {
  await ctx.cleanup();
  await disconnect();
});

describe("performReadout: otherVariantMatches", () => {
  it("a runner on A with B's punches is MP on A and names B; status and course unchanged", async () => {
    const root = await forkedCourse("Match", true);
    const { id: classId } = await caller.class.create({ name: "M1", courseId: root.id });
    const cardNo = nextCard();
    const { id } = await caller.runner.create({ name: "Wrong map", classId, cardNo, courseId: root.key("A") });
    await caller.cardReadout.storeReadout(read(cardNo, [31, 33, 34]));
    const r = await caller.cardReadout.readoutByRunner({ runnerId: id });
    expect(r?.timing.status).toBe(RunnerStatus.MissingPunch);
    expect(r?.course?.id).toBe(root.key("A"));
    expect(r?.otherVariantMatches).toEqual([{ courseId: root.key("B"), variantKey: "B", courseName: "Match B" }]);
    // The kiosk's read path carries the same field.
    const k = await caller.cardReadout.readout({ cardNo });
    expect(k.found && k.otherVariantMatches.map((m) => m.variantKey)).toEqual(["B"]);
  });

  it("an OK run, a plain mispunch and a class without a pool name nothing", async () => {
    const root = await forkedCourse("NoMatch");
    const { id: classId } = await caller.class.create({ name: "M2", courseId: root.id });
    const ok = nextCard();
    const mp = nextCard();
    const a = (await caller.runner.create({ name: "Right map", classId, cardNo: ok, courseId: root.key("B") })).id;
    const b = (await caller.runner.create({ name: "Lost", classId, cardNo: mp, courseId: root.key("A") })).id;
    await caller.cardReadout.storeReadout(read(ok, [31, 33, 34]));
    await caller.cardReadout.storeReadout(read(mp, [31, 34]));
    const ra = await caller.cardReadout.readoutByRunner({ runnerId: a });
    const rb = await caller.cardReadout.readoutByRunner({ runnerId: b });
    expect(ra?.timing.status).toBe(RunnerStatus.OK);
    expect(ra?.otherVariantMatches).toEqual([]);
    expect(rb?.timing.status).toBe(RunnerStatus.MissingPunch);
    expect(rb?.otherVariantMatches).toEqual([]);

    const { id: plainCourse } = await caller.course.create({ name: "Plain", controlIds: [site[31], site[32], site[34]] });
    const { id: plainClass } = await caller.class.create({ name: "M2 plain", courseId: plainCourse });
    const pc = nextCard();
    const p = (await caller.runner.create({ name: "Plain MP", classId: plainClass, cardNo: pc })).id;
    await caller.cardReadout.storeReadout(read(pc, [31, 33, 34]));
    const rp = await caller.cardReadout.readoutByRunner({ runnerId: p });
    expect(rp?.timing.status).toBe(RunnerStatus.MissingPunch);
    expect(rp?.otherVariantMatches).toEqual([]);
  });
});

describe("dashboard: class pools for the offline readout", () => {
  it("a pooled class carries its variants' seqs in key order, a plain class []; courses carry their key", async () => {
    const root = await forkedCourse("Dash", true);
    const { id: classId } = await caller.class.create({ name: "D1", courseId: root.id });
    const { id: plainClass } = await caller.class.create({ name: "D1 plain" });
    const dash = await caller.competition.dashboard();
    const cls = dash.classes.find((c) => c.id === classId)!;
    expect(cls.coursePoolIds).toEqual([root.key("A"), root.key("B"), root.key("C")]);
    expect(dash.classes.find((c) => c.id === plainClass)!.coursePoolIds).toEqual([]);
    expect(dash.courses.find((c) => c.id === root.key("C"))!.variantKey).toBe("C");
    expect(dash.courses.find((c) => c.id === root.id)!.variantKey).toBeNull();
  });
});

describe("cardReadout.acceptVariant", () => {
  it("switches the runner to the matched variant, applies OK and the times, and journals both rows", async () => {
    const root = await forkedCourse("Accept");
    const { id: classId } = await caller.class.create({ name: "A1", courseId: root.id });
    const cardNo = nextCard();
    const { id } = await caller.runner.create({ name: "Accepted", classId, cardNo, courseId: root.key("A") });
    await caller.cardReadout.storeReadout(read(cardNo, [31, 33, 34]));
    const before = await caller.cardReadout.readoutByRunner({ runnerId: id });
    await caller.cardReadout.applyResult({
      runnerId: id,
      status: before!.timing.status,
      finishTime: before!.timing.finishTime,
      startTime: before!.timing.startTime,
    });
    expect((await runnerRow(id)).status).toBe("missing_punch");

    let res: Awaited<ReturnType<typeof caller.cardReadout.acceptVariant>> | undefined;
    const entries = await entriesDuring(async () => {
      res = await caller.cardReadout.acceptVariant({ runnerId: id, courseId: root.key("B") });
    });
    expect(res).toEqual({ ok: true, courseId: root.key("B"), variantKey: "B", status: RunnerStatus.OK });

    const row = await runnerRow(id);
    expect(row.course?.seq).toBe(root.key("B"));
    expect(row.status).toBe("ok");
    const after = await caller.cardReadout.readoutByRunner({ runnerId: id });
    expect(after?.timing.status).toBe(RunnerStatus.OK);
    expect(after?.course?.name).toBe("Accept B");
    expect(after?.otherVariantMatches).toEqual([]);

    expect(entries.map((e) => e.type)).toEqual(["runner.updated", "result.applied"]);
    expect(entries[0].payload).toEqual({
      cardNo,
      runnerId: id,
      fields: { courseId: root.key("B"), variantAccepted: true },
    });
    expect(entries[1].payload).toEqual({
      cardNo,
      runnerId: id,
      status: RunnerStatus.OK,
      finishTime: after!.timing.finishTime,
      startTime: after!.timing.startTime,
    });

    // The reads follow the new course by construction.
    const start = (await caller.lists.startList({ classId })).find((r) => r.id === id)!;
    expect(start.variantKey).toBe("B");
  });

  it("refuses a course outside the pool, the current course and a variant not fully matched — writing nothing", async () => {
    const root = await forkedCourse("Refuse");
    const other = await forkedCourse("Refuse other");
    const { id: classId } = await caller.class.create({ name: "A2", courseId: root.id });
    const good = nextCard();
    const bad = nextCard();
    const dnf = nextCard();
    const g = (await caller.runner.create({ name: "R good", classId, cardNo: good, courseId: root.key("A") })).id;
    const b = (await caller.runner.create({ name: "R bad", classId, cardNo: bad, courseId: root.key("A") })).id;
    const d = (await caller.runner.create({ name: "R dnf", classId, cardNo: dnf, courseId: root.key("A") })).id;
    await caller.cardReadout.storeReadout(read(good, [31, 33, 34]));
    await caller.cardReadout.storeReadout(read(bad, [31, 34]));
    await caller.cardReadout.storeReadout(read(dnf, [31, 33, 34], false));

    const entries = await entriesDuring(async () => {
      await expect(caller.cardReadout.acceptVariant({ runnerId: g, courseId: other.key("B") })).rejects.toThrow(
        /VARIANT_NOT_IN_POOL/,
      );
      await expect(caller.cardReadout.acceptVariant({ runnerId: g, courseId: root.id })).rejects.toThrow(
        /VARIANT_NOT_IN_POOL/,
      );
      await expect(caller.cardReadout.acceptVariant({ runnerId: g, courseId: root.key("A") })).rejects.toThrow(
        /VARIANT_IS_CURRENT/,
      );
      await expect(caller.cardReadout.acceptVariant({ runnerId: b, courseId: root.key("B") })).rejects.toThrow(
        /VARIANT_NOT_MATCHED/,
      );
      await expect(caller.cardReadout.acceptVariant({ runnerId: d, courseId: root.key("B") })).rejects.toThrow(
        /VARIANT_NOT_MATCHED/,
      );
      await expect(caller.cardReadout.acceptVariant({ runnerId: 999999, courseId: root.key("B") })).rejects.toThrow(
        /not found/,
      );
    });
    expect(entries).toEqual([]);
    for (const seq of [g, b, d]) expect((await runnerRow(seq)).course?.seq).toBe(root.key("A"));
  });

  it("a runner in a class without a pool is VARIANT_NOT_IN_POOL", async () => {
    const { id: plainCourse } = await caller.course.create({ name: "Plain A3", controlIds: [site[31], site[34]] });
    const { id: plainClass } = await caller.class.create({ name: "A3 plain", courseId: plainCourse });
    const { id } = await caller.runner.create({ name: "Plain", classId: plainClass, cardNo: nextCard() });
    await expect(caller.cardReadout.acceptVariant({ runnerId: id, courseId: plainCourse })).rejects.toThrow(
      /VARIANT_NOT_IN_POOL/,
    );
  });
});
