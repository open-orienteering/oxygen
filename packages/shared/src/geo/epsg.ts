/**
 * proj4 definitions for the projected CRSs Oxygen's maps use
 * (docs/map-import.md §3.8). proj4 knows only EPSG:4326 and EPSG:3857 by
 * itself. Registration is lazy so importing `@oxygen/shared` has no side
 * effect and bundles that never project can drop proj4.
 */

import proj4 from "proj4";

const DEFS: [number, string][] = [
  // Sweden: SWEREF99 TM and the twelve local zones.
  [3006, "+proj=utm +zone=33 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs"],
  ...([
    [3007, 12], [3008, 13.5], [3009, 15], [3010, 16.5], [3011, 18], [3012, 14.25],
    [3013, 15.75], [3014, 17.25], [3015, 18.75], [3016, 20.25], [3017, 21.75], [3018, 23.25],
  ] as const).map(([code, lon0]): [number, string] => [
    code,
    `+proj=tmerc +lat_0=0 +lon_0=${lon0} +k=1 +x_0=150000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`,
  ]),
  // Finland.
  [3067, "+proj=utm +zone=35 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs"],
  // ETRS89 / UTM 32–35 (Norway, Denmark).
  ...[32, 33, 34, 35].map((zone): [number, string] => [25800 + zone, `+proj=utm +zone=${zone} +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`]),
  // WGS 84 / UTM 32N–36N.
  ...[32, 33, 34, 35, 36].map((zone): [number, string] => [32600 + zone, `+proj=utm +zone=${zone} +datum=WGS84 +units=m +no_defs`]),
];

/** EPSG codes with a registered definition. */
export const SUPPORTED_EPSG_CODES: readonly number[] = DEFS.map(([code]) => code);

let registered = false;

/** proj4 with Oxygen's definitions registered. */
export function proj(): typeof proj4 {
  if (!registered) {
    for (const [code, def] of DEFS) proj4.defs(`EPSG:${code}`, def);
    registered = true;
  }
  return proj4;
}

/** `"EPSG:<code>"` when proj4 can project it, else null. */
export function epsgName(code: number): string | null {
  const p = proj();
  const name = `EPSG:${code}`;
  return p.defs(name) ? name : null;
}
