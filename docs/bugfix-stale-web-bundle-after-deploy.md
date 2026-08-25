# Bugfix: a tab could keep running an old web bundle after a deploy

## Symptom

A control-programming fix was built, tested, and deployed, and the operator
still saw the old behaviour. The Controls page in the browser was running
JavaScript from before the deploy, with nothing on screen suggesting so. A
hard reload (Ctrl+Shift+R) fixed it.

This is worse than a debugging annoyance: an operator programming controls
on race morning from a tab left open overnight would silently run stale
code.

## Root cause

`App.tsx` already had a "new version is available — reload" banner, but it
only detects the **API** restarting:

```ts
const resp = await fetch(`${API_BASE}/api/version`, { cache: "no-store" });
const data = await resp.json() as { startedAt: string };
if (data.startedAt !== knownStartedAt.current) setUpdateAvailable(true);
```

The deploy in question touched only `packages/web`, so the API image layer
was identical and its container was never recreated. `startedAt` never
changed, the banner never appeared.

Two further gaps made it unrecoverable from inside the app:

- **No update check.** The PWA was configured `registerType: "autoUpdate"`,
  and the browser only looks for a new service worker on navigation. A tab
  open across the deploy never asked.
- **Reload was not enough.** The banner's action was
  `window.location.reload()`. While a new worker sits waiting, the active
  one keeps serving the precached bundle, so a soft reload returns the same
  stale assets. Only a hard reload — or activating the waiting worker —
  escapes it.

`__BUILD_VERSION__` was injected by `vite.config.ts` and declared in
`env.d.ts`, but no source file referenced it, so it was not observable at
runtime either. There was no way to tell which build a tab was running.

## Fix

**Detect a waiting bundle.** `useServiceWorkerUpdate()` wraps
`useRegisterSW` from `virtual:pwa-register/react`, and re-checks every 60 s
via `registration.update()` so an open tab notices a deploy without
navigating.

**Merge the two sources.** `resolveUpdateAction()` in
`packages/web/src/lib/app-update.ts` decides what the banner does. A
waiting bundle wins over an API restart, because activating the worker
also reloads:

```ts
if (sources.bundleWaiting) return { updateAvailable: true, action: "activate-service-worker" };
if (sources.apiRestarted) return { updateAvailable: true, action: "reload" };
```

**Act correctly.** For a waiting bundle the button calls
`updateServiceWorker(true)`, which hands over to the new worker and
reloads — the in-app equivalent of the hard reload.

**Prompt instead of auto-update.** `registerType` is now `"prompt"`. An
operator mid-readout should decide when the page reloads, and the banner
makes the waiting bundle visible rather than letting the tab go quietly
stale.

**Show the build.** The build timestamp now appears in the Sync Status
footer and on the competition list, formatted by `formatBuildVersion()`.
Answering "which build is this tab running?" no longer requires DevTools.

## Regression coverage

- `packages/web/src/lib/__tests__/app-update.test.ts` — the action matrix
  for both update sources and their precedence, plus build-timestamp
  formatting and its non-date fallback.
- `e2e/competition.spec.ts` — the build version renders in the competition
  list footer.

The banner itself is not covered end-to-end: triggering it needs a real
service-worker lifecycle across two deployed builds, which the Playwright
stacks (dev server, no service worker) cannot produce. The decision logic
it depends on is unit tested instead.
