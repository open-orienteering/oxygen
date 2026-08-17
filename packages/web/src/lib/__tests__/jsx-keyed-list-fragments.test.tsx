/**
 * Regression test for missing `key` on fragments returned from `.map()`.
 *
 * `CoursesPage` used to render its course rows as
 *
 *   {items.map((c) => (
 *     <>                      // ← keyless fragment is the list child
 *       <tr key={c.id}>…</tr> // ← key here does nothing for the list
 *       {expanded && <tr>…</tr>}
 *     </>
 *   ))}
 *
 * The `key` must sit on the outermost element returned from the map —
 * here the fragment — otherwise React logs "Each child in a list should
 * have a unique key prop" on every render and falls back to index-based
 * reconciliation (which can mis-associate row state when the list
 * reorders). The fix is `<Fragment key={c.id}>`.
 *
 * We don't have a DOM test runner wired up for the web package, so we
 * use SSR (`react-dom/server`) with a console.error spy: React's dev
 * build emits the key warning during SSR too.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const rows = [
  { id: 1, name: "A", expanded: false },
  { id: 2, name: "B", expanded: true },
];

// Mimics the CoursesPage table body after the fix: key on the Fragment.
function FixedTable() {
  return (
    <table>
      <tbody>
        {rows.map((c) => (
          <Fragment key={c.id}>
            <tr>
              <td>{c.name}</td>
            </tr>
            {c.expanded && (
              <tr>
                <td>detail {c.name}</td>
              </tr>
            )}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

// Mimics the BROKEN pattern. Kept here so the test acts as executable
// documentation of why the key belongs on the fragment.
function BrokenTable() {
  return (
    <table>
      <tbody>
        {rows.map((c) => (
          // The buggy pattern under test — do not "fix" this fragment.
          <>
            <tr key={c.id}>
              <td>{c.name}</td>
            </tr>
            {c.expanded && (
              <tr>
                <td>detail {c.name}</td>
              </tr>
            )}
          </>
        ))}
      </tbody>
    </table>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("jsx-keyed-list-fragments", () => {
  it("keyed Fragment rows render without a key warning", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const html = renderToStaticMarkup(<FixedTable />);

    expect(html).toContain("<td>A</td>");
    expect(html).toContain("<td>detail B</td>");
    const keyWarnings = errorSpy.mock.calls.filter((args) =>
      String(args[0]).includes("unique"),
    );
    expect(keyWarnings).toEqual([]);
  });

  it("keyless `<>` as the map root warns even when the inner <tr> has a key (do not use)", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    renderToStaticMarkup(<BrokenTable />);

    const keyWarnings = errorSpy.mock.calls.filter((args) =>
      String(args[0]).includes("unique"),
    );
    expect(keyWarnings.length).toBeGreaterThan(0);
  });
});
