import { describe, expect, it } from "vitest";
import { GRAPHIC_UPLOAD_MAX_BYTES, graphicGroups, graphicSizeLabel, graphicThumbUrl, uploadErrorKey, uploadProblem } from "../graphics-picker";

const g = (id: number, club: boolean) => ({ id, name: `g${id}`, mime: "image/png", sizeBytes: 1, widthPx: 4, heightPx: 2, club, version: "1-0" });

describe("graphics picker helpers (J2)", () => {
  it("groups event graphics before club graphics, keeping order", () => {
    expect(graphicGroups([g(1, true), g(2, false), g(3, true), g(4, false)])).toEqual({ event: [g(2, false), g(4, false)], club: [g(1, true), g(3, true)] });
  });

  it("labels the pixel size, or nothing without one", () => {
    expect(graphicSizeLabel({ widthPx: 4096, heightPx: 2048 })).toBe("4096 × 2048 px");
    expect(graphicSizeLabel({ widthPx: null, heightPx: null })).toBeNull();
  });

  it("builds the thumbnail URL with the event encoded, keyed by the content version", () => {
    expect(graphicThumbUrl("lusse 2026", 7, "120-1700000000000")).toBe("/api/maps/lusse%202026/graphics/7/thumb.png?v=120-1700000000000");
  });

  it("maps the server's refusals to message keys", () => {
    expect(uploadErrorKey("The PNG has more than 64 megapixels")).toBe("graphicsTooManyPixels");
    expect(uploadErrorKey("The PNG is over 8 MB even at 2048 px; save it smaller or as SVG")).toBe("graphicsTooLargeResampled");
    expect(uploadErrorKey("An SVG graphic is limited to 8 MB")).toBe("graphicsSvgTooLarge");
    expect(uploadErrorKey("Graphics are limited to 16 MB")).toBe("graphicsTooLarge");
    expect(uploadErrorKey("The SVG must not contain script elements")).toBe("graphicsUnsafeSvg");
    expect(uploadErrorKey("network down")).toBeNull();
  });

  it("checks type and the 16 MiB cap before reading", () => {
    expect(uploadProblem({ name: "door.png", type: "", size: 10 })).toBeNull();
    expect(uploadProblem({ name: "x", type: "image/svg+xml", size: 10 })).toBeNull();
    expect(uploadProblem({ name: "photo.jpg", type: "image/jpeg", size: 10 })).toBe("type");
    expect(uploadProblem({ name: "big.png", type: "image/png", size: GRAPHIC_UPLOAD_MAX_BYTES + 1 })).toBe("size");
    expect(uploadProblem({ name: "max.png", type: "image/png", size: GRAPHIC_UPLOAD_MAX_BYTES })).toBeNull();
  });
});
