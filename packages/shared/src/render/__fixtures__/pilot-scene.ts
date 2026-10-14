/**
 * A small "map" built from the pilot symbols: the golden-image scene that
 * every backend renders. Also what the dev page `/dev/map-gl?fixture=
 * pilot-scene` shows. Objects are hand-placed so each rule has a visible
 * instance; keep it stable — the goldens are derived from it.
 */

import { makePath } from "../pass-stream.js";
import type { RenderObject } from "../symbolise.js";
import { PILOT } from "./pilot-symbols.js";

const sq = (x: number, y: number, s: number) => makePath([x, y, x + s, y, x + s, y + s, x, y + s], undefined, true);

export const pilotScene: RenderObject[] = [
  { symbolIdx: PILOT.roughOpen403, path: sq(0, 0, 60000) },
  { symbolIdx: PILOT.scatteredTrees407, path: makePath([2000, 2000, 24000, 3000, 22000, 20000, 4000, 18000], undefined, true) },
  { symbolIdx: PILOT.sandyGround213, path: sq(30000, 2000, 12000) },
  { symbolIdx: PILOT.outOfBounds709, path: sq(45000, 2000, 12000) },
  { symbolIdx: PILOT.crossed714, path: sq(45000, 18000, 12000) },
  { symbolIdx: PILOT.contour101, path: makePath([0, 30000, 10000, 40000, 25000, 28000, 40000, 42000, 60000, 32000], [0, 1, 2, 0, 0]) },
  { symbolIdx: PILOT.footpath505, path: makePath([0, 25000, 20000, 48000, 40000, 20000, 60000, 45000], [0, 1, 2, 0]) },
  { symbolIdx: PILOT.footpathOmap505, path: makePath([2000, 52000, 58000, 52000]) },
  { symbolIdx: PILOT.wideRoad502, path: makePath([0, 56000, 20000, 58000, 40000, 55000, 60000, 59000]) },
  { symbolIdx: PILOT.roadFramed503, path: makePath([30000, 20000, 42000, 26000]) },
  { symbolIdx: PILOT.powerLine516, path: makePath([5000, 22000, 28000, 22000]) },
  { symbolIdx: PILOT.wall529, path: makePath([30000, 30000, 38000, 30000, 38000, 38000], [0, 4, 0]) },
  { symbolIdx: PILOT.tree418, path: makePath([8000, 8000]) },
  { symbolIdx: PILOT.tree418, path: makePath([14000, 12000]) },
  { symbolIdx: PILOT.controlNumber704, path: makePath([26000, 36000]), text: "31" },
  { symbolIdx: PILOT.controlNumber704, path: makePath([47000, 34000]), text: "107" },
];
