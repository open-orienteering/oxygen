import { describe, it, expect } from "vitest";
import { buildRunnerProjection } from "../offline/projection";
import type { RunnerInfo } from "@oxygen/shared";
import type { OxygenEvent } from "../offline/db";

const COMP = "itest";

function runner(p: Partial<RunnerInfo> & { id: number }): RunnerInfo {
  return {
    name: "R",
    cardNo: 0,
    clubId: 0,
    classId: 1,
    startNo: 0,
    startTime: 0,
    finishTime: 0,
    status: 0,
    ...p,
  } as RunnerInfo;
}

let n = 0;
function ev(
  type: OxygenEvent["type"],
  payload: Record<string, unknown>,
  timestamp = ++n,
): OxygenEvent {
  n++;
  return {
    id: `e${n}`,
    type,
    competitionId: COMP,
    stationId: "A",
    timestamp,
    payload: payload as never,
    status: "pending",
    attempts: 0,
  };
}

describe("buildRunnerProjection", () => {
  it("hydrates the snapshot base verbatim (rich status + times preserved)", () => {
    const { runners } = buildRunnerProjection(
      COMP,
      [runner({ id: 5, name: "Alice", cardNo: 100, classId: 2, startTime: 360000, finishTime: 366000, status: 3 })],
      [],
    );
    expect(runners).toHaveLength(1);
    expect(runners[0]).toMatchObject({
      id: "card:100",
      seq: 5,
      cardNo: 100,
      name: "Alice",
      classId: 2,
      startTime: 360000,
      finishTime: 366000,
      status: 3, // MissingPunch preserved — not flattened to OK
    });
  });

  it("inserts an offline-registered runner that is not in the snapshot (seq null)", () => {
    const { runners } = buildRunnerProjection(COMP, [], [
      ev("runner.registered", { tempId: "u1", name: "Bob", classId: 2, cardNo: 200, clubId: 7 }),
    ]);
    const r = runners.find((x) => x.cardNo === 200)!;
    expect(r).toMatchObject({ name: "Bob", classId: 2, seq: null, eventorClubId: 7 });
  });

  it("overlays an offline finish onto a snapshot runner, matched by cardNo", () => {
    const { runners } = buildRunnerProjection(
      COMP,
      [runner({ id: 5, cardNo: 100, status: 0, finishTime: 0 })],
      [ev("finish.recorded", { cardNo: 100, finishTime: 366000 })],
    );
    expect(runners[0]).toMatchObject({ finishTime: 366000, status: 1 });
  });

  it("own writes replay sequentially — the station's pending finish overlays the snapshot", () => {
    // No merge logic: the overlay shows what this station did; the server
    // stays authoritative once the entry syncs and the snapshot refetches.
    const { runners } = buildRunnerProjection(
      COMP,
      [runner({ id: 5, cardNo: 100, status: 1, finishTime: 366000 })],
      [ev("finish.recorded", { cardNo: 100, finishTime: 999999 })],
    );
    expect(runners[0].finishTime).toBe(999999);
  });

  it("later own writes win over earlier ones (sequential self-replay)", () => {
    const { runners } = buildRunnerProjection(
      COMP,
      [runner({ id: 5, cardNo: 100 })],
      [
        ev("start.recorded", { cardNo: 100, startTime: 360000 }),
        ev("start.recorded", { cardNo: 100, startTime: 361000 }),
      ],
    );
    expect(runners[0].startTime).toBe(361000);
  });

  it("resolves a cardless runner by seq (regression: key mismatch dropped these)", () => {
    const { runners } = buildRunnerProjection(
      COMP,
      [runner({ id: 5, cardNo: 0, name: "NoCard" })],
      [ev("result.applied", { runnerId: 5, status: 4, finishTime: 366050, startTime: 360000 })],
    );
    const r = runners.find((x) => x.seq === 5)!;
    expect(r).toMatchObject({ status: 4, finishTime: 366050, startTime: 360000 });
  });

  it("re-registration of the same card updates fields in place", () => {
    const { runners } = buildRunnerProjection(COMP, [], [
      ev("runner.registered", { tempId: "u1", name: "Bob", classId: 2, cardNo: 200 }),
      ev("runner.registered", { tempId: "u2", name: "Bobby", classId: 3, cardNo: 200 }),
    ]);
    const matches = runners.filter((x) => x.cardNo === 200);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ name: "Bobby", classId: 3 });
  });

  it("result.applied overlays status / start / finish", () => {
    const { runners } = buildRunnerProjection(
      COMP,
      [runner({ id: 5, cardNo: 100, status: 0 })],
      [ev("result.applied", { cardNo: 100, status: 3, finishTime: 366050, startTime: 360000 })],
    );
    expect(runners[0]).toMatchObject({ status: 3, finishTime: 366050, startTime: 360000 });
  });

  it("dedupes punches and card reads", () => {
    const { punches, readouts } = buildRunnerProjection(COMP, [], [
      ev("punch.recorded", { cardNo: 100, controlCode: 31, time: 1000 }),
      ev("punch.recorded", { cardNo: 100, controlCode: 31, time: 1000 }),
      ev("card.read", { cardNo: 100, punches: [] }, 1_000_000),
      ev("card.read", { cardNo: 100, punches: [] }, 1_030_000), // within 60s → dup
    ]);
    expect(punches).toHaveLength(1);
    expect(readouts).toHaveLength(1);
  });
});
