import { describe, expect, it } from "vitest";
import { OMAP_FLAG, parseOmapCoords, readOmap, type OmapAreaBody, type OmapCombinedBody, type OmapLineBody, type OmapPointBody, type OmapTextBody } from "../omap-reader.js";
import { parseXmlTree } from "../xml.js";

const MINI = `<?xml version="1.0" encoding="UTF-8"?>
<map xmlns="http://openorienteering.org/apps/mapper/xml/v2" version="9">
<notes>hello &amp; welcome</notes>
<georeferencing scale="10000" grid_scale_factor="0.9996" declination="5.5" grivation="4.25"><ref_point x="12.5" y="-7"/><projected_crs id="UTM"><spec language="PROJ.4">+proj=utm +datum=WGS84 +zone=33</spec><parameter>33 N</parameter><ref_point x="500000" y="6600000"/></projected_crs><geographic_crs id="Geographic coordinates"><spec language="PROJ.4">+proj=latlong +datum=WGS84</spec><ref_point_deg lat="59.5" lon="15"/></geographic_crs></georeferencing>
<colors count="3">
<color priority="2" name="Yellow" c="0" m="0.27" y="0.79" k="0" opacity="1"><spotcolors knockout="true"><component factor="1" spotcolor="1"/></spotcolors><cmyk method="spotcolor"/><rgb method="cmyk" r="1" g="0.73" b="0.21"/></color>
<color priority="0" name="Black" c="0" m="0" y="0" k="1" opacity="1"><spotcolors knockout="true"><namedcolor>BLACK</namedcolor></spotcolors><cmyk method="custom"/><rgb method="cmyk" r="0" g="0" b="0"/></color>
<color priority="1" name="Half" c="0" m="0" y="0" k="0.5" opacity="0.6"/>
</colors>
<barrier version="6" required="0.6.0">
<symbols count="5" id="Test">
<symbol type="1" id="0" code="101" name="Dot"><description>d</description><point_symbol rotatable="false" inner_radius="300" inner_color="0" outer_width="100" outer_color="2" elements="1"><element><symbol type="2" code=""><line_symbol color="0" line_width="140" join_style="1" cap_style="0"/></symbol><object type="1"><coords count="2">-500 0;500 0;</coords><pattern rotation="0"><coord x="0" y="0"/></pattern></object></element></point_symbol><icon src="data:image/png;base64,AAAA"/></symbol>
<symbol type="2" id="1" code="502" name="Road"><line_symbol color="0" line_width="300" minimum_length="0" join_style="2" cap_style="1" start_offset="0" end_offset="0" dashed="true" dash_length="2000" break_length="500" dashes_in_group="2" in_group_break_length="200" half_outer_dashes="true" mid_symbols_per_spot="1" mid_symbol_distance="0" mid_symbol_placement="2" suppress_dash_symbol_at_ends="true"><mid_symbol><symbol type="1" code=""><point_symbol inner_radius="100" inner_color="0" outer_width="0" outer_color="-1" elements="0"/></symbol></mid_symbol><borders borders_different="true"><border color="0" width="140" shift="70"/><border color="2" width="100" shift="50" dashed="true" dash_length="1000" break_length="300"/></borders></line_symbol></symbol>
<symbol type="4" id="2" code="403" name="Open" is_hidden="true"><area_symbol inner_color="2" min_area="0" patterns="2"><pattern type="1" angle="0.785398" no_clipping="0" line_spacing="800" line_offset="0" offset_along_line="0" color="0" line_width="250"/><pattern type="2" angle="0" no_clipping="2" rotatable="true" line_spacing="700" line_offset="0" offset_along_line="350" point_distance="700"><symbol type="1" code=""><point_symbol inner_radius="200" inner_color="0" outer_width="0" outer_color="-1" elements="0"/></symbol></pattern></area_symbol></symbol>
<symbol type="8" id="3" code="701" name="Text"><text_symbol icon_text="A" rotatable="true"><font family="Arial" size="4000" bold="true"/><text color="0" line_spacing="1.1" paragraph_spacing="500" character_spacing="0.05" kerning="true"/><framing color="2" mode="1" line_half_width="100" shadow_x_offset="200" shadow_y_offset="200"/><tabs count="1"><tab>1000</tab></tabs></text_symbol></symbol>
<symbol type="16" id="4" code="301" name="Lake"><combined_symbol parts="3"><part symbol="2"/><part private="true"><symbol type="2" code=""><line_symbol color="0" line_width="180" join_style="1" cap_style="0"/></symbol></part><part/></combined_symbol></symbol>
</symbols>
<parts count="2" current="0">
<part name="default part"><objects count="3">
<object type="0" symbol="0"><coords count="1">1000 -2000;</coords></object>
<object type="1" symbol="1"><tags><t k="osm">yes</t></tags><coords count="5">0 0 1;1000 0;2000 1000;3000 0 32;0 0 2;</coords><pattern rotation="0.5"><coord x="10" y="20"/></pattern></object>
<object type="4" symbol="3" rotation="1.5708" h_align="1" v_align="2"><coords count="2">500 500;4000 2000;</coords><size width="4000" height="2000"/><text>Hi
there</text></object>
</objects></part>
<part name="second"><objects count="1"><object type="1" symbol="2"><coords count="4">0 0;100 0;100 100;0 0 18;</coords><pattern rotation="0"><coord x="0" y="0"/></pattern></object></objects></part>
</parts>
<templates count="1" first_front_template="1"><template type="TemplateImage" open="true" name="bg.png" path="/x/bg.png" relpath="bg.png"/><defaults use_meters_per_pixel="true" meters_per_pixel="1" dpi="300" scale="10000"/></templates>
<view><map_view zoom="4"/></view>
<print scale="10000" resolution="600" mode="vector"><page_format paper_size="A4" orientation="portrait" h_overlap="5" v_overlap="5"><dimensions width="210" height="297"/><page_rect left="0" top="0" width="200" height="287"/></page_format><print_area left="-10" top="-20" width="150" height="100" center_area="false" single_page="false"/></print>
<undo><step type="1"><object type="0" symbol="0"><coords count="1">0 0;</coords></object></step></undo>
</barrier>
</map>`;

describe("readOmap", () => {
  const f = readOmap(MINI);

  it("reads header, notes and georeferencing", () => {
    expect(f.version).toBe(9);
    expect(f.notes).toBe("hello & welcome");
    expect(f.georeferencing).toEqual({
      scale: 10000,
      gridScaleFactor: 0.9996,
      auxiliaryScaleFactor: 1,
      declination: 5.5,
      grivation: 4.25,
      refPoint: { x: 12.5, y: -7 },
      projectedCrs: { id: "UTM", spec: "+proj=utm +datum=WGS84 +zone=33", parameters: ["33 N"], refPoint: { x: 500000, y: 6600000 } },
      geographicRefPoint: { lat: 59.5, lon: 15 },
    });
  });

  it("orders colours by priority and keeps spot-colour details", () => {
    expect(f.colours.map((c) => c.name)).toEqual(["Black", "Half", "Yellow"]);
    expect(f.colours[0].spotName).toBe("BLACK");
    expect(f.colours[0].knockout).toBe(true);
    expect(f.colours[1].opacity).toBe(0.6);
    expect(f.colours[2]).toMatchObject({ c: 0, m: 0.27, y: 0.79, k: 0, spotComponents: [{ factor: 1, spotColour: 1 }], cmykMethod: "spotcolor" });
    expect(f.warnings).toEqual([]);
  });

  it("reads the symbol table with every body type", () => {
    expect(f.symbolSetId).toBe("Test");
    expect(f.symbols.map((s) => s.code)).toEqual(["101", "502", "403", "701", "301"]);
    const dot = f.symbols[0];
    expect(dot).toMatchObject({ id: 0, name: "Dot", description: "d", hidden: false });
    const pb = dot.body as OmapPointBody;
    expect(pb).toMatchObject({ kind: "point", innerRadius: 300, innerColour: 0, outerWidth: 100, outerColour: 2 });
    expect(pb.elements).toHaveLength(1);
    expect((pb.elements[0].symbol.body as OmapLineBody).lineWidth).toBe(140);
    expect(pb.elements[0].object.coords).toEqual([
      { x: -500, y: 0, flags: 0 },
      { x: 500, y: 0, flags: 0 },
    ]);

    const road = f.symbols[1].body as OmapLineBody;
    expect(road).toMatchObject({
      kind: "line", colour: 0, lineWidth: 300, joinStyle: 2, capStyle: 1, dashed: true, dashLength: 2000, breakLength: 500,
      dashesInGroup: 2, inGroupBreakLength: 200, halfOuterDashes: true, midSymbolPlacement: 2, suppressDashSymbolAtEnds: true, scaleDashSymbol: true,
    });
    expect((road.midSymbol!.body as OmapPointBody).innerRadius).toBe(100);
    expect(road.borders).toEqual({
      different: true,
      left: { colour: 0, width: 140, shift: 70, dashed: false, dashLength: 0, breakLength: 0 },
      right: { colour: 2, width: 100, shift: 50, dashed: true, dashLength: 1000, breakLength: 300 },
    });

    const open = f.symbols[2];
    expect(open.hidden).toBe(true);
    const ab = open.body as OmapAreaBody;
    expect(ab.innerColour).toBe(2);
    expect(ab.patterns[0]).toMatchObject({ type: 1, angle: 0.785398, noClipping: 0, lineSpacing: 800, colour: 0, lineWidth: 250 });
    expect(ab.patterns[1]).toMatchObject({ type: 2, noClipping: 2, rotatable: true, pointDistance: 700, offsetAlongLine: 350 });
    expect((ab.patterns[1].symbol!.body as OmapPointBody).innerRadius).toBe(200);

    const tb = f.symbols[3].body as OmapTextBody;
    expect(tb).toMatchObject({
      kind: "text", fontFamily: "Arial", fontSize: 4000, bold: true, italic: false, colour: 0, lineSpacing: 1.1, paragraphSpacing: 500, characterSpacing: 0.05,
      framing: { colour: 2, mode: 1, lineHalfWidth: 100, shadowXOffset: 200, shadowYOffset: 200 }, tabs: [1000],
    });

    const cb = f.symbols[4].body as OmapCombinedBody;
    expect(cb.parts).toHaveLength(3);
    expect(cb.parts[0]).toEqual({ ref: 2 });
    expect(((cb.parts[1] as { symbol: { body: OmapLineBody } }).symbol.body).lineWidth).toBe(180);
    expect(cb.parts[2]).toBeNull();
  });

  it("streams objects per part with coords, flags, tags, pattern, text box", () => {
    expect(f.parts.map((p) => [p.name, p.objects.length])).toEqual([["default part", 3], ["second", 1]]);
    const [pt, path, text] = f.parts[0].objects;
    expect(pt).toMatchObject({ type: 0, symbol: 0, rotation: 0, coords: [{ x: 1000, y: -2000, flags: 0 }] });
    expect(path.tags).toEqual({ osm: "yes" });
    expect(path.coords.map((c) => c.flags)).toEqual([OMAP_FLAG.curveStart, 0, 0, OMAP_FLAG.dashPoint, OMAP_FLAG.closePoint]);
    expect(path.patternRotation).toBe(0.5);
    expect(path.patternOrigin).toEqual({ x: 10, y: 20 });
    expect(text).toMatchObject({ type: 4, symbol: 3, rotation: 1.5708, hAlign: 1, vAlign: 2, boxSize: { width: 4000, height: 2000 }, text: "Hi\nthere" });
    expect(f.parts[1].objects[0].coords[3].flags).toBe(OMAP_FLAG.holePoint | OMAP_FLAG.closePoint);
  });

  it("reads templates and print setup; ignores view and undo", () => {
    expect(f.templates).toEqual([{ type: "TemplateImage", name: "bg.png", path: "/x/bg.png", open: true }]);
    expect(f.print).toEqual({ scale: 10000, resolution: 600, mode: "vector", area: { left: -10, top: -20, width: 150, height: 100 } });
  });

  it("accepts the legacy <coord> element form and rejects count mismatches", () => {
    expect(parseOmapCoords(parseXmlTree(`<coords count="2"><coord x="1" y="2"/><coord x="3" y="4" flags="1"/></coords>`))).toEqual([
      { x: 1, y: 2, flags: 0 },
      { x: 3, y: 4, flags: 1 },
    ]);
    expect(parseOmapCoords(parseXmlTree(`<coords count="2">1 2;3\n4 32;</coords>`))[1]).toEqual({ x: 3, y: 4, flags: 32 });
    expect(() => parseOmapCoords(parseXmlTree(`<coords count="3">1 2;3 4;</coords>`))).toThrow(/expected 3 coordinates, found 2/);
    expect(() => parseOmapCoords(parseXmlTree(`<coords count="1">1;</coords>`))).toThrow(/malformed coordinate/);
  });

  it("warns on non-contiguous colour priorities and out-of-order symbol ids; requires a <map> root", () => {
    const g = readOmap(`<map version="9"><colors count="1"><color priority="3" name="X" c="0" m="0" y="0" k="1"/></colors><symbols count="1"><symbol type="1" id="7" code="1" name="a"><point_symbol inner_radius="1" inner_color="0" outer_width="0" outer_color="-1" elements="0"/></symbol></symbols></map>`);
    expect(g.warnings.map((w) => w.message)).toEqual([
      "colour priorities are not contiguous (index 0 has priority 3)",
      "symbol id 7 at list position 0",
    ]);
    expect(g.symbols[0].id).toBe(0);
    expect(() => readOmap(`<root/>`)).toThrow(/expected <map>/);
  });
});
