import { afterAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../../db.js";
import {
  upsertClubDirectoryEntries,
  upsertRunnerDirectoryEntries,
} from "../../runner-directory-sync.js";
import { disconnect } from "../helpers/test-db.js";

const PERSON_BASE = BigInt(9_700_000_000 + Math.floor(Math.random() * 100_000));
const CLUB_BASE = BigInt(9_800_000_000 + Math.floor(Math.random() * 100_000));

afterAll(async () => {
  const db = prisma();
  await db.runnerDirectory.deleteMany({
    where: { eventorPersonId: { gte: PERSON_BASE, lt: PERSON_BASE + 10n } },
  });
  await db.clubDirectory.deleteMany({
    where: { eventorId: { gte: CLUB_BASE, lt: CLUB_BASE + 10n } },
  });
  await disconnect();
});

describe("runner directory batch upsert", () => {
  it("inserts and updates runners across batches", async () => {
    const db = prisma();
    const executeRaw = vi.spyOn(db, "$executeRaw");
    await upsertRunnerDirectoryEntries(
      db,
      [
        {
          eventorPersonId: PERSON_BASE,
          name: "First Runner",
          cardNo: 100,
          eventorClubId: 10,
          birthYear: 1990,
          sex: "M",
          nationality: "SWE",
        },
        {
          eventorPersonId: PERSON_BASE + 1n,
          name: "Second Runner",
          cardNo: 101,
          eventorClubId: 11,
          birthYear: 1991,
          sex: "F",
          nationality: "NOR",
        },
        {
          eventorPersonId: PERSON_BASE + 2n,
          name: "Third Runner",
          cardNo: 102,
          eventorClubId: 12,
          birthYear: 1992,
          sex: "",
          nationality: "FIN",
        },
      ],
      2,
    );
    expect(executeRaw).toHaveBeenCalledTimes(2);

    await upsertRunnerDirectoryEntries(
      db,
      [
        {
          eventorPersonId: PERSON_BASE + 1n,
          name: "Updated Runner",
          cardNo: 201,
          eventorClubId: 21,
          birthYear: 2001,
          sex: "F",
          nationality: "DEN",
        },
      ],
      2,
    );
    expect(executeRaw).toHaveBeenCalledTimes(3);
    executeRaw.mockRestore();

    const rows = await db.runnerDirectory.findMany({
      where: { eventorPersonId: { gte: PERSON_BASE, lt: PERSON_BASE + 3n } },
      orderBy: { eventorPersonId: "asc" },
    });
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({
      name: "Updated Runner",
      cardNo: 201,
      eventorClubId: 21,
      birthYear: 2001,
      sex: "F",
      nationality: "DEN",
    });
  });

  it("inserts and updates clubs without replacing logos", async () => {
    const db = prisma();
    await upsertClubDirectoryEntries(db, [
      {
        eventorId: CLUB_BASE,
        name: "Original Club",
        shortName: "Original",
        countryCode: "SWE",
      },
    ]);
    await db.clubDirectory.update({
      where: { eventorId: CLUB_BASE },
      data: { smallLogoPng: Buffer.from("logo") },
    });

    await upsertClubDirectoryEntries(db, [
      {
        eventorId: CLUB_BASE,
        name: "Updated Club",
        shortName: "Updated",
        countryCode: "NOR",
      },
    ]);

    const club = await db.clubDirectory.findUniqueOrThrow({
      where: { eventorId: CLUB_BASE },
    });
    expect(club).toMatchObject({
      name: "Updated Club",
      shortName: "Updated",
      countryCode: "NOR",
    });
    expect(Buffer.from(club.smallLogoPng!)).toEqual(Buffer.from("logo"));
  });
});
