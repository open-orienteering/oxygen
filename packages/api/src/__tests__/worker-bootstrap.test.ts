import { describe, expect, it } from "vitest";
import { workerBootstrap } from "../worker-bootstrap.js";

describe("workerBootstrap", () => {
  const base = new URL("file:///app/dist/course-maps/print-worker");

  it("imports a compiled entry as is", () => {
    expect(workerBootstrap(base, "file:///app/dist/course-maps/host.js")).toBe(`import("file:///app/dist/course-maps/print-worker.js")`);
  });

  it("registers tsx first for a TypeScript entry", () => {
    const s = workerBootstrap(base, "file:///app/src/course-maps/host.ts");
    expect(s).toContain("tsx");
    expect(s).toContain("register()");
    expect(s).toContain("print-worker.ts");
  });
});
