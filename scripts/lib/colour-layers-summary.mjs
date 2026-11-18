/**
 * What the layered colour stack did (docs/map-symbols.md §9.3), by palette
 * id and number only, so standard output may quote it: no map colour
 * names. `report` is `buildColourLayers`' report, or an import's
 * `colourStack.layers` with its `inserted` and `aliased` (row I5).
 * Shared by `measure-import.mjs` and `measure-colour-order.mjs`.
 */
export function layersSummary(report) {
  const count = (pred) => report.rows.filter(pred).length;
  const reasons = (pred) => Object.fromEntries(["no-role", "graphic", "mask"].map((why) => [why, report.sourceOrdered.filter((s) => s.reason === why && pred(s)).length]));
  const dev = (d) => `${d.upper}>${d.lower}`;
  return {
    rows: report.rows.length,
    split: report.split.map((s) => s.roles.map((r) => r ?? "none").join("+")),
    noRole: { area: count((r) => r.origin === "use" && !r.role && r.place === "area"), other: count((r) => r.origin === "use" && !r.role && r.place === "other") },
    sourceOrdered: reasons(() => true),
    sourceOrderedAboveLowerPurple: reasons((s) => s.aboveLowerPurple),
    ownOrder: count((r) => r.ownOrder),
    deviations: {
      kept: report.deviations.filter((d) => d.kept && !d.impliedBy).map(dev),
      implied: report.deviations.filter((d) => d.impliedBy).map(dev),
      blocked: report.deviations.filter((d) => d.blockedBy).map(dev),
      dropped: report.deviations.filter((d) => !d.kept).length,
    },
    unreferenced: count((r) => r.origin === "unreferenced"),
    identified: count((r) => r.origin === "identified"),
    inserted: report.inserted,
    aliased: report.aliased.map((a) => a.paletteId),
    purpleInk: report.purpleInk !== null,
  };
}

/** The summary as `measure-*` print it: lines after a 13-column label. */
export function layersLines(l) {
  const so = (r) => Object.entries(r).map(([k, v]) => `${k} ${v}`).join(" / ");
  return [
    `rows ${l.rows}  split ${l.split.length}${l.split.length ? ` (${l.split.join(", ")})` : ""}  no role: area ${l.noRole.area} / other ${l.noRole.other}  unreferenced ${l.unreferenced}  identified ${l.identified}`,
    `source order: ${so(l.sourceOrdered)} (above lower purple: ${so(l.sourceOrderedAboveLowerPurple)})  own order ${l.ownOrder}`,
    `deviations kept ${l.deviations.kept.join(", ") || "—"}  implied ${l.deviations.implied.length}  blocked ${l.deviations.blocked.join(", ") || "—"}  dropped ${l.deviations.dropped}`,
    `inserted ${l.inserted.join(", ") || "—"}  aliased ${l.aliased.join(", ") || "—"}  course purple ink ${l.purpleInk ? "the map's" : "the palette's"}`,
  ];
}
