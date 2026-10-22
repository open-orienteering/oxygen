/**
 * Generates the synthetic OpenOrienteering Mapper fixture `e2e/test.xmap`.
 *
 * Like `e2e/test.ocd`, this file is generated so the repository never
 * contains a real club map (real `.omap` files carry georeferences,
 * template paths and sometimes the author's notes). It is a Mapper XML
 * format-9 document that exercises every rule of the OMAP import path
 * (docs/map-import.md §4): colour priorities with a spot colour and an
 * opacity, UTM georeferencing with a shifted reference point, every symbol
 * type including combined symbols (area+line, dashed+halo, railway with a
 * background band), hidden and helper symbols, two map parts, curve /
 * dash / hole / close flags, a rotated point, text alignments and a text
 * box, object tags, a dangling symbol reference, a template, a print area
 * and an undo step that must be ignored.
 *
 * Coordinates are Mapper's 0.001 mm with y growing downward; the drawing
 * sits in a 100 × 80 mm sheet. Codes are ISOM 2017-2 so the matcher has
 * something to recognise.
 *
 * Regenerate with:  node scripts/generate-test-omap.mjs
 * Output is deterministic; a regeneration with no script changes produces a
 * byte-identical file.
 */

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "..", "e2e", "test.xmap");

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Colour priorities (0 = drawn on top).
const C = { purple: 0, black: 1, brown: 2, blue: 3, green: 4, yellow: 5, white: 6 };
const colours = [
  { p: C.purple, name: "Purple", c: 0.35, m: 0.85, y: 0, k: 0, opacity: 0.5, spot: "PURPLE" },
  { p: C.black, name: "Black", c: 0, m: 0, y: 0, k: 1, spot: "BLACK" },
  { p: C.brown, name: "Brown", c: 0, m: 0.56, y: 1, k: 0.18, spot: "BROWN" },
  { p: C.blue, name: "Blue", c: 0.87, m: 0.18, y: 0, k: 0, spot: "BLUE" },
  { p: C.green, name: "Green", c: 0.76, m: 0, y: 0.91, k: 0, spot: "GREEN" },
  { p: C.yellow, name: "Yellow", c: 0, m: 0.27, y: 0.79, k: 0, spot: "YELLOW" },
  { p: C.white, name: "White", c: 0, m: 0, y: 0, k: 0, knockoutOnly: true },
];

const colourXml = colours
  .map((c) => {
    const spot = c.spot
      ? `<spotcolors knockout="true"><namedcolor>${c.spot}</namedcolor></spotcolors>`
      : `<spotcolors knockout="true"><component factor="0" spotcolor="${C.black}"/></spotcolors>`;
    return `<color priority="${c.p}" name="${c.name}" c="${c.c}" m="${c.m}" y="${c.y}" k="${c.k}" opacity="${c.opacity ?? 1}">${spot}<cmyk method="custom"/><rgb method="cmyk" r="${(1 - c.c) * (1 - c.k)}" g="${(1 - c.m) * (1 - c.k)}" b="${(1 - c.y) * (1 - c.k)}"/></color>`;
  })
  .join("\n");

const dot = (r, colour, rotatable = false) =>
  `<symbol type="1" code=""><point_symbol rotatable="${rotatable}" inner_radius="${r}" inner_color="${colour}" outer_width="0" outer_color="-1" elements="0"/></symbol>`;
const bar = (len, width, colour) =>
  `<symbol type="1" code=""><point_symbol rotatable="true" inner_radius="0" inner_color="-1" outer_width="0" outer_color="-1" elements="1"><element><symbol type="2" code=""><line_symbol color="${colour}" line_width="${width}" join_style="1" cap_style="0"/></symbol><object type="1"><coords count="2">0 ${-len / 2};0 ${len / 2};</coords><pattern rotation="0"><coord x="0" y="0"/></pattern></object></element></point_symbol></symbol>`;
const line = (attrs, inner = "") =>
  `<line_symbol minimum_length="0" join_style="1" cap_style="0" start_offset="0" end_offset="0" segment_length="4000" end_length="0" minimum_mid_symbol_count="0" minimum_mid_symbol_count_when_closed="0" dash_length="4000" break_length="1000" dashes_in_group="1" in_group_break_length="500" mid_symbols_per_spot="1" mid_symbol_distance="0" ${attrs}>${inner}</line_symbol>`;

const symbols = [
  // 0
  `<symbol type="2" id="0" code="101" name="Contour"><description>Brown 0.14 mm line.</description>${line(`color="${C.brown}" line_width="140" join_style="2" cap_style="1"`)}</symbol>`,
  // 1
  `<symbol type="2" id="1" code="102" name="Index contour">${line(`color="${C.brown}" line_width="250" join_style="2" cap_style="1"`)}</symbol>`,
  // 2 pointed caps with offsets
  `<symbol type="2" id="2" code="106" name="Earth wall">${line(`color="${C.brown}" line_width="250" cap_style="3" pointed_cap_length="600" start_offset="600" end_offset="600"`)}</symbol>`,
  // 3 point, not rotatable, disc + ring
  `<symbol type="1" id="3" code="204" name="Boulder"><point_symbol rotatable="false" inner_radius="200" inner_color="${C.black}" outer_width="0" outer_color="-1" elements="0"/></symbol>`,
  // 4 area fill
  `<symbol type="4" id="4" code="301.1" name="Uncrossable body of water, area"><area_symbol inner_color="${C.blue}" min_area="0" patterns="0"/></symbol>`,
  // 5 bank line
  `<symbol type="2" id="5" code="301.4" name="Uncrossable body of water, bank line">${line(`color="${C.black}" line_width="180"`)}</symbol>`,
  // 6 combined area + line
  `<symbol type="16" id="6" code="301" name="Uncrossable body of water"><combined_symbol parts="2"><part symbol="4"/><part symbol="5"/></combined_symbol></symbol>`,
  // 7 area fill (yellow)
  `<symbol type="4" id="7" code="403" name="Rough open land"><area_symbol inner_color="${C.yellow}" min_area="0" patterns="0"/></symbol>`,
  // 8 hatch
  `<symbol type="4" id="8" code="311" name="Marsh"><area_symbol inner_color="-1" min_area="0" patterns="1"><pattern type="1" angle="0" no_clipping="0" line_spacing="500" line_offset="0" offset_along_line="0" color="${C.blue}" line_width="250"/></area_symbol></symbol>`,
  // 9 point pattern, rotatable
  `<symbol type="4" id="9" code="412" name="Cultivated land"><area_symbol inner_color="${C.yellow}" min_area="0" rotatable="true" patterns="1"><pattern type="2" angle="0" no_clipping="2" rotatable="true" line_spacing="800" line_offset="0" offset_along_line="0" point_distance="800">${dot(100, C.black)}</pattern></area_symbol></symbol>`,
  // 10 dashed
  `<symbol type="2" id="10" code="505" name="Footpath">${line(`color="${C.black}" line_width="180" dashed="true" dash_length="2000" break_length="250"`)}</symbol>`,
  // 11 combined dashed + wider solid → halo
  `<symbol type="16" id="11" code="508.1" name="Narrow ride, easy running"><combined_symbol parts="2"><part symbol="10"/><part private="true"><symbol type="2" code="">${line(`color="${C.green}" line_width="450"`)}</symbol></part></combined_symbol></symbol>`,
  // 12 railway: dashed black + white bordered line
  `<symbol type="16" id="12" code="509" name="Railway"><combined_symbol parts="2"><part private="true"><symbol type="2" code="">${line(`color="${C.black}" line_width="350" dashed="true" dash_length="1500" break_length="1000"`)}</symbol></part><part private="true"><symbol type="2" code="">${line(`color="${C.white}" line_width="350"`, `<borders><border color="${C.black}" width="100" shift="0"/></borders>`)}</symbol></part></combined_symbol></symbol>`,
  // 13 dash symbol (power line bars at dash points)
  `<symbol type="2" id="13" code="511" name="Power line">${line(`color="${C.black}" line_width="140" suppress_dash_symbol_at_ends="false" scale_dash_symbol="true"`, `<dash_symbol>${bar(800, 140, C.black)}</dash_symbol>`)}</symbol>`,
  // 14 mid symbols spaced
  `<symbol type="2" id="14" code="516" name="Fence">${line(`color="${C.black}" line_width="140" segment_length="3000" end_length="1500" show_at_least_one_symbol="true"`, `<mid_symbol>${bar(600, 140, C.black)}</mid_symbol>`)}</symbol>`,
  // 15 text
  `<symbol type="8" id="15" code="701" name="Text"><text_symbol icon_text="A" rotatable="true"><font family="Arial" size="4000" bold="true"/><text color="${C.black}" line_spacing="1" paragraph_spacing="0" character_spacing="0" kerning="true"/><framing color="${C.white}" mode="1" line_half_width="100" shadow_x_offset="200" shadow_y_offset="200"/></text_symbol></symbol>`,
  // 16 helper
  `<symbol type="2" id="16" code="999" name="Helper line" is_helper_symbol="true">${line(`color="${C.purple}" line_width="200"`)}</symbol>`,
  // 17 hidden
  `<symbol type="4" id="17" code="998" name="Hidden area" is_hidden="true"><area_symbol inner_color="${C.green}" min_area="0" patterns="0"/></symbol>`,
  // 18 bordered road
  `<symbol type="2" id="18" code="502" name="Road">${line(`color="${C.brown}" line_width="300"`, `<borders><border color="${C.black}" width="140" shift="70"/></borders>`)}</symbol>`,
  // 19 rotatable point with element lines
  `<symbol type="1" id="19" code="418" name="Special vegetation feature"><point_symbol rotatable="true" inner_radius="0" inner_color="-1" outer_width="0" outer_color="-1" elements="2"><element><symbol type="2" code=""><line_symbol color="${C.green}" line_width="200" join_style="1" cap_style="0"/></symbol><object type="1"><coords count="2">-400 -400;400 400;</coords></object></element><element><symbol type="2" code=""><line_symbol color="${C.green}" line_width="200" join_style="1" cap_style="0"/></symbol><object type="1"><coords count="2">-400 400;400 -400;</coords></object></element></point_symbol></symbol>`,
  // 20 small text, used with mixed alignments and a text box
  `<symbol type="8" id="20" code="702" name="Small text"><text_symbol icon_text="a" rotatable="true"><font family="Sans Serif" size="2500"/><text color="${C.black}" line_spacing="1" paragraph_spacing="0" character_spacing="0" kerning="true"/></text_symbol></symbol>`,
];

const path = (symbol, coords, extra = "", patternRotation = 0) => {
  const list = coords.map(([x, y, f]) => `${x} ${y}${f ? ` ${f}` : ""};`).join("");
  return `<object type="1" symbol="${symbol}">${extra}<coords count="${coords.length}">${list}</coords><pattern rotation="${patternRotation}"><coord x="0" y="0"/></pattern></object>`;
};
const point = (symbol, x, y, rotation) =>
  `<object type="0" symbol="${symbol}"${rotation ? ` rotation="${rotation}"` : ""}><coords count="1">${x} ${y};</coords></object>`;
const text = (symbol, x, y, str, { h = 0, v = 0, rotation, box } = {}) =>
  `<object type="4" symbol="${symbol}"${rotation ? ` rotation="${rotation}"` : ""} h_align="${h}" v_align="${v}"><coords count="${box ? 2 : 1}">${x} ${y};${box ? `${box[0]} ${box[1]};` : ""}</coords>${box ? `<size width="${box[0]}" height="${box[1]}"/>` : ""}<text>${esc(str)}</text></object>`;

// Flags: 1 curve start, 2 close point, 16 hole point, 32 dash point.
const mainObjects = [
  // Yellow background, closed.
  path(7, [[0, 60000], [100000, 60000], [100000, 80000], [0, 80000], [0, 60000, 2]]),
  // Hidden area object (must not draw).
  path(17, [[2000, 62000], [12000, 62000], [12000, 70000], [2000, 70000], [2000, 62000, 2]]),
  // Contour with a Bézier start and a (corner) dash point.
  path(0, [[10000, 10000, 1], [20000, 5000], [30000, 5000], [40000, 10000], [50000, 10000, 32], [60000, 20000]]),
  path(1, [[10000, 20000], [40000, 18000], [60000, 28000]]),
  // Earth wall with pointed ends.
  path(2, [[12000, 30000], [30000, 32000]]),
  // Footpath: dashed, dash point → dash flag.
  path(10, [[5000, 50000], [25000, 52000, 32], [45000, 50000]]),
  // Power line: dash symbol → dash points become corners.
  path(13, [[5000, 40000], [30000, 41000, 32], [55000, 40000, 32], [80000, 42000]]),
  // Lake with an island (hole ring).
  path(6, [[60000, 40000], [90000, 40000], [90000, 60000], [60000, 60000], [60000, 40000, 18], [70000, 45000], [80000, 45000], [80000, 55000], [70000, 55000], [70000, 45000, 2]]),
  // Cultivated land with a rotated pattern.
  path(9, [[65000, 5000], [95000, 5000], [95000, 25000], [65000, 25000], [65000, 5000, 2]], "", 0.3),
  // Marsh hatch.
  path(8, [[40000, 62000], [60000, 62000], [60000, 78000], [40000, 78000], [40000, 62000, 2]]),
  // Ride, railway, road, fence.
  path(11, [[5000, 55000], [45000, 57000]]),
  path(12, [[2000, 36000], [60000, 34000]]),
  path(18, [[2000, 70000], [38000, 72000]]),
  path(14, [[62000, 30000], [95000, 30000]]),
  // Helper line (hidden in print) with tags.
  path(16, [[70000, 65000], [95000, 75000]], `<tags><t k="note">helper</t></tags>`),
  // Points.
  point(3, 20000, 15000),
  point(19, 50000, 15000, 0.523599),
  // Texts: 701 always centred (lifted onto the symbol); 702 mixed, one boxed.
  text(15, 50000, 30000, "Oxygen", { h: 1 }),
  text(15, 50000, 34000, "Fixture <map>", { h: 1, rotation: 0.1 }),
  text(20, 10000, 45000, "left", { h: 0 }),
  text(20, 90000, 45000, "right", { h: 2, v: 2 }),
  text(20, 70000, 70000, "boxed text", { h: 0, box: [20000, 6000] }),
  // Dangling symbol reference.
  point(77, 95000, 2000),
];
const courseObjects = [point(3, 97000, 78000)];

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<map xmlns="http://openorienteering.org/apps/mapper/xml/v2" version="9">
<notes>Synthetic Oxygen fixture generated by scripts/generate-test-omap.mjs. Not a real map.</notes>
<georeferencing scale="10000" grid_scale_factor="0.9996" auxiliary_scale_factor="1" declination="5.5" grivation="2.5"><ref_point x="50" y="40"/><projected_crs id="UTM"><spec language="PROJ.4">+proj=utm +datum=WGS84 +zone=33</spec><parameter>33 N</parameter><ref_point x="500000" y="6600000"/></projected_crs><geographic_crs id="Geographic coordinates"><spec language="PROJ.4">+proj=latlong +datum=WGS84</spec><ref_point_deg lat="59.5" lon="15"/></geographic_crs></georeferencing>
<colors count="${colours.length}">
${colourXml}
</colors>
<barrier version="6" required="0.6.0">
<symbols count="${symbols.length}" id="Oxygen fixture">
${symbols.join("\n")}
</symbols>
<parts count="2" current="0">
<part name="default part"><objects count="${mainObjects.length}">
${mainObjects.join("\n")}
</objects></part>
<part name="Course"><objects count="${courseObjects.length}">
${courseObjects.join("\n")}
</objects></part>
</parts>
<templates count="1" first_front_template="1">
<template type="TemplateImage" open="false" name="ortho.png" path="/nonexistent/ortho.png" relpath="ortho.png"/>
<defaults use_meters_per_pixel="true" meters_per_pixel="0" dpi="0" scale="0"/>
</templates>
<view>
<grid color="#646464" display="0" alignment="0" additional_rotation="0" unit="1" h_spacing="500" v_spacing="500" h_offset="0" v_offset="0" snapping_enabled="true"/>
<map_view zoom="4" rotation="0" position_x="50000" position_y="40000" view_x="0" view_y="0" drag_offset_x="0" drag_offset_y="0"><map opacity="1" visible="true"/><templates count="0"/></map_view>
</view>
<print scale="10000" resolution="600" templates_visible="false" grid_visible="false" simulate_overprinting="false" mode="vector"><page_format paper_size="A4" orientation="landscape" h_overlap="5" v_overlap="5"><dimensions width="297" height="210"/><page_rect left="5" top="5" width="287" height="200"/></page_format><print_area left="0" top="0" width="100" height="80" center_area="false" single_page="false"/></print>
<undo><step type="1"><affected_objects count="1"><ref part="0" object="0"/></affected_objects><contents count="1">${point(3, 1, 1)}</contents></step></undo>
</barrier>
</map>
`;

writeFileSync(out, xml);
console.log(`wrote ${out} (${Buffer.byteLength(xml)} bytes, ${symbols.length} symbols, ${mainObjects.length + courseObjects.length} objects)`);
