import { describe, it, expect } from "vitest";
import {
  getControlSuffix,
  meosStartId,
  meosFinishId,
  meosStartName,
  meosFinishName,
} from "../routers/course.js";

describe("getControlSuffix", () => {
  it("extracts numeric suffix from STA1", () => {
    expect(getControlSuffix("STA1")).toBe(1);
  });

  it("extracts numeric suffix from FIN2", () => {
    expect(getControlSuffix("FIN2")).toBe(2);
  });

  it("extracts suffix from plain number", () => {
    expect(getControlSuffix("31")).toBe(31);
  });

  it("extracts suffix with trailing whitespace", () => {
    expect(getControlSuffix("STA3 ")).toBe(3);
  });

  it("returns 1 for no numeric suffix", () => {
    expect(getControlSuffix("Start")).toBe(1);
  });

  it("returns 1 for empty string", () => {
    expect(getControlSuffix("")).toBe(1);
  });

  it("extracts multi-digit suffix", () => {
    expect(getControlSuffix("CTRL123")).toBe(123);
  });
});

describe("meosStartId / meosFinishId", () => {
  it("start 1 → 211101", () => {
    expect(meosStartId(1)).toBe(211101);
  });

  it("start 2 → 211102", () => {
    expect(meosStartId(2)).toBe(211102);
  });

  it("finish 1 → 311101", () => {
    expect(meosFinishId(1)).toBe(311101);
  });

  it("finish 3 → 311103", () => {
    expect(meosFinishId(3)).toBe(311103);
  });
});

describe("meosStartName / meosFinishName", () => {
  it("start 1 → 'Start 1'", () => {
    expect(meosStartName(1)).toBe("Start 1");
  });

  it("start 2 → 'Start 2'", () => {
    expect(meosStartName(2)).toBe("Start 2");
  });

  it("finish 1 → 'Mål 1'", () => {
    expect(meosFinishName(1)).toBe("Mål 1");
  });

  it("finish 2 → 'Mål 2'", () => {
    expect(meosFinishName(2)).toBe("Mål 2");
  });
});
