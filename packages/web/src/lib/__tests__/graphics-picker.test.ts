import { describe, expect, it } from "vitest";
import { GRAPHIC_UPLOAD_MAX_BYTES, graphicGroups, graphicSizeLabel, graphicThumbUrl, uploadProblem } from "../graphics-picker";

const g = (id: number, club: boolean) => ({ id, name: `g${id}`, mime: "image/png", sizeBytes: 1, widthPx: 4, heightPx: 2, club });

describe("graphics picker helpers (J2)", () => {
  it("groups event graphics before club graphics, keeping order", () => {
    expect(graphicGroups([g(1, true), g(2, false), g(3, true), g(4, false)])).toEqual({ event: [g(2, false), g(4, false)], club: [g(1, true), g(3, true)] });
  });

  it("labels the pixel size, or nothing without one", () => {
    expect(graphicSizeLabel({ widthPx: 4096, heightPx: 2048 })).toBe("4096 × 2048 px");
    expect(graphicSizeLabel({ widthPx: null, heightPx: null })).toBeNull();
  });

  it("builds the thumbnail URL with the event encoded", () => {
    expect(graphicThumbUrl("lusse 2026", 7)).toBe("/api/maps/lusse%202026/graphics/7/thumb.png");
  });

  it("checks type and the 16 MiB cap before reading", () => {
    expect(uploadProblem({ name: "door.png", type: "", size: 10 })).toBeNull();
    expect(uploadProblem({ name: "x", type: "image/svg+xml", size: 10 })).toBeNull();
    expect(uploadProblem({ name: "photo.jpg", type: "image/jpeg", size: 10 })).toBe("type");
    expect(uploadProblem({ name: "big.png", type: "image/png", size: GRAPHIC_UPLOAD_MAX_BYTES + 1 })).toBe("size");
    expect(uploadProblem({ name: "max.png", type: "image/png", size: GRAPHIC_UPLOAD_MAX_BYTES })).toBeNull();
  });
});
