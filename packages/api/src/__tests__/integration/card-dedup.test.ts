/**
 * Integration tests for cardList deduplication and manual card-to-runner linking.
 *
 * Validates that:
 * - cardList returns one row per CardNo even when multiple oCard records exist
 * - linkCardToRunner correctly links/unlinks/relinks cards and runners
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDbContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";

let ctx: TestDbContext;
let caller: ReturnType<typeof makeCaller>;

let classId: number;
let courseId: number;

const CONTROLS = [31, 32, 33];

beforeAll(async () => {
  ctx = await createTestDb("carddedup");
  caller = makeCaller();

  // Create class + course
  const cls = await ctx.client.oClass.create({
    data: {
      Name: "Dedup Test",
      Course: 0,
      FirstStart: 0,
      StartInterval: 0,
      SortIndex: 1,
      Removed: false,
      Counter: 0,
      FreeStart: 0,
    },
  });
  classId = cls.Id;

  const course = await ctx.client.oCourse.create({
    data: {
      Name: "Dedup Course",
      Controls: CONTROLS.join(";") + ";",
      Length: 2000,
      Legs: "600;600;600;",
    },
  });
  courseId = course.Id;

  await ctx.client.oClass.update({
    where: { Id: classId },
    data: { Course: courseId },
  });

  for (const code of CONTROLS) {
    await ctx.client.oControl.create({
      data: { Name: "", Numbers: `${code}`, Status: 0 },
    });
  }
});

afterAll(async () => {
  await ctx.cleanup();
});

// ── cardList deduplication ──

describe("cardList deduplication", () => {
  it("returns one row per CardNo when multiple oCard records exist", async () => {
    const cardNo = 700001;

    // Create two oCard records with the same CardNo
    const card1 = await ctx.client.oCard.create({
      data: { CardNo: cardNo, Punches: "31-100.0;", ReadId: 1 },
    });
    const card2 = await ctx.client.oCard.create({
      data: { CardNo: cardNo, Punches: "31-100.0;32-200.0;", ReadId: 2 },
    });

    const list = await caller.cardReadout.cardList();
    const matching = list.filter((c) => c.cardNo === cardNo);

    expect(matching).toHaveLength(1);
    // Should keep the one with highest Id (newest)
    expect(matching[0].id).toBe(card2.Id);
  });

  it("preserves cards that already have unique CardNo", async () => {
    const cardNoA = 700010;
    const cardNoB = 700011;

    await ctx.client.oCard.create({
      data: { CardNo: cardNoA, Punches: "", ReadId: 10 },
    });
    await ctx.client.oCard.create({
      data: { CardNo: cardNoB, Punches: "", ReadId: 11 },
    });

    const list = await caller.cardReadout.cardList();
    const matchA = list.filter((c) => c.cardNo === cardNoA);
    const matchB = list.filter((c) => c.cardNo === cardNoB);

    expect(matchA).toHaveLength(1);
    expect(matchB).toHaveLength(1);
  });

  it("does not include Removed cards", async () => {
    const cardNo = 700020;
    await ctx.client.oCard.create({
      data: { CardNo: cardNo, Punches: "", ReadId: 20, Removed: true },
    });

    const list = await caller.cardReadout.cardList();
    const matching = list.filter((c) => c.cardNo === cardNo);
    expect(matching).toHaveLength(0);
  });
});

// ── linkCardToRunner ──

describe("linkCardToRunner", () => {
  it("links an unlinked card to a runner", async () => {
    const cardNo = 800001;
    const card = await ctx.client.oCard.create({
      data: { CardNo: cardNo, Punches: "31-100.0;32-200.0;33-300.0;", ReadId: 100 },
    });
    const runner = await ctx.client.oRunner.create({
      data: { Name: "Alice", CardNo: 0, Card: 0, Class: classId, Club: 0, StartNo: 0 },
    });

    await caller.cardReadout.linkCardToRunner({ cardId: card.Id, runnerId: runner.Id });

    const updated = await ctx.client.oRunner.findUnique({ where: { Id: runner.Id } });
    expect(updated!.CardNo).toBe(cardNo);
    expect(updated!.Card).toBe(card.Id);
  });

  it("relinks card from runner A to runner B", async () => {
    const cardNo = 800002;
    const card = await ctx.client.oCard.create({
      data: { CardNo: cardNo, Punches: "", ReadId: 101 },
    });
    const runnerA = await ctx.client.oRunner.create({
      data: { Name: "Bob", CardNo: cardNo, Card: card.Id, Class: classId, Club: 0, StartNo: 0 },
    });
    const runnerB = await ctx.client.oRunner.create({
      data: { Name: "Carol", CardNo: 0, Card: 0, Class: classId, Club: 0, StartNo: 0 },
    });

    await caller.cardReadout.linkCardToRunner({ cardId: card.Id, runnerId: runnerB.Id });

    const updatedA = await ctx.client.oRunner.findUnique({ where: { Id: runnerA.Id } });
    expect(updatedA!.CardNo).toBe(0);
    expect(updatedA!.Card).toBe(0);

    const updatedB = await ctx.client.oRunner.findUnique({ where: { Id: runnerB.Id } });
    expect(updatedB!.CardNo).toBe(cardNo);
    expect(updatedB!.Card).toBe(card.Id);
  });

  it("unlinks card when runnerId is null", async () => {
    const cardNo = 800003;
    const card = await ctx.client.oCard.create({
      data: { CardNo: cardNo, Punches: "", ReadId: 102 },
    });
    const runner = await ctx.client.oRunner.create({
      data: { Name: "Dave", CardNo: cardNo, Card: card.Id, Class: classId, Club: 0, StartNo: 0 },
    });

    await caller.cardReadout.linkCardToRunner({ cardId: card.Id, runnerId: null });

    const updated = await ctx.client.oRunner.findUnique({ where: { Id: runner.Id } });
    expect(updated!.CardNo).toBe(0);
    expect(updated!.Card).toBe(0);
  });

  it("handles runner who already has a different card", async () => {
    const oldCardNo = 800010;
    const newCardNo = 800011;
    const oldCard = await ctx.client.oCard.create({
      data: { CardNo: oldCardNo, Punches: "", ReadId: 110 },
    });
    const newCard = await ctx.client.oCard.create({
      data: { CardNo: newCardNo, Punches: "", ReadId: 111 },
    });
    const runner = await ctx.client.oRunner.create({
      data: { Name: "Eve", CardNo: oldCardNo, Card: oldCard.Id, Class: classId, Club: 0, StartNo: 0 },
    });

    // Link the new card to the runner (who already has oldCard)
    await caller.cardReadout.linkCardToRunner({ cardId: newCard.Id, runnerId: runner.Id });

    const updated = await ctx.client.oRunner.findUnique({ where: { Id: runner.Id } });
    expect(updated!.CardNo).toBe(newCardNo);
    expect(updated!.Card).toBe(newCard.Id);
  });

  it("throws NOT_FOUND for invalid cardId", async () => {
    await expect(
      caller.cardReadout.linkCardToRunner({ cardId: 999999, runnerId: 1 }),
    ).rejects.toThrow(/not found/i);
  });

  it("throws NOT_FOUND for invalid runnerId", async () => {
    const card = await ctx.client.oCard.create({
      data: { CardNo: 800099, Punches: "", ReadId: 199 },
    });
    await expect(
      caller.cardReadout.linkCardToRunner({ cardId: card.Id, runnerId: 999999 }),
    ).rejects.toThrow(/not found/i);
  });
});
