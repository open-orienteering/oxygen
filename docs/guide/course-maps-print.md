# Course maps and printing

Laying out course-map sheets and exporting print-ready PDFs. This page is the detail behind the [feature tour](../features.md).

## Course maps and export for printing

There is no separate Maps or Map templates page any more (old links
redirect): the **Courses** page shows, per course, its map template — one
picker holding the event's templates, the club library (picked templates are
copied into the event) and **New template…** (paper, orientation, scale) —
with the auto / extra badge, whether its maps are ready to print, **Edit
layout** and the course's PDF; select several courses to give them a template
at once, and its export menu prints all maps or the all-controls map.
**Edit layout** opens the course editor's Layout mode (above): the sheet on
the map canvas exactly as it prints, with shared fill modes (none / solid /
white-out / white-out outside for ink saving / ISOM 709 out-of-bounds hatch
with a purple-locked 0.4 mm border), solid or dashed strokes and uploaded
SVG/PNG graphics from a per-event or club library (a picker with thumbnails and pixel sizes; uploads up to 16 MB, several files at once if wanted, a PNG larger than 4096 px is scaled down to it, transparency kept; in the PDF a graphic keeps its transparency, opacity, Multiply, rotation, flips and crop, and an image course object prints under the control circles and numbers so a frame graphic such as a lucka can sit around a control; in the course editor's Course mode the `I` tool places a picked graphic as an image object (30 mm on its longer side), a click inside an image selects it while a control inside it stays clickable, a selected image moves by its body and resizes by its corners with an aspect lock, and the inspector sets opacity, Multiply, rotation, flips, size and crop — also opacity, blend and rotation on map texts and opacity on white-outs; in Layout mode the `I` key opens the same picker beside the rail, a picked graphic is placed at its own aspect, and the inspector gives page images, texts and rectangles the same style fields (opacity everywhere, Multiply except on white-outs, rotation on texts, rectangles and images, flips, size with the aspect lock and crop on images, size on rectangles), each change one undo step; on the page a selected text, rectangle or image shows its turned box with corner handles and a rotate knob above it (drag to turn, Shift for 15° steps; a text turns about its anchor), corners resize in the object's own frame with the opposite corner fixed (the aspect lock keeps an image's ratio, Shift inverts it), a double-click on an image enters crop mode where its edges crop it and the picture stays put, and lines and polygons turn by an angle, a quarter turn or flip from the inspector; in Course mode the same knob turns a selected image or map text (a text about its anchor), Shift inverts the aspect lock on an image's corners, a double-click on an image enters crop mode, and out-of-bounds areas and lines, white-outs, marked routes and filter regions turn by an angle, a quarter turn or flip from the inspector; any course object but the toner saver can be **attached to a control** from the inspector (the nearest control, or one you click), centred on it, or detached, and an attached object — a lucka around its control, say — moves with the control on screen and in print without being edited, shows only where its control is drawn, and stays put, detached, when its control is deleted (undo attaches it again); **Ctrl+D** duplicates the selected object 3 mm down-right, and **Ctrl+C** / **Ctrl+X** / **Ctrl+V** copy, cut and paste one object through the editor's own clipboard, which survives a reload and works across sheets, templates, events and tabs — a paste lands at the pointer (or the view's centre), and with controls selected one copy goes onto each, attached, in one undo step; course objects paste in Course mode and page objects in Layout mode, and a graphic the event and club do not have is refused with a message; an image marked **Cut out graphics below** (in the inspector in Course and Layout mode) cuts the images below it in the same layer by its box, so hatches placed over one whole-map overlay graphic (an advent calendar) show the map through their openings and can be moved freely, on screen and in print, while white-outs and the course's purple are never cut — a course hatch cuts along its own drawn outline (traced from the graphic's transparency), so a borderless hatch leaves no square corners; an image attached to a control can hide that control's circle and number; Ctrl- or Shift-click selects several course objects to move, duplicate, delete or restyle together; an SVG stays sharp when cropped or zoomed in, since only the part shown is rendered, at print resolution in the PDF and at screen resolution (up to 4096 px) on the map, and an uploaded SVG whose bounds are much larger than its drawing is trimmed to the drawing; on screen the map renderer draws the same graphics, with the same opacity, Multiply and transforms, in the editor, the viewer and the kiosk, a grey outline standing in while a graphic loads, and in the editor also where one is missing); both preview and PDF are
rotated so meridian lines stand vertical on the page. Course overprint
follows ISOM: circles, numbers and lines enlarge with the map when the print
scale is larger than the base map scale (1:15000 printed at 1:7500 → 2×).
Layout mode lists what would print outside the page. Layout objects are fixed to the page; anything that belongs to
the terrain (white-outs, out-of-bounds areas, marked routes, map text) is a course object, drawn in Course mode and
shown in Layout mode with the course. Objects that older versions anchored to the map on a sheet or template were
moved into course objects on upgrade, scoped to the sheet's course (a template's to every course). Export produces one map, a whole course, all
controls, or the complete event as vector PDF, printed straight from the
event's map document: print-ready CMYK, the course drawn with the map's own
symbols in IOF layer order, no conversion step. A map whose colours cannot
take the course layer is refused with the reason rather than printed wrong.
The PDF is put together in the browser whenever the device can — the
same file, byte for byte in content, as the server would make — so a
large export no longer waits on the server; a phone with little memory,
or a very large export, is printed by the server as before.
See
[course-maps.md](../course-maps.md) and [course-print.md](../course-print.md).

**Print the maps with no network.** *Make maps available offline* (Export
▾, the Courses page's export menu, or the sync panel) stores every map
export of the event on the device — the print jobs, their logos, the fonts
and the map — and opening Layout mode refreshes them quietly. With no
network, Export ▾ and the Courses page's exports still make the PDF, from
the stored maps, and say when they were stored. The sync panel's *Maps on
this device* shows whether the map and the print jobs are stored and
whether the browser keeps the storage; opening an event stores its map in
the background, so a device that has opened the event shows it offline.

**Description sheets.** Export ▾ in the course editor and the Courses page's
export menu offer **Description sheets…**: pick the classes, how many copies
(the class's entries plus its vacancies, one full sheet, or a number) and the
cell size (5, 6 or 7 mm), and Oxygen prints each class's control descriptions —
the same block as on its map, header naming the class — tiled on A4 to cut
apart at the start, one class per page run. No map upload is needed. See
[course-print.md](../course-print.md) §6.4.

The Courses page also keeps its format **Export** dropdown. It writes the whole course set — controls with paper-millimetre positions, course sequences with leg lengths, and (for IOF) class assignments — as either an IOF 3.0 CourseData file or a native Purple Pen `.ppen`. Open the IOF file in Condes, Purple Pen or OCAD, or import either format into another Oxygen event; the round-trip through Oxygen's own importer is lossless for the punchable course model. Export derives legs from the current coordinates and OCAD CRS scale — along a leg's bends and through its crossing point, so the file's leg lengths are the ones Oxygen shows; edited courses also get a freshly-derived total, while untouched imports retain deliberate OCAD/IOF extra distance. A course with variations is written as its variants ("Long AC", …), each a course of the family named after the root, and a class on it is assigned to every variant; a crossing point is written as an IOF crossing point on its leg, a marked route as a taped route with its length, and a map exchange carries a marker Oxygen reads back (IOF 3.0 has no field for it). Purple Pen gets each variant as an ordinary course and the legs' bends. Importing an IOF file brings its crossing points, taped routes and course families back (the family's courses stay separate courses), and a Purple Pen file its legs' bends. For Eventor-linked events, sync can repair an untouched imported total from Eventor's published class-course length but never overwrites a course edited in Oxygen. See [system/iof-coursedata-export.md](../system/iof-coursedata-export.md), [system/ppen-import-export.md](../system/ppen-import-export.md), [bugfixes/ocad-course-scale-and-export-lengths.md](../bugfixes/ocad-course-scale-and-export-lengths.md), and [bugfixes/eventor-course-lengths.md](../bugfixes/eventor-course-lengths.md).
