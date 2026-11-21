<p align="center">
  <img src="packages/web/public/pwa-192.png" width="88" alt="Oxygen logo">
</p>

<h1 align="center">Oxygen</h1>

<p align="center">
  <b>Run an orienteering event from your browser.</b><br>
  Entries, course setting, map printing, SI card readout and live results in one web app<br>
  that keeps working when the forest has no signal.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL%20v3-blue.svg" alt="License: AGPL-3.0"></a>
  <a href="https://shell.cloud.google.com/cloudshell/editor?cloudshell_git_repo=https://github.com/open-orienteering/oxygen&cloudshell_tutorial=docs/ops/demo.md"><img src="https://gstatic.com/cloudssh/images/open-btn.svg" alt="Open in Cloud Shell"></a>
</p>

![The course editor: a course on the map, its control sequence and the description sheet beside it](docs/screenshots/course-editor.png)

Oxygen takes an orienteering event from the first entry to the last result. You load your OCAD or OpenOrienteering Mapper map, set the courses on it, print the course maps, read SPORTident cards at the finish and publish results, all from a browser on a laptop, tablet or phone. It is open source, built by [Open Orienteering](https://github.com/open-orienteering) and inspired by [MeOS](http://www.melin.nu/meos).

## Try it in two minutes

You need Docker. This starts the published image with a demo competition (169 runners, 5 courses on a free demo map):

```bash
git clone https://github.com/open-orienteering/oxygen && cd oxygen
bash scripts/demo.sh        # then open http://localhost:8080
```

Or click **Open in Cloud Shell** above and run the same script there, with nothing installed on your machine. The [demo guide](docs/ops/demo.md) walks through it.

## Why Oxygen

<table>
<tr>
<td width="50%" valign="top">
<a href="docs/guide/maps.md"><img src="docs/screenshots/map-closeup.png" alt="A close-up of the map drawn as vectors: contours, streams, vegetation and control circles"></a>
<h3>Your map, drawn properly</h3>
Upload an OCAD or Mapper file and Oxygen draws it as vectors with WebGL: sharp at any zoom, in the IOF colour order, on desktop and phone. Fix the map on the spot with corrections that survive a re-import.
</td>
<td width="50%" valign="top">
<a href="docs/guide/course-maps-print.md"><img src="docs/screenshots/course-map-print.png" alt="A printed course map with its description sheet" width="60%"></a>
<h3>Print-ready course maps</h3>
Lay out the sheet on the same canvas as the courses, then export PDF: one course, every variant of a forked course, or one map per runner. Control descriptions, cuts around features and numbers are drawn for you.
</td>
</tr>
<tr>
<td valign="top">
<a href="docs/guide/course-editor.md"><img src="docs/screenshots/course-editor-closeup.png" alt="A close-up of a course in the editor: controls, legs and numbers on the map, one control selected"></a>
<h3>Set courses on the map</h3>
Click to place controls. Legs, numbers and cuts draw themselves, and descriptions are suggested from what the map shows under the circle. Forks and butterfly loops included. Imports and exports IOF XML and Purple Pen.
</td>
<td valign="top">
<a href="docs/guide/course-editor.md"><img src="docs/screenshots/field-mode.png" alt="Field mode on a phone: GPS position and the bearing and distance to each control" width="45%"></a>
<h3>Take it to the forest</h3>
Field mode on a phone shows where you are, the distance and bearing to every control, and a checklist as you hang them. It keeps working offline and syncs when you are back in coverage.
</td>
</tr>
<tr>
<td valign="top">
<a href="docs/guide/race-day.md"><img src="docs/screenshots/readers.png" alt="Card readers: a USB station and a Bluetooth Reader BT connected" width="70%"></a>
<h3>SI cards with no drivers</h3>
Read SPORTident cards straight from Chrome or Edge, over USB or the Bluetooth Reader BT. Several readers at once, each with its status, and the Reader BT with its battery level.
</td>
<td valign="top">
<a href="docs/guide/race-day.md"><img src="docs/screenshots/kiosk-readout.png" alt="The self-service kiosk showing a runner's result"></a>
<h3>A self-service finish</h3>
A kiosk screen shows each finisher their name, class and time the moment the card is read, or exactly what went wrong. Start and finish stations, backup punches and a receipt printer cover the rest of race day.
</td>
</tr>
<tr>
<td valign="top">
<a href="docs/guide/race-day.md"><img src="docs/screenshots/dashboard.png" alt="The race-day dashboard with counters and the map"></a>
<h3>Race day at a glance</h3>
Who has not started, who is in the forest, who has finished, and how far each course has come, live on a dashboard and a map.
</td>
<td valign="top">
<a href="docs/guide/maps.md"><img src="docs/screenshots/map-3d-track.png" alt="A GPS track drawn on the map draped over the terrain in 3D"></a>
<h3>Terrain and tracks in 3D</h3>
With height data configured, see the map draped over the terrain, with GPS tracks (GPX or TCX) drawn on the ground.
</td>
</tr>
</table>

**And also:** Eventor sync of entries, clubs and results (Swedish federation) · LiveResults push to liveresultat.se · start draw across parallel start corridors · several competitions side by side · installable PWA that works offline · one-shot migration from MeOS · English and Swedish.

The [feature tour](docs/features.md) has more pictures, and every area links on to its full detail.

## Self-host

Multi-arch images are published on GHCR (`ghcr.io/open-orienteering/oxygen`, tags `stable`, `edge` and `vX.Y.Z`):

```bash
docker compose -f docker-compose.release.yml up -d   # http://localhost:8080
```

Pin a release with `OXYGEN_IMAGE=ghcr.io/open-orienteering/oxygen:v0.9.0`. [Releases and images](docs/releases/README.md) explains the tags.

**Eventor:** a club in the Swedish Orienteering Federation's Eventor enters its club API key once, under Settings → Eventor (an admin tab). Every event on the instance then syncs entries, clubs and competitors, and uploads results and start lists back.

<details>
<summary><b>Architecture and stack</b></summary>

| Layer | Technologies |
|-------|-------------|
| Frontend | React 19, Vite 8, Tailwind CSS v4, TanStack Query v5, React Router v7, WebGL2 map renderer |
| Backend | Fastify 5, tRPC 11 (end-to-end type safety), Zod 4 |
| Database | PostgreSQL 18 (`oxygen` schema, UUIDv7 keys), Prisma 7 ORM |
| Testing | Playwright E2E, Vitest unit tests |

```
oxygen/
  packages/
    api/      # Fastify + tRPC backend
    web/      # React PWA frontend
    shared/   # Shared types and utilities
  e2e/        # Playwright E2E tests
  docs/       # Guides, specs and runbooks
```

The [technical architecture](docs/architecture.md) covers the database design, deployment options and subsystems; [docs/README.md](docs/README.md) indexes everything else.

</details>

<details>
<summary><b>Develop from source</b></summary>

Prerequisites: Node.js 24 (see `.nvmrc`; >= 22.12 works), pnpm 10, PostgreSQL 18.

```bash
git clone https://github.com/open-orienteering/oxygen
cd oxygen
cp packages/api/.env.example packages/api/.env
docker compose up -d postgres   # start PostgreSQL 18
pnpm install
pnpm db:push                    # apply the oxygen schema
pnpm db:generate
pnpm dev                        # API on :3002, web on :5173
```

Without Docker, point `DATABASE_URL` in `packages/api/.env` at your own PostgreSQL 18 (for example `postgresql://oxygen:oxygen@localhost:5432/oxygen?schema=oxygen`) and skip the `docker compose` line. [packages/api/.env.example](packages/api/.env.example) lists every environment variable. Contributor rules are in [AGENTS.md](AGENTS.md).

</details>

<details>
<summary><b>Coming from MeOS</b></summary>

Until May 2026 Oxygen stored its data in a MeOS-compatible MySQL layout. It now runs on a single PostgreSQL 18 database. [docs/migrations/2026-drop-meos.md](docs/migrations/2026-drop-meos.md) tells the story and documents the one-shot CLI that moves a MeOS database into Oxygen.

</details>

## License

[GNU Affero General Public License v3.0](LICENSE): free to use and modify; derivatives must stay open source, including when run as a hosted service.

Map credits: the demo competition uses a map from [o-kartan.se](https://o-kartan.se), licensed to the project, with invented detail added ([demo map](docs/ops/demo-map.md)). Some screenshots show a club map, published as images with the club's permission.
