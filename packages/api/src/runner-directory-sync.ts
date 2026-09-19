import {
  Prisma,
  type PrismaClient,
} from "./generated/prisma/client.js";

export interface RunnerDirectoryEntry {
  eventorPersonId: bigint;
  name: string;
  cardNo: number;
  eventorClubId: number;
  birthYear: number;
  sex: string;
  nationality: string;
}

export interface ClubDirectoryEntry {
  eventorId: bigint;
  name: string;
  shortName: string;
  countryCode: string;
}

const DEFAULT_BATCH_SIZE = 1_000;

function batches<T>(rows: T[], batchSize: number): T[][] {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error("batchSize must be a positive integer");
  }
  const result: T[][] = [];
  for (let i = 0; i < rows.length; i += batchSize) {
    result.push(rows.slice(i, i + batchSize));
  }
  return result;
}

/**
 * Upsert runner-directory rows with one PostgreSQL statement per batch.
 * De-duplicating first avoids PostgreSQL's "cannot affect row a second time"
 * error if Eventor happens to return the same person more than once.
 */
export async function upsertRunnerDirectoryEntries(
  db: PrismaClient,
  entries: RunnerDirectoryEntry[],
  batchSize = DEFAULT_BATCH_SIZE,
): Promise<void> {
  const unique = [
    ...new Map(entries.map((entry) => [entry.eventorPersonId, entry])).values(),
  ];

  for (const chunk of batches(unique, batchSize)) {
    if (chunk.length === 0) continue;
    const values = chunk.map((entry) => Prisma.sql`
      (${entry.eventorPersonId}, ${entry.name}, ${entry.cardNo},
       ${entry.eventorClubId}, ${entry.birthYear}, ${entry.sex},
       ${entry.nationality}, now())
    `);
    await db.$executeRaw(Prisma.sql`
      INSERT INTO oxygen.runner_directory
        (eventor_person_id, name, card_no, eventor_club_id, birth_year,
         sex, nationality, updated_at)
      VALUES ${Prisma.join(values)}
      ON CONFLICT (eventor_person_id) DO UPDATE SET
        name = EXCLUDED.name,
        card_no = EXCLUDED.card_no,
        eventor_club_id = EXCLUDED.eventor_club_id,
        birth_year = EXCLUDED.birth_year,
        sex = EXCLUDED.sex,
        nationality = EXCLUDED.nationality,
        updated_at = EXCLUDED.updated_at
    `);
  }
}

/** Upsert club metadata in batches while leaving existing logo columns intact. */
export async function upsertClubDirectoryEntries(
  db: PrismaClient,
  entries: ClubDirectoryEntry[],
  batchSize = DEFAULT_BATCH_SIZE,
): Promise<void> {
  const unique = [
    ...new Map(entries.map((entry) => [entry.eventorId, entry])).values(),
  ];

  for (const chunk of batches(unique, batchSize)) {
    if (chunk.length === 0) continue;
    const values = chunk.map((entry) => Prisma.sql`
      (${entry.eventorId}, ${entry.name}, ${entry.shortName},
       ${entry.countryCode}, now())
    `);
    await db.$executeRaw(Prisma.sql`
      INSERT INTO oxygen.club_directory
        (eventor_id, name, short_name, country_code, updated_at)
      VALUES ${Prisma.join(values)}
      ON CONFLICT (eventor_id) DO UPDATE SET
        name = EXCLUDED.name,
        short_name = EXCLUDED.short_name,
        country_code = EXCLUDED.country_code,
        updated_at = EXCLUDED.updated_at
    `);
  }
}
