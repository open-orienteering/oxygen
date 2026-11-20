# Slice J: planner questions (2026-11-18)

Fresh Fable planners ran on J1–J6, and one swept J7–J13 for questions. Any question left unanswered is built on its recommendation (**bold**).

## Behaviour you'll notice in the editor

| # | Row | Question | Recommendation |
|---|-----|----------|----------------|
| 1 | J7 | A control sits inside a door image. What does a click on the circle hit? | **Controls, numbers and legs always win over an image. The image is hit by its area everywhere else.** If the topmost thing won instead, controls inside doors couldn't be grabbed. |
| 2 | J7 | Dragging an image you haven't selected: does it move the image or pan the map? | **It pans. A click selects the image, and only a selected image moves when you drag it.** That stops big images from blocking panning. |
| 3 | J7 | Which millimetres apply to an image's size in Course mode (default 30 mm)? | **Map-scale mm, the same as a text's size.** A 1:15 000 map printed at 1:10 000 makes it 45 mm on paper. |
| 4 | J9/J11 | Do lines, paths and white-outs get a rotate handle on the canvas? | **No. Handles go on boxes only (image, text, rectangle). Lines and areas get inspector buttons: Rotate by °, Rotate 90°, Flip H/V.** |
| 5 | J9 | Transform handles and crop mode on touch screens? | **Mouse only. On touch, use the inspector fields.** |
| 6 | J4/J11 | What does a rotated text turn around? | **Its anchor point.** A text stores no box, so turning about the centre would make it drift as you type. Images and rectangles turn about their centre. |
| 7 | J10 | A control with an attached door is deleted. | **Nothing is written to the door. It shows detached where it was, and undoing the delete re-attaches it.** This also works offline on the venue box. |
| 8 | J10 | When does an attached object show? | **When its scope covers the view and its control is drawn there.** A door scoped to all courses then shows on every course that has that control. |
| 9 | J12 | Which scope does a pasted copy get? | **The original's scope, if the paste is in the same event and that scope is visible in the current view. Otherwise the current course, or all courses.** |
| 10 | J12 | Ctrl+V while a control is selected. | **Pastes onto each selected control: at the copied offset if the original was attached, else centred. Press Esc first to paste at the pointer instead.** This is how you put a door on 24 controls. |
| 11 | J13 | Old corridors with a saved white opacity below 100 % were drawn opaque until now. | **Reset them to 100 % with a migration**, so old maps print exactly as before. |

## Graphics library

| # | Row | Question | Recommendation |
|---|-----|----------|----------------|
| 12 | J2 | A PNG of 4096 px or less that is still over 8 MiB (e.g. a 12 MiB photo). | **Shrink it further (3072, then 2048 px) until it fits. Reject it only if it still doesn't fit at 2048 px.** |
| 13 | J2 | Only PNG and SVG are accepted, so a phone photo must be converted first. Should JPEG get a row of its own? | **Your call.** It's not in slice J today. |
| 14 | J2 | What width/height is recorded for an SVG? | **Its viewBox scaled so the longer side is 4096 px**, which keeps the aspect exact. |
| 15 | J2 | The kiosk key may read any club graphic by its id. Should it be limited to graphics the event uses? | **No, keep it simple.** Club graphics are logos and doors, nothing secret. |
| 16 | J6 | Screen texture size. | **Cap images at 2048 px on screen, in their own 64 MiB budget.** Very large images look a bit softer than the print when zoomed deep in. |

## Technical (safe to leave on the recommendation)

| # | Row | Question | Recommendation |
|---|-----|----------|----------------|
| 17 | J1 | Semi-transparent text or symbols in the PDF: draw each pass as a transparency group, so overlapping glyphs and halos don't darken? | **Yes. One rule on screen, in the raster and in the PDF.** |
| 18 | J3 | Which test tier checks alpha in the GL renderer? | **The arena path only, budget ≤ 1.5 %. Stop and report if a scene goes over.** |
| 19 | J4 | Does opacity also work on page shapes filled as 709 or as white-out outside? | **Yes, the same rule on every page object.** |
| 20 | J5 | Is the `course:graphics` colour row always in the stack, or only when an image exists? | **Always.** Then placing the first image doesn't rebuild the whole map on screen. |
