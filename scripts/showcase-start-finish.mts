#!/usr/bin/env tsx
/**
 * Give the Demo Competition's starts and finishes codes and point every
 * course at its own start and finish (docs/ops/demo.md, "The showcase
 * course"):
 *
 *   DATABASE_URL=… pnpm exec tsx scripts/showcase-start-finish.mts [--event demo_competition]
 *
 * - A live start or finish without a code takes the lowest free code in
 *   3–10, then 11–30 (the rule `control.create` follows, F32).
 * - The course named `Showcase` starts and finishes at the start and
 *   finish that are not the race's (their seq is not in showcase.sql);
 *   every other course at the race's. Each change goes through the API
 *   (`control.update`, `course.setStructure`), so lengths, variants and
 *   the journal follow as in the editor.
 *
 * Run it on a loaded demo event before `showcase-course.mjs export`.
 */

import { readFileSync } from "node:fs";
import { createCallerFactory, type Context } from "../packages/api/src/trpc.js";
import { appRouter } from "../packages/api/src/routers/index.js";
import { prisma, resolveEvent } from "../packages/api/src/db.js";
import { firstCode, lowestFreeStartCode } from "../packages/api/src/control-id.js";
import { SHOWCASE_COURSE_NAME, raceControlSeqs, withEnds } from "./lib/showcase-course.mjs";
import { FIXTURE_PATH } from "./lib/showcase-sql.mjs";

const args = process.argv.slice(2);
const i = args.indexOf("--event");
const nameId = i >= 0 ? args[i + 1] : "demo_competition";
if (!process.env.DATABASE_URL) throw new Error("showcase-start-finish reads DATABASE_URL");

const event = await resolveEvent(nameId);
if (!event) throw new Error(`No event ${nameId}`);
const ctx: Context = { event, user: null, identityEmail: null, authEnabled: false, authMode: "off", kioskKey: null };
const caller = createCallerFactory(appRouter)(ctx);
const db = prisma();
const raceSeqs = raceControlSeqs(readFileSync(FIXTURE_PATH, "utf8"));

type Site = { id: string; seq: number; codes: string; name: string; status: string };
const liveSites = async (): Promise<Site[]> =>
  db.control.findMany({
    where: { eventId: event.id, removed: false },
    select: { id: true, seq: true, codes: true, name: true, status: true },
    orderBy: { seq: "asc" },
  });
const publicId = (s: Site) => firstCode(s.codes) || s.seq;

// 1. Codes.
for (const site of await liveSites()) {
  if (site.status !== "start" && site.status !== "finish") continue;
  if (firstCode(site.codes) !== 0) continue;
  const held = new Set<number>();
  for (const r of await liveSites()) {
    if (firstCode(r.codes) === 0) held.add(r.seq);
    for (const p of r.codes.split(";")) {
      const n = parseInt(p.trim(), 10);
      if (Number.isFinite(n) && n > 0) held.add(n);
    }
  }
  held.delete(site.seq);
  const code = lowestFreeStartCode(held);
  if (code === null) throw new Error("codes 3–30 are all in use");
  await caller.control.update({ id: site.seq, codes: String(code) });
  console.log(`${site.name} (seq ${site.seq}) takes code ${code}`);
}

// 2. Each course's start and finish.
const sites = await liveSites();
const one = (status: string, race: boolean): Site => {
  const found = sites.filter((s) => s.status === status && raceSeqs.has(s.seq) === race);
  if (found.length !== 1) {
    throw new Error(`Expected one ${race ? "race" : "showcase"} ${status}, found ${found.map((s) => `${s.name} (seq ${s.seq})`).join(", ") || "none"}`);
  }
  return found[0];
};
const ends = {
  race: { start: one("start", true), finish: one("finish", true) },
  showcase: { start: one("start", false), finish: one("finish", false) },
};
if (ends.race.start.name === ends.showcase.start.name) {
  throw new Error(`The race's start and the showcase start share the name "${ends.race.start.name}": courses name their start`);
}
const startIds = new Set(sites.filter((s) => s.status === "start").map(publicId));
const finishIds = new Set(sites.filter((s) => s.status === "finish").map(publicId));

const roots = await db.course.findMany({
  where: { eventId: event.id, removed: false, parentCourseId: null },
  select: { seq: true, name: true },
  orderBy: { seq: "asc" },
});
for (const c of roots) {
  const pair = c.name === SHOWCASE_COURSE_NAME ? ends.showcase : ends.race;
  const detail = await caller.course.detail({ id: c.seq });
  const next = withEnds(detail.structure, {
    start: publicId(pair.start),
    finish: publicId(pair.finish),
    startIds,
    finishIds,
  });
  if (!next) {
    console.log(`${c.name}: ${pair.start.name} → ${pair.finish.name} (unchanged)`);
    continue;
  }
  await caller.course.setStructure({ courseId: c.seq, structure: next });
  console.log(`${c.name}: now ${pair.start.name} → ${pair.finish.name}`);
}
await db.$disconnect();
