/**
 * Colour classification (03 §6.3 step 1): IOF colour classes from the ink
 * values and the Swedish/English names cartographers actually use. The
 * fixtures below are the naming conventions seen across OCAD template
 * sets, not any particular club's map.
 */

import { describe, expect, it } from "vitest";
import { paletteFor } from "../../symbol-library/palette.js";
import {
  classifyCmyk, classifyColour, detectPaletteEdition, formatClass, hueFromName, paletteClass, paletteEntryFor, percentFromName, sameClass,
} from "../colour-class.js";

const cmyk = (c: number, m: number, y: number, k: number): [number, number, number, number] => [c / 100, m / 100, y / 100, k / 100];

describe("classifyCmyk", () => {
  it("recognises the IOF 2024 and 2022 inks", () => {
    expect(classifyCmyk(cmyk(0, 0, 0, 100))).toEqual({ hue: "black", percent: 100 });
    expect(classifyCmyk(cmyk(0, 0, 0, 50))).toEqual({ hue: "black", percent: 50 });
    expect(classifyCmyk(cmyk(0, 0, 0, 0))).toEqual({ hue: "white", percent: 100 });
    expect(classifyCmyk(cmyk(25, 75, 100, 0))).toEqual({ hue: "brown", percent: 100 }); // 2024 brown
    expect(classifyCmyk(cmyk(0, 56, 100, 18))).toEqual({ hue: "brown", percent: 100 }); // 2022 brown
    expect(classifyCmyk(cmyk(10, 35, 50, 0))).toEqual({ hue: "brown", percent: 50 });
    expect(classifyCmyk(cmyk(100, 0, 0, 0))).toEqual({ hue: "blue", percent: 100 });
    expect(classifyCmyk(cmyk(50, 0, 0, 0))).toEqual({ hue: "blue", percent: 50 });
    expect(classifyCmyk(cmyk(80, 0, 100, 0))).toEqual({ hue: "green", percent: 100 });
    expect(classifyCmyk(cmyk(24, 0, 30, 0))).toEqual({ hue: "green", percent: 30 });
    expect(classifyCmyk(cmyk(0, 27, 79, 0))).toEqual({ hue: "yellow", percent: 100 });
    expect(classifyCmyk(cmyk(0, 14, 40, 0))).toEqual({ hue: "yellow", percent: 51 }); // 40/79; sameClass tolerates ±20
    expect(classifyCmyk(cmyk(38, 27, 100, 0))).toEqual({ hue: "olive", percent: 100 });
    expect(classifyCmyk(cmyk(35, 85, 0, 0))).toEqual({ hue: "purple", percent: 100 });
    expect(classifyCmyk(cmyk(18, 43, 0, 0))).toEqual({ hue: "purple", percent: 51 });
    expect(classifyCmyk(cmyk(100, 100, 100, 100))).toEqual({ hue: "registration", percent: 100 });
  });

  it("classifies the dark greens of both editions (100/0/80/30 and 76/0/91/50)", () => {
    expect(classifyCmyk(cmyk(100, 0, 80, 30))).toEqual({ hue: "darkgreen", percent: 100 });
    expect(classifyCmyk(cmyk(76, 0, 91, 50))).toEqual({ hue: "darkgreen", percent: 100 });
  });

  it("keeps a dark brown (0/75/100/30) brown, not red", () => {
    expect(classifyCmyk(cmyk(0, 75, 100, 30))).toEqual({ hue: "brown", percent: 100 });
    expect(classifyCmyk(cmyk(0, 100, 100, 0))).toEqual({ hue: "red", percent: 100 });
  });

  it("returns null for inks outside the IOF vocabulary", () => {
    expect(classifyCmyk(cmyk(90, 32, 0, 0))).toBeNull(); // a metro-line blue
    expect(classifyCmyk(cmyk(0, 100, 0, 0))).toBeNull(); // process magenta
  });

  it("classifies every palette entry of both editions", () => {
    for (const edition of ["iof2022", "iof2024"] as const) {
      for (const spec of ["ISOM2017-2", "ISSprOM2019-2"] as const) {
        for (const p of paletteFor(edition, spec)) {
          expect(paletteClass(p.id, edition), `${edition} ${p.id}`).not.toBeNull();
        }
      }
    }
  });
});

describe("names", () => {
  it("reads hues and screens from Swedish and English names, tokenised past å/ä/ö", () => {
    expect(hueFromName("Grön 60% - Ytobjekt")).toBe("green");
    expect(percentFromName("Grön 60% - Ytobjekt")).toBe(60);
    expect(hueFromName("Blå")).toBe("blue");
    expect(hueFromName("Undre Violett för banpåtryck")).toBe("purple");
    expect(hueFromName("Brown 50% - Street Infill")).toBe("brown");
    expect(hueFromName("Mörkgrön för opasserbar vegetation")).toBe("darkgreen");
    expect(hueFromName("Dark green - hedge")).toBe("darkgreen");
    expect(hueFromName("Gul + Grön 50%")).toBe("olive");
    expect(hueFromName("Grön 100% + 50% Svart - Linjeobjekt")).toBe("darkgreen");
    expect(hueFromName("Vit för järnväg")).toBe("white");
    expect(hueFromName("T-bana")).toBeNull();
    expect(percentFromName("Grön 100% + 50% Svart")).toBeNull(); // two screens: ambiguous
  });
});

describe("classifyColour", () => {
  it("lets the name refine the screen when the ink agrees on the hue", () => {
    expect(classifyColour({ name: "Grön 60% - Ytobjekt", cmyk: cmyk(46, 0, 55, 0) })).toEqual({ class: { hue: "green", percent: 60 } });
  });

  it("lets the ink win when the name disagrees, and says so", () => {
    expect(classifyColour({ name: "Grön för undervegetation (över gul)", cmyk: cmyk(80, 0, 100, 0) })).toEqual({ class: { hue: "green", percent: 100 }, nameMismatch: true });
  });

  it("ignores a screen in the name for mixed inks: 'Gul + Grön 50%' is olive 100 %", () => {
    expect(classifyColour({ name: "Gul + Grön 50%", cmyk: cmyk(38, 27, 100, 0) })).toEqual({ class: { hue: "olive", percent: 100 } });
  });

  it("falls back to the name when the ink is unclassifiable", () => {
    expect(classifyColour({ name: "SOFT-blå", cmyk: cmyk(100, 50, 0, 55) }).class).toEqual({ hue: "blue", percent: 100 });
  });

  it("compares classes within the 20-point screen tolerance", () => {
    expect(sameClass({ hue: "green", percent: 65 }, { hue: "green", percent: 60 })).toBe(true);
    expect(sameClass({ hue: "green", percent: 30 }, { hue: "green", percent: 60 })).toBe(false);
    expect(sameClass({ hue: "white", percent: 100 }, { hue: "white", percent: 100 })).toBe(true);
    expect(sameClass(null, { hue: "black", percent: 100 })).toBe(false);
    expect(formatClass({ hue: "brown", percent: 50 })).toBe("brown 50 %");
    expect(formatClass(null)).toBe("unclassified");
  });
});

describe("paletteEntryFor", () => {
  const pick = (name: string, ink: [number, number, number, number], spec: "ISOM2017-2" | "ISSprOM2019-2" = "ISOM2017-2") => {
    const cls = classifyColour({ name, cmyk: ink }).class!;
    return paletteEntryFor({ name, cmyk: ink }, cls, spec, "iof2024")?.entry.id;
  };

  it("uses name qualifiers to pick among same-class palette entries", () => {
    expect(pick("Brun 50% - Vägfyllning", cmyk(10, 35, 50, 0))).toBe("brown50-road");
    expect(pick("Brun 50% för belagd yta", cmyk(10, 35, 50, 0))).toBe("brown50-paved");
    expect(pick("Brun 100% - Linjeobjekt", cmyk(25, 75, 100, 0))).toBe("brown100-line");
    expect(pick("Brun 100% - Punktobjekt", cmyk(25, 75, 100, 0))).toBe("brown100-point");
    expect(pick("Vit för järnväg", cmyk(0, 0, 0, 0))).toBe("white-railway");
    expect(pick("Vit över gul", cmyk(0, 0, 0, 0))).toBe("white-over-yellow");
    expect(pick("Svart för odlad mark och sandområde", cmyk(0, 0, 0, 100))).toBe("black-cultivated");
    expect(pick("Svart 50% - Ytobjekt", cmyk(0, 0, 0, 50))).toBe("black50-building");
    expect(pick("Grön 100% - Punktobjekt", cmyk(80, 0, 100, 0))).toBe("green100-point");
    expect(pick("Undre Violett för banpåtryck", cmyk(35, 85, 0, 0))).toBe("purple-lower");
    expect(pick("Övre Violett för banpåtryck", cmyk(35, 85, 0, 0))).toBe("purple-upper");
    expect(pick("Mörkgrön för opasserbar vegetation", cmyk(100, 0, 80, 30), "ISSprOM2019-2")).toBe("darkgreen-area");
    expect(pick("Dark green - hedge", cmyk(100, 0, 80, 30), "ISSprOM2019-2")).toBe("darkgreen-line");
  });

  it("falls back to the default entry of a class when the name has no qualifier", () => {
    expect(pick("Brun 50%", cmyk(10, 35, 50, 0))).toBe("brown50-road");
    expect(pick("Svart", cmyk(0, 0, 0, 100))).toBe("black100");
  });
});

describe("detectPaletteEdition", () => {
  it("prefers 2022 when browns/greens sit on the 2022 values and 2024 otherwise", () => {
    expect(detectPaletteEdition([{ name: "Brun", cmyk: cmyk(0, 56, 100, 18) }, { name: "Grön", cmyk: cmyk(76, 0, 91, 0) }])).toBe("iof2022");
    expect(detectPaletteEdition([{ name: "Brun", cmyk: cmyk(25, 75, 100, 0) }, { name: "Grön", cmyk: cmyk(80, 0, 100, 0) }])).toBe("iof2024");
    expect(detectPaletteEdition([{ name: "Svart", cmyk: cmyk(0, 0, 0, 100) }])).toBe("iof2024");
  });
});
