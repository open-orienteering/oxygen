// Which files are orienteering map sources (OCAD, OpenOrienteering Mapper),
// and which of them may be in git (scripts/check-map-files.mjs).
//
// A club's map is published only as raster images (screenshots), never as
// its vector source. Only the maps listed here are public: the test maps the
// suite draws, the CC0 Puit de Laven demo map (docs/ops/demo.md), and the
// o-kartan.se demo map, bought with a licence for any use. Each is pinned by
// its SHA-256, so a club map copied over one of them is caught too; a
// deliberate change to one of these files updates its hash here.

export const PUBLIC_MAPS = new Map([
  ["e2e/colour-layers.ocd", "0c8282671f5e6504c45421a69d5e46e792a8d2b8fec9f290c8e47e90db5f0012"],
  ["e2e/test-data.ocd", "3bca5018d4fecbe923a8b8540331af254134b3eb7c88e299749da31a8f7f7a6d"],
  ["e2e/test.ocd", "6fe6c15cede447f7b52efd5a7a74fe7832b73693c856ed1067647ce3df9830d0"],
  ["e2e/test.xmap", "fd9bc816edc0dd1346d2df9b01c31dc05c012d08e3e762eee8ce6a3f2980d8c6"],
  ["fixtures/showcase/puit-de-laven-demo.omap", "dfd0b69b1362a068bde8ac4b1d1fef58717db43cf33d8036339c53908c12c3dc"],
  ["fixtures/showcase/puit-de-laven.omap", "57ae1a9db2457db9fcdb2a9f0c2999ac694231585c52ee97693a505a8db69daf"],
  // The o-kartan.se demo map, licensed for any use including publication (PR #252).
  ["fixtures/okartan/okartan-original.ocd", "1db7dde39fb8d32dee5fb1633ce2ecc99c91213113f9cc84c519ec6ea7896672"],
  ["fixtures/okartan/okartan-demo.ocd", "a7fedfc4722e20d0b9eeb8baee6060102a5ff0a713e6327656408cb43e4f56fd"],
]);

/** Map extensions, also inside a backup or archive name (`club.ocd.bak`, `club.omap.zip`). */
const MAP_EXT = /\.(ocd|ocad|omap|xmap)(\.(bak|zip|gz|7z|tgz|tar|bz2|xz))?$/i;
/** Source code and docs may quote a Mapper header in a string; an OCAD file's binary mark they never start with. */
const CODE_OR_DOC = /\.(ts|tsx|js|mjs|cjs|md)$/i;
/** Mapper's root element, whatever the attribute order. */
const MAPPER_XML = /<map\b[^>]*\bxmlns="http:\/\/openorienteering\.org\/apps\/mapper\/xml/;

/** How many leading bytes to look at. */
export const HEAD_BYTES = 4096;

/**
 * Whether a file is a map source, from its path and its first bytes: the
 * extension, OCAD's 0x0CAD mark (any file), or Mapper's XML root element
 * (any file but code and docs).
 */
export function isMapSource(path, head) {
  if (MAP_EXT.test(path)) return true;
  if (head.length >= 2 && head[0] === 0xad && head[1] === 0x0c) return true;
  if (CODE_OR_DOC.test(path)) return false;
  return MAPPER_XML.test(head.subarray(0, HEAD_BYTES).toString("latin1"));
}

/** Whether a map source may be committed: on the public list, with the listed content. */
export function isPublicMap(path, sha256) {
  return PUBLIC_MAPS.get(path) === sha256;
}
