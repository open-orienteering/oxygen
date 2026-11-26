/**
 * Every writer of the event row is accounted for during a lease (review
 * MC-08; docs/system/offline-architecture.md "The event row during a
 * lease"). A source scan: each `event.update(` in a router sits in a
 * procedure that is either cloud-owned (forwarded, its columns refreshed on
 * the box) or venue-owned (a race procedure, or a lease check in the
 * handler, whose columns the refresh leaves alone and the box pushes back).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isCloudOwnedMutation } from "@oxygen/shared";
import { Prisma } from "../generated/prisma/client.js";
import {
  EVENT_IDENTITY_FIELDS,
  EVENT_ROW_WRITERS,
  VENUE_OWNED_EVENT_FIELDS,
  VENUE_PUSHED_EVENT_FIELDS,
  pickVenuePushedFields,
} from "../sync/eventOwnership.js";

const SRC = join(__dirname, "..");
const ROUTERS = join(SRC, "routers");
/** Router file → its key in `appRouter`. */
const ROUTER_KEY: Record<string, string> = {
  "event.ts": "event",
  "control.ts": "control",
  "course.ts": "course",
  "eventor.ts": "eventor",
  "liveresults.ts": "liveresults",
};
/**
 * Event-row writes outside the routers (and outside `sync/`, which is the
 * lease machinery itself), with why they are safe during a lease.
 */
const NON_ROUTER_WRITERS: Record<string, string> = {
  "liveresults.ts": "liveresultsTavid, reached only from the forwarded liveresults.* router",
};
const WRITE = /\.event\.(?:update|updateMany|upsert)\(/;

interface Writer {
  path: string;
  procedureLine: string;
  body: string;
}

/** Every .ts file under `dir`, relative to SRC. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (["__tests__", "generated", "sync", "routers"].includes(e.name)) continue;
      out.push(...sources(full));
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
      out.push(full.slice(SRC.length + 1));
    }
  }
  return out;
}

/** The procedures of the router files that write the event row, each with its whole body. */
function eventRowWriters(): Writer[] {
  const out: Writer[] = [];
  for (const file of readdirSync(ROUTERS).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(ROUTERS, file), "utf8");
    if (!WRITE.test(src)) continue;
    const key = ROUTER_KEY[file];
    expect(key, `${file} writes the event row: add it to ROUTER_KEY and EVENT_ROW_WRITERS`).toBeDefined();
    const lines = src.split("\n");
    const headers: Array<{ name: string; line: string; start: number }> = [];
    lines.forEach((line, i) => {
      const m = /^ {2}(\w+): (\w+)/.exec(line);
      if (m) headers.push({ name: m[1], line, start: i });
    });
    const writing = new Set<number>();
    lines.forEach((line, i) => {
      if (!WRITE.test(line)) return;
      const h = headers.findLastIndex((x) => x.start <= i);
      expect(h, `routers/${file}:${i + 1} writes the event row outside a procedure`).toBeGreaterThanOrEqual(0);
      writing.add(h);
    });
    for (const h of writing) {
      const end = headers[h + 1]?.start ?? lines.length;
      out.push({
        path: `${key}.${headers[h].name}`,
        procedureLine: headers[h].line,
        body: lines.slice(headers[h].start, end).join("\n"),
      });
    }
  }
  return out;
}

describe("event row ownership during a lease (MC-08)", () => {
  const writers = eventRowWriters();

  it("outside the routers, only the listed files write the event row", () => {
    const hits = sources(SRC).filter((f) => WRITE.test(readFileSync(join(SRC, f), "utf8")));
    expect(hits.sort()).toEqual(Object.keys(NON_ROUTER_WRITERS).sort());
  });

  it("finds the known writers", () => {
    const paths = writers.map((w) => w.path);
    for (const p of Object.keys(EVENT_ROW_WRITERS)) expect(paths).toContain(p);
  });

  it("every event-row writer is either cloud-owned or a venue-owned race write", () => {
    for (const w of writers) {
      if (isCloudOwnedMutation(w.path)) {
        expect(EVENT_ROW_WRITERS[w.path] ?? "cloud", w.path).not.toBe("venue");
        continue;
      }
      if (w.path === "event.delete") continue; // lifecycle, forwarded
      expect(EVENT_ROW_WRITERS[w.path], `${w.path} writes the event row: decide its owner in eventOwnership.ts`).toBe("venue");
      const raceGuarded = /RaceProcedure\b/.test(w.procedureLine) || /mayWriteEventData\(/.test(w.body);
      expect(raceGuarded, `${w.path} is venue-owned, so the cloud must refuse it during a lease`).toBe(true);
    }
  });

  it("the cloud-owned writers are forwarded", () => {
    for (const [path, owner] of Object.entries(EVENT_ROW_WRITERS)) {
      if (owner === "cloud") expect(isCloudOwnedMutation(path), path).toBe(true);
      else expect(isCloudOwnedMutation(path), path).toBe(false);
    }
  });

  it("every venue-owned field is a column of the event row, and none is an identity field", () => {
    const columns = new Set(Object.values(Prisma.EventScalarFieldEnum));
    for (const f of VENUE_OWNED_EVENT_FIELDS) {
      expect(columns.has(f as never), f).toBe(true);
      expect(EVENT_IDENTITY_FIELDS.has(f)).toBe(false);
    }
    for (const f of EVENT_IDENTITY_FIELDS) expect(columns.has(f as never), f).toBe(true);
  });

  it("the columns a venue writer sets are venue-owned", () => {
    const columns = Object.values(Prisma.EventScalarFieldEnum) as string[];
    for (const w of writers.filter((x) => EVENT_ROW_WRITERS[x.path] === "venue")) {
      // What the procedure writes: each write call's argument, balanced to
      // its closing paren, plus `data.<col> = …` assignments of a data
      // object built up before the call.
      const written: string[] = [];
      const re = new RegExp(WRITE.source, "g");
      for (let m = re.exec(w.body); m; m = re.exec(w.body)) {
        let depth = 1;
        let i = m.index + m[0].length;
        for (; i < w.body.length && depth > 0; i++) {
          if (w.body[i] === "(") depth++;
          else if (w.body[i] === ")") depth--;
        }
        written.push(w.body.slice(m.index, i));
      }
      written.push(...(w.body.match(/\bdata\.\w+\s*=/g) ?? []));
      const text = written.join("\n");
      expect(text.length, w.path).toBeGreaterThan(0);
      for (const col of columns) {
        if (EVENT_IDENTITY_FIELDS.has(col)) continue;
        if (new RegExp(`\\b(?:data\\.${col}\\s*=|${col}\\s*[:,}])`).test(text)) {
          expect(VENUE_OWNED_EVENT_FIELDS.has(col), `${w.path} writes ${col}`).toBe(true);
        }
      }
    }
  });

  it("pickVenuePushedFields keeps only the pushed columns", () => {
    expect(
      pickVenuePushedFields({ cardFeeCents: 1, kioskKey: "k", zeroTime: 5, name: "x", id: 1n, timeZone: undefined }),
    ).toEqual({ cardFeeCents: 1, kioskKey: "k" });
    expect(VENUE_PUSHED_EVENT_FIELDS.has("zeroTime")).toBe(false);
  });
});
