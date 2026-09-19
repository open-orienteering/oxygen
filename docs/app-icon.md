# App icon and the live-compass logo

Oxygen's mark is the orienteering control flag — white top-left, IOF orange
bottom-right, split on the diagonal — with a compass-rose "O" cut out of the
orange: a blue ring for the O, four short cardinal points, and a needle with
an orange north half and a grey south half.

```
 ┌──────────────────────┐
 │ white            /   │
 │            ▲   /     │
 │        ◀ ( O ) ▶     │   ring + points = the "O" in Oxygen
 │            ▼ /       │   needle north = IOF orange
 │            / orange  │
 └──────────────────────┘
```

Colours: background `#F8FAFC`, orange gradient `#FF7A00 → #D94000`, blue
gradient `#06B6D4 → #3B82F6`, needle south `#94A3B8`. The artwork lives on a
`0 0 120 120` viewBox; the ring is `r=20` / `stroke-width=8`, the white halo
that cuts the orange is `r=34`.

## Where the artwork lives

| File | Purpose |
|------|---------|
| `packages/web/public/favicon.svg` | Browser tab icon, `<link rel="icon">` in `index.html`. Has a squircle clip (`rx=28`) so it reads as an app icon in the tab strip. **Source of truth for the PNGs.** |
| `packages/web/public/pwa-192.png`, `pwa-512.png` | `manifest.webmanifest` icons (Android / desktop install). Generated. |
| `packages/web/public/apple-touch-icon.png` | 180×180 iOS home-screen icon. Generated. |
| `packages/web/src/components/OxygenLogo.tsx` | Inline React copy of the same SVG so the needle can rotate. Used on the competition selector. |

`OxygenLogo.tsx` and `favicon.svg` are two copies of the same paths. When
you change one, change the other and regenerate the PNGs.

### Regenerating the PNGs

```bash
node scripts/generate-app-icons.mjs
```

The script renders `favicon.svg` with the Playwright Chromium that is
already a dev dependency (ImageMagick's built-in SVG renderer drops clip
paths and gradients). The PNGs are rendered **full-bleed** — the squircle
clip is stripped — because iOS and Android apply their own masks to
home-screen icons, and transparent corners would show up as black on iOS.

## Live compass on the competition selector

`LiveCompassLogo` (same file) wraps the logo in `useCompassHeading()` and
turns the needle so it points at real north.

```
DeviceOrientationEvent ──▶ headingFromOrientation() ──▶ heading (0–359)
                                                          │
                                        nextNeedleAngle() ▼
                                       continuous angle ──▶ style="rotate(…deg)"
                                                              + CSS transition
```

Platform quirks handled in `packages/web/src/lib/compass-heading.ts` and
`packages/web/src/hooks/useCompassHeading.ts`:

- **Android / Chromium** fires `deviceorientationabsolute` with
  `absolute: true`. `alpha` is *counter-clockwise* from north, so
  `heading = 360 − alpha`. No permission prompt (secure context required,
  which `localhost` and HTTPS both satisfy).
- **iOS / WebKit** has no absolute event; the relative `deviceorientation`
  event carries a non-standard `webkitCompassHeading` that is already
  clockwise from north. Since iOS 13 the sensor is gated behind
  `DeviceOrientationEvent.requestPermission()`, which throws unless called
  from a user gesture — so on iOS the logo is rendered as a `<button>` and
  the first tap requests permission.
- **Relative-only readings** (`absolute: false`, no `webkitCompassHeading`)
  are ignored; pointing the needle at an arbitrary reference frame would be
  worse than leaving it at north.
- **Screen rotation**: both APIs report relative to the device's portrait
  top edge, so `screen.orientation.angle` is added to keep "up on the
  screen" mapped to north in landscape.
- **Desktop**: `DeviceOrientationEvent` exists but never fires. `heading`
  stays `null` and the needle rests at north.
- **Seam crossing**: the needle angle is kept *continuous* (it may exceed
  ±360°) so the CSS `transition: transform` takes the short way round when
  the heading crosses 0/360 instead of spinning a full turn.
- **Update rate**: sensors tick at ~60 Hz; state is only updated on
  whole-degree changes to avoid re-rendering the page on every event.

### Testing

- Unit: `packages/web/src/lib/__tests__/compass-heading.test.ts` covers
  the alpha/webkit conversions, screen-angle compensation, and the
  short-way-round needle maths.
- E2E: `e2e/event-selector.spec.ts` dispatches synthetic
  `DeviceOrientationEvent`s on the landing page and asserts on the needle's
  `data-angle` and the wrapper's `data-heading`, including a seam crossing
  and an ignored relative reading. It also checks the favicon and all three
  PNGs are served.

To try it on a real phone, open the competition list over HTTPS (the Docker
stack behind a TLS proxy, or `pnpm dev` through a tunnel) — browsers refuse
sensor access on plain `http://` origins other than `localhost`.
