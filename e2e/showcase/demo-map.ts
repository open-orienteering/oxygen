/**
 * Does an event carry the committed demo map (docs/ops/demo.md, "The map")?
 * Club maps of the same forest exist and must not reach the docs, so the
 * check is by content: the source hash in the pinned map document's header
 * must be the SHA-256 of fixtures/okartan/okartan-demo.ocd. Both screenshot
 * scripts (e2e/showcase/shot.ts and docs/screenshots/capture.ts) refuse to
 * write a picture of the map into docs/screenshots without it.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

/** The demo map, relative to the repository root. */
export const DEMO_MAP_FILE = path.join("fixtures", "okartan", "okartan-demo.ocd");

/** A map document's preamble: magic, format version, header length (packages/shared/src/map-document/codec.ts). */
const DOCUMENT_PREAMBLE_BYTES = 12;

export function demoMapSha256(root: string): string {
  return createHash("sha256").update(readFileSync(path.join(root, DEMO_MAP_FILE))).digest("hex");
}

/**
 * The source hash named by the document `event` pins, read over HTTP from
 * the Oxygen at `baseUrl` (the API, or the web app that proxies it);
 * undefined when the event has no pinned map or the answer is not a map
 * document. The event header grants document access when auth is on.
 */
export async function eventMapSourceHash(base: string, event: string): Promise<string | undefined> {
  const baseUrl = base.replace(/\/+$/, "");
  const headers = { "x-competition-id": event };
  const meta = await fetch(`${baseUrl}/trpc/course.mapMetadata`, { headers });
  if (!meta.ok) return undefined;
  const documentHash = ((await meta.json()) as { result?: { data?: { documentHash?: string } | null } })?.result?.data?.documentHash;
  if (!documentHash || !/^[0-9a-f]{64}$/.test(documentHash)) return undefined;
  const url = `${baseUrl}/api/map-documents/${documentHash}`;
  const get = async (from: number, to: number) => {
    const res = await fetch(url, { headers: { ...headers, range: `bytes=${from}-${to}` } });
    return res.ok ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0);
  };
  const head = await get(0, DOCUMENT_PREAMBLE_BYTES - 1);
  if (head.byteLength < DOCUMENT_PREAMBLE_BYTES || head.subarray(0, 4).toString("latin1") !== "OXVM") return undefined;
  const length = head.readUInt32LE(8);
  const json = (await get(DOCUMENT_PREAMBLE_BYTES, DOCUMENT_PREAMBLE_BYTES + length - 1)).subarray(0, length);
  try {
    return (JSON.parse(json.toString("utf8")) as { source?: { hash?: string } }).source?.hash;
  } catch {
    return undefined;
  }
}

/** Throws unless `event` at `baseUrl` carries the committed demo map; `root` is the repository's root. */
export async function assertDemoMap(baseUrl: string, event: string, root: string): Promise<void> {
  const actual = await eventMapSourceHash(baseUrl, event);
  if (actual !== demoMapSha256(root)) {
    throw new Error(
      `The ${event} event at ${baseUrl} does not carry the demo map ${DEMO_MAP_FILE} (its document names source ${actual ?? "none"}). ` +
        "Pictures of a map go into the docs only from the demo map: reload it with `pnpm showcase:load`, " +
        "or take club-map shots as a private showcase run (SHOWCASE_PRIVATE=1, docs/screenshots/README.md).",
    );
  }
}
