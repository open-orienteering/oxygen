# Screenshots

The pictures in the README, the [feature tour](../features.md) and the [guide pages](../guide/) live here. All but the two 3D shots are made by a script, so a release can retake them in one run.

## Two scripts

| Script | Shots | Command |
| --- | --- | --- |
| Showcase (`e2e/showcase/*.shot.ts`, `playwright.showcase.config.ts`) | The headline shots: course editor and its close-up, layout mode, the printed PDF, map mode and its close-up, Field mode on a phone, the card-reader dialog | `pnpm docs:showcase` |
| Gallery (`docs/screenshots/capture.ts`) | One full-page shot per admin view: runners, start list, results, classes, kiosk, stations, Test Lab and more | `pnpm docs:screenshots` |

New shots go into the showcase script; the gallery steps move into it over time ([plan](#plan)). The 3D shot (`map-3d.png`) is in it too: the demo map's terrain comes from its own contours, and the headless browser's software WebGL draws it in a few seconds. A public run features the demo's *Showcase* course (fork, butterfly loop, corridor) unless `SHOWCASE_COURSE` names another.

## Public shots from the demo

Both scripts attach to a running Oxygen. Load the Demo Competition ([demo guide](../ops/demo.md)), start the app, then:

```bash
pnpm showcase:load                                   # the fixture, into DATABASE_URL's database
SHOWCASE_URL=http://127.0.0.1:5173 pnpm docs:showcase
pnpm docs:screenshots --no-load                      # the gallery; without --no-load it reloads the fixture first
```

`SHOWCASE_URL` is the web app's address (default `http://127.0.0.1:5173`, the dev server). Shots are written to this folder. Both scripts first check that the demo event really carries the o-kartan demo map, and stop if it does not, so a machine whose demo event holds another map cannot write it into the docs. Club maps of the same forest exist, so the check is by content, not by place: `e2e/showcase/demo-map.ts` reads the source hash in the pinned map document's header and compares it with `fixtures/okartan/okartan-demo.ocd`. Layout mode creates a course-map sheet when the course has none, which is one reason public shots only ever come from the demo.

Run one shot with Playwright's filter, for example `pnpm docs:showcase -g "field mode"`. The printed page needs `pdftoppm` (poppler): a public run fails without it rather than leave an old `course-map-print.png` behind.

## Private maps

A club map can make other pictures than the demo map (real GPS tracks, a surveyed map), and a club may allow screenshots of its map while its vector source must never be published. The rules:

- **The map stays on the machine it lives on.** It is never committed, never put in a shared folder or a cloud session, and never loaded into a shared or production database.
- **Only PNGs leave the machine,** after a person has looked at them.
- **Every published picture of a club map is credited** in the README's map credits, with the club's permission recorded.

A private run reads an event that already exists in the local Oxygen:

```bash
SHOWCASE_PRIVATE=1 SHOWCASE_EVENT=<event name id> SHOWCASE_COURSE=<course name> \
  SHOWCASE_URL=http://127.0.0.1:5173 pnpm docs:showcase
```

What a private run does differently:

- Shots go to `.local/showcase-shots/` (gitignored), never into this folder. Look at them, then copy the ones to publish here under the same names.
- Every write the page sends to the API is refused, except choosing the event and the editor's presence ping, and shots that need a write are skipped. The layout shot therefore needs a course that already has a sheet.
- The exported PDF, which is vector data of the map, is written under `.local/` and deleted as soon as it is rasterised.
- It refuses to start in CI or a hosted shell (Cloud Shell, Codespaces, a cloud session), and against any `SHOWCASE_URL` but `127.0.0.1` or `localhost`.

### Keeping map sources out of git

`scripts/check-map-files.mjs` finds OCAD and Mapper files by extension (also `.bak` and archives), by OCAD's binary mark and by Mapper's XML root element, and fails unless the file is on the public list in `scripts/lib/map-files.mjs` with its pinned SHA-256: the test maps, the CC0 Puit de Laven maps and the o-kartan maps. CI runs it on every push and pull request, which catches a map but only after it was pushed. The pre-commit hook stops it before it is committed; enable it once per clone:

```bash
ln -s "$PWD/scripts/hooks/pre-commit-map-guard.sh" "$(git rev-parse --path-format=absolute --git-path hooks)/pre-commit"
```

## Which map is in which shot

| Shots | Map |
| --- | --- |
| `course-editor`, `course-editor-closeup`, `course-editor-layout`, `course-map-print`, `course-editor-map-mode`, `map-closeup`, `map-3d`, `field-mode`, `courses`, `dashboard` | The o-kartan demo map ([demo-map.md](../ops/demo-map.md)) |
| `tracks` | A club map, with the club's permission (the demo has no GPS tracks) |
| `readers` and the other gallery shots | No map, or the demo map |

## Plan

Still to come: the gallery steps move into the showcase script; a manifest lists every shot, its viewport and the docs that use it; images get a size budget; CI retakes the public shots on each release for review; the release runbook gains a "screenshots refreshed" step; and a GPS track on the terrain (the old `map-3d-track.png`, of another map, was dropped) comes back once the demo has GPS routes.
