/**
 * Library fixtures — the research 04 §8 fixture rows 1–9, colour order
 * and precision, drawn with the canonical library (docs/map-rendering.md
 * §6.3). Each scene is objects plus the library entries they use (by id,
 * resolved through the library's palette), with a few **hand variants**
 * where the library has no entry for a rule: the shipped libraries are
 * all OCAD-layout, have no corner glyphs, no crossed hatch and only
 * `centreInside` patterns. A variant is the named entry with the stated
 * fields replaced, nothing else.
 *
 * The stage's output for every scene is committed as a pass-stream
 * snapshot in `../streams/library/<name>.stream.json` and compared with
 * `diffPassStreams`; hand-computed assertions per row are in
 * `__tests__/library-fixtures.test.ts`; every scene is also a golden
 * image (`../golden.ts`). Coordinates: paper µm, y-up.
 */

import { COORD_FLAG, type RenderPath, makePath } from "../../pass-stream.js";
import type { AreaSymbol, ColourStack, LineSymbol, RenderSymbol, TextSymbol } from "../../symbol.js";
import { parseRenderSymbol } from "../../symbol.js";
import type { RenderObject } from "../../symbolise.js";
import { type SymbolLibraryId, materialiseLibrary } from "../../../symbol-library/index.js";

export interface LibraryScene {
  name: LibrarySceneName;
  library: SymbolLibraryId;
  colours: ColourStack;
  /** Scene-local symbol list; `objects[i].symbolIdx` indexes it. */
  symbols: RenderSymbol[];
  objects: RenderObject[];
}

const F = COORD_FLAG;
const line = (coords: number[], flags?: number[]): RenderPath => makePath(coords, flags);
const ring = (coords: number[], flags?: number[]): RenderPath => makePath(coords, flags, true);
const square = (x: number, y: number, w: number, h = w): RenderPath => ring([x, y, x + w, y, x + w, y + h, x, y + h]);
const at = (x: number, y: number): RenderPath => makePath([x, y]);

/** Builds one scene's symbol list from library entries and variants. */
class Symbols {
  readonly list: RenderSymbol[] = [];
  private readonly lib: ReturnType<typeof materialiseLibrary>;
  constructor(readonly library: SymbolLibraryId) {
    this.lib = materialiseLibrary(library);
  }
  get colours(): ColourStack {
    return this.lib.colours;
  }
  /** The entry `<library>:<code>` (e.g. `"505"`, `"508.c"`), as drawn. */
  entry(code: string): RenderSymbol {
    const id = `${this.library}:${code}`;
    const i = this.lib.library.entries.findIndex((e) => e.id === id);
    if (i < 0) throw new Error(`no library entry ${id}`);
    return this.lib.symbols[i];
  }
  /** Adds an entry (or a variant of it, `patch` applied to a copy) and returns its index. */
  add<T extends RenderSymbol = RenderSymbol>(code: string, patch?: (s: T) => T): number {
    const base = this.entry(code);
    const sym = patch ? parseRenderSymbol(patch(structuredClone(base) as T)) : base;
    this.list.push(sym);
    return this.list.length - 1;
  }
}

type DashFields = Partial<NonNullable<NonNullable<LineSymbol["main"]>["dash"]>>;
const mainDash = (fields: DashFields) => (s: LineSymbol): LineSymbol => ({ ...s, main: { ...s.main!, dash: { ...s.main!.dash!, ...fields } } });

function dashOcad(): LibraryScene {
  const s = new Symbols("ISOM2017-2");
  const fp = s.add("505");
  const less = s.add("507");
  const forced = s.add("505", mainDash({ minGaps: 2 }));
  return {
    name: "lib-dash-ocad", library: s.library, colours: s.colours, symbols: s.list,
    objects: [
      // Corner at 10 mm, dash point at 15 mm: three sections 10 / 5 / 5 mm.
      { symbolIdx: fp, path: line([0, 0, 10000, 0, 10000, 5000, 10000, 10000], [0, F.corner, F.dash, 0]) },
      // Closed loop, 18 mm round: n = 8, r = 1, a dash centred on the start point.
      { symbolIdx: fp, path: square(14000, 0, 4500) },
      // 507 at r = 1: 11.4 mm = 2·2.25 + 2.25 + 3·0.8.
      { symbolIdx: less, path: line([0, -3000, 11400, -3000]) },
      // 3 mm: solid with minGaps absent; two forced gaps with minGaps 2.
      { symbolIdx: fp, path: line([5000, -6000, 8000, -6000]) },
      { symbolIdx: forced, path: line([0, -6000, 3000, -6000]) },
    ],
  };
}

function dashOmap(): LibraryScene {
  const s = new Symbols("ISOM2017-2");
  const omap = (fields: DashFields) => mainDash({ layout: "omap", ...fields });
  const single = s.add("505", omap({}));
  const half = s.add("505", omap({ halfOuterDashes: true }));
  const grouped = s.add("505", omap({ dashesInGroup: 2, secondaryGapUm: 250 }));
  const noneShort = s.add("505", omap({ showAtLeastOne: false }));
  return {
    name: "lib-dash-omap", library: s.library, colours: s.colours, symbols: s.list,
    objects: [
      // f = 1 in every case: lengths chosen as the nominal pattern.
      { symbolIdx: single, path: line([0, 0, 13250, 0]) }, // 6 dashes, 5 breaks
      { symbolIdx: half, path: line([0, -2000, 13500, -2000]) }, // half, B, [D, B]×5, half
      { symbolIdx: grouped, path: line([0, -4000, 13250, -4000]) }, // 3 groups of 2
      // 0.8 mm: round((800 + 250) / 2250) = 0 groups — solid without showAtLeastOne, else one scaled dash.
      { symbolIdx: noneShort, path: line([0, -6000, 800, -6000]) },
      { symbolIdx: single, path: line([2000, -6000, 2800, -6000]) },
      // A dash point at 7.75 mm: one dash centred on it, half on each side.
      { symbolIdx: single, path: line([0, -8000, 7750, -8000, 15500, -8000], [0, F.dash, 0]) },
    ],
  };
}

function lineGlyphs(): LibraryScene {
  const s = new Symbols("ISOM2017-2");
  const fence = s.add("516");
  const cliff = s.add("201");
  const corners = s.add<LineSymbol>("529", (x) => ({ ...x, glyphs: [{ ...x.glyphs![0], placement: { at: "corners", ignoreEnds: true }, scaleAtCorners: true }] }));
  const power = s.add("510");
  const boundary = s.add("416");
  return {
    name: "lib-line-glyphs", library: s.library, colours: s.colours, symbols: s.list,
    objects: [
      { symbolIdx: fence, path: line([0, 0, 10000, 0]) },
      { symbolIdx: cliff, path: line([0, -2000, 3000, -2000]) },
      { symbolIdx: corners, path: line([5000, -6000, 9000, -6000, 9000, -2500], [0, F.corner, 0]) },
      { symbolIdx: power, path: line([0, -5000, 2000, -5000, 4000, -5000], [0, F.dash, 0]) },
      // Closed 12 mm loop: max(minCountClosed 5, round(12000 / 450)) = 27 dots.
      { symbolIdx: boundary, path: square(12000, -6000, 3000) },
    ],
  };
}

function patterns(): LibraryScene {
  const s = new Symbols("ISOM2017-2");
  const trees = s.add("402");
  const treesTurnable = s.add<AreaSymbol>("402", (x) => ({ ...x, patterns: [{ ...x.patterns![0], angleDeg: 0, rotate: "manual" }] }));
  const boulders = s.add("208");
  type ClipMode = NonNullable<AreaSymbol["patterns"]>[number]["clip"];
  const clip = (mode: ClipMode) => (x: AreaSymbol): AreaSymbol => ({ ...x, patterns: [{ ...x.patterns![0], angleDeg: 0, clip: mode }] });
  const modes = (["centreInside", "completelyInside", "partiallyInside", "clip"] as const).map((m) => s.add("213", clip(m)));
  // Golden-scene note (map-rendering §6.2): glyph-dense areas are kept small — every instance at the
  // same sub-pixel phase repeats the same anti-aliasing residual.
  const tri = (dx: number): RenderPath => ring([dx + 200, -17100, dx + 4300, -17300, dx + 2250, -13150]);
  return {
    name: "lib-pattern", library: s.library, colours: s.colours, symbols: s.list,
    objects: [
      // Two adjacent areas, one grid.
      { symbolIdx: trees, path: square(0, 0, 8000) },
      { symbolIdx: trees, path: square(8000, 0, 8000) },
      // Object angle 30° on a pattern that turns with the object.
      { symbolIdx: treesTurnable, path: square(0, -10000, 8000), angleDeg: 30 },
      // Shifted rows.
      { symbolIdx: boulders, path: square(10000, -6800, 4800) },
      // The same triangle in the four clip modes, 4.5 mm (10 cells) apart so each sees the same grid.
      ...modes.map((symbolIdx, k) => ({ symbolIdx, path: tri(4500 * k) })),
    ],
  };
}

function hatches(): LibraryScene {
  const s = new Symbols("ISOM2017-2");
  const oob = s.add("709");
  const vertical = s.add("407");
  const crossed = s.add<AreaSymbol>("709", (x) => ({ ...x, hatches: [x.hatches![0], { ...x.hatches![0], angleDeg: 135 }] }));
  return {
    name: "lib-hatch", library: s.library, colours: s.colours, symbols: s.list,
    objects: [
      { symbolIdx: oob, path: square(0, 0, 8000) },
      // Adjacent area of the same symbol: the family continues across the edge.
      { symbolIdx: oob, path: square(8000, 0, 4000, 8000) },
      { symbolIdx: vertical, path: square(14000, 0, 8000) },
      { symbolIdx: crossed, path: square(24000, 0, 8000) },
    ],
  };
}

function borders(): LibraryScene {
  const s = new Symbols("ISSprOM2019-2");
  const railway = s.add("509.1");
  const track = s.add("505");
  const asym = s.add<LineSymbol>("505", (x) => ({ ...x, borders: { ...x.borders!, right: { ...x.borders!.right!, widthUm: 200, shiftUm: 300 } } }));
  return {
    name: "lib-borders", library: s.library, colours: s.colours, symbols: s.list,
    objects: [
      { symbolIdx: railway, path: line([0, 0, 12000, 0]) },
      // A corner: the two borders differ in length, both keep the main line's phase.
      { symbolIdx: track, path: line([0, -3000, 6000, -3000, 6000, -9000], [0, F.corner, 0]) },
      { symbolIdx: asym, path: line([9000, -3000, 21000, -3000]) },
    ],
  };
}

function holes(): LibraryScene {
  const s = new Symbols("ISOM2017-2");
  const open = s.add("401");
  return {
    name: "lib-holes", library: s.library, colours: s.colours, symbols: s.list,
    objects: [
      {
        symbolIdx: open,
        // Outer ring counter-clockwise; hole A counter-clockwise too, hole B clockwise.
        path: ring(
          [0, 0, 12000, 0, 12000, 12000, 0, 12000, 2000, 2000, 5000, 2000, 5000, 5000, 2000, 5000, 7000, 7000, 7000, 10000, 10000, 10000, 10000, 7000],
          [0, 0, 0, 0, F.hole, 0, 0, 0, F.hole, 0, 0, 0],
        ),
      },
      // Self-touching ring: two triangles meeting at (17000, 3000).
      { symbolIdx: open, path: ring([14000, 0, 20000, 0, 17000, 3000, 20000, 6000, 14000, 6000, 17000, 3000]) },
    ],
  };
}

function text(): LibraryScene {
  const s = new Symbols("ISOM2017-2");
  const control = s.add("704");
  const height = s.add("603.b");
  const align = (a: TextSymbol["align"]) => (x: TextSymbol): TextSymbol => ({ ...x, align: a });
  const centre = s.add("603.b", align("centre"));
  const right = s.add("603.b", align("right"));
  return {
    name: "lib-text", library: s.library, colours: s.colours, symbols: s.list,
    objects: [
      { symbolIdx: control, path: at(0, 0), text: "31" },
      // Left / centre / right about the same x; "AV" is a kerning pair.
      { symbolIdx: height, path: at(4000, -3000), text: "AV 12" },
      { symbolIdx: centre, path: at(4000, -5000), text: "AV 12" },
      { symbolIdx: right, path: at(4000, -7000), text: "AV 12" },
      // Two lines, baselines lineSpacing × em apart.
      { symbolIdx: height, path: at(9000, -3000), text: "Norra\nKärr" },
    ],
  };
}

function halos(): LibraryScene {
  const s = new Symbols("ISSprOM2019-2");
  const building = s.add("521");
  const control = s.add("704.b");
  const forest = s.add("406");
  // A framed ride: ISSprOM 508 with a continuous white band (the library has no framed line).
  const framed = s.add<LineSymbol>("508", (x) => ({ ...x, main: { ...x.main!, halo: { colour: 12, widthUm: 200, continuous: true } } }));
  return {
    name: "lib-halos", library: s.library, colours: s.colours, symbols: s.list,
    objects: [
      { symbolIdx: building, path: square(0, 0, 8000, 6000) },
      { symbolIdx: control, path: at(1500, 1000), text: "31" },
      { symbolIdx: forest, path: square(10000, 0, 10000, 6000) },
      { symbolIdx: framed, path: line([9000, 3000, 21000, 3000]) },
    ],
  };
}

function colourOrder(): LibraryScene {
  const s = new Symbols("ISSprOM2019-2");
  const ids = {
    open: s.add("401"), slow: s.add("406"), water: s.add("301"), contour: s.add("101"), track: s.add("505"),
    route: s.add("707"), start: s.add("701"), oob: s.add("709"), number: s.add("704"), building: s.add("521"),
  };
  // Pushed in reverse stack order on purpose: the sort decides.
  return {
    name: "lib-colour-order", library: s.library, colours: s.colours, symbols: s.list,
    objects: [
      { symbolIdx: ids.number, path: at(9000, 1000), text: "7" },
      { symbolIdx: ids.oob, path: square(9000, 0, 6000) },
      { symbolIdx: ids.route, path: line([0, 3000, 18000, 3000]) },
      { symbolIdx: ids.start, path: at(3000, 3000) },
      { symbolIdx: ids.contour, path: line([0, 5000, 18000, 1000]) },
      // Diagonal on purpose: a thin axis-aligned edge at a fractional pixel offset fails a whole column (§6.2).
      { symbolIdx: ids.track, path: line([1000, 0, 4000, 9000]) },
      { symbolIdx: ids.building, path: square(13000, 4000, 4000, 4000) },
      { symbolIdx: ids.water, path: square(5000, 4000, 4000, 4000) },
      { symbolIdx: ids.slow, path: square(0, 0, 12000, 9000) },
      { symbolIdx: ids.open, path: square(6000, -1000, 12000, 10000) },
    ],
  };
}

/** Offset of the precision scene: the far corner of a 1.2 m document (04 §8). */
export const PRECISION_OFFSET_UM = 1_200_000;

function precision(): LibraryScene {
  // Rows 1 and 3, verbatim, moved to the far corner.
  const base = [dashOcad(), lineGlyphs()];
  const s = new Symbols("ISOM2017-2");
  const objects: RenderObject[] = [];
  base.forEach((scene, k) => {
    const offset = s.list.length;
    s.list.push(...scene.symbols);
    for (const o of scene.objects) {
      const coords = Int32Array.from(o.path.coords, (v, i) => v + PRECISION_OFFSET_UM + (i % 2 === 1 ? -k * 12000 : 0));
      objects.push({ ...o, symbolIdx: o.symbolIdx + offset, path: { ...o.path, coords } });
    }
  });
  return { name: "lib-precision", library: s.library, colours: s.colours, symbols: s.list, objects };
}

export const librarySceneNames = [
  "lib-dash-ocad",
  "lib-dash-omap",
  "lib-line-glyphs",
  "lib-pattern",
  "lib-hatch",
  "lib-borders",
  "lib-holes",
  "lib-text",
  "lib-halos",
  "lib-colour-order",
  "lib-precision",
] as const;
export type LibrarySceneName = (typeof librarySceneNames)[number];

const builders: Record<LibrarySceneName, () => LibraryScene> = {
  "lib-dash-ocad": dashOcad,
  "lib-dash-omap": dashOmap,
  "lib-line-glyphs": lineGlyphs,
  "lib-pattern": patterns,
  "lib-hatch": hatches,
  "lib-borders": borders,
  "lib-holes": holes,
  "lib-text": text,
  "lib-halos": halos,
  "lib-colour-order": colourOrder,
  "lib-precision": precision,
};

export function libraryScene(name: LibrarySceneName): LibraryScene {
  return builders[name]();
}

export function isLibrarySceneName(name: string): name is LibrarySceneName {
  return (librarySceneNames as readonly string[]).includes(name);
}
