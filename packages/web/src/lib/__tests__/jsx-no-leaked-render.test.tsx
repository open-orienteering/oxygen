/**
 * Regression test for "stray 0" rendering in conditional JSX.
 *
 * `{eventorId && <ClubLogo .../>}` leaks a literal `0` into the DOM
 * whenever `eventorId === 0`, because React renders numeric children
 * as text. This bit `CompetitionShell`'s header (showing
 * "< 0 Bagissprinten" for events whose organiser has no Eventor id)
 * and `KioskPage`'s runner name (showing "0 ClubName" for runners
 * without a club id).
 *
 * We don't have a DOM test runner wired up for the web package, so
 * we use SSR (`react-dom/server`) to check the rendered markup of
 * the exact JSX pattern used in the codebase.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Mimics the CompetitionShell header pattern after the fix:
//   {id && id > 0 ? <Inner /> : null}
function ShellHeader({ id }: { id: number | undefined }) {
  return (
    <header>
      <button>back</button>
      {id && id > 0 ? <img alt="logo" data-id={id} /> : null}
      <h1>Bagissprinten</h1>
    </header>
  );
}

// Mimics the KioskPage clubId pattern after the fix:
//   {clubId ? <Inner /> : null}
function KioskRunner({ clubId }: { clubId: number | undefined }) {
  return (
    <p>
      {clubId ? <img alt="club-logo" data-id={clubId} /> : null}
      ClubName
    </p>
  );
}

// Mimics the BROKEN pattern. Kept here so the test acts as
// executable documentation of why we use ternary instead.
function BrokenShellHeader({ id }: { id: number | undefined }) {
  return (
    <header>
      <button>back</button>
      {/* eslint-disable-next-line react/jsx-no-leaked-render */}
      {id && id > 0 && <img alt="logo" data-id={id} />}
      <h1>Bagissprinten</h1>
    </header>
  );
}

describe("jsx-no-leaked-render", () => {
  describe("CompetitionShell-style header", () => {
    it("renders the logo when id is positive", () => {
      const html = renderToStaticMarkup(<ShellHeader id={42} />);
      expect(html).toContain("data-id=\"42\"");
      expect(html).toContain("Bagissprinten");
    });

    it("renders no stray 0 when id is exactly 0", () => {
      const html = renderToStaticMarkup(<ShellHeader id={0} />);
      expect(html).not.toMatch(/>0</);
      expect(html).not.toContain("data-id");
      expect(html).toContain("Bagissprinten");
    });

    it("renders no stray text when id is undefined", () => {
      const html = renderToStaticMarkup(<ShellHeader id={undefined} />);
      expect(html).not.toMatch(/>0</);
      expect(html).not.toContain("data-id");
      expect(html).toContain("Bagissprinten");
    });
  });

  describe("KioskPage-style club logo", () => {
    it("renders no stray 0 when clubId is exactly 0", () => {
      const html = renderToStaticMarkup(<KioskRunner clubId={0} />);
      expect(html).not.toMatch(/>0</);
      expect(html).not.toContain("data-id");
    });
  });

  describe("documents the broken pattern", () => {
    it("`{id && id > 0 && <X/>}` leaks a literal 0 for id=0 (do not use)", () => {
      const html = renderToStaticMarkup(<BrokenShellHeader id={0} />);
      // The bug: React renders the numeric `0` as a text node.
      expect(html).toMatch(/>0</);
    });
  });
});
