import { router } from "../trpc.js";
import { eventRouter } from "./event.js";
import { runnerRouter } from "./runner.js";
import { listsRouter } from "./lists.js";
import { raceRouter } from "./race.js";
import { cardReadoutRouter } from "./cardReadout.js";
import { controlRouter } from "./control.js";
import { courseRouter } from "./course.js";
import { classRouter } from "./classRouter.js";
import { clubRouter } from "./clubRouter.js";
import { eventorRouter } from "./eventor.js";
import { drawRouter } from "./drawRouter.js";
import { testLabRouter } from "./testLab.js";
import { liveresultsRouter } from "./liveresults.js";
import { onlineInputRouter } from "./onlineInput.js";
import { externalRouter } from "./external.js";
import { tracksRouter } from "./tracks.js";
import { eventsRouter } from "./events.js";
import { leaseRouter } from "./lease.js";
import { registrationTrendsRouter } from "./registrationTrends.js";
import { usersRouter } from "./users.js";
import { permissionRouter } from "./permission.js";
import { clubMapRouter } from "./clubMap.js";
import { controlSeriesRouter } from "./controlSeries.js";
import { classPresetRouter } from "./classPreset.js";

export const appRouter = router({
  // The active orienteering event. Kept under the `competition` namespace
  // for one release so existing web clients with cached bundles still work;
  // a follow-up renames to `event` once we know nothing pre-cutover is
  // still talking to us.
  competition: eventRouter,
  event: eventRouter,

  runner: runnerRouter,
  lists: listsRouter,
  race: raceRouter,
  cardReadout: cardReadoutRouter,
  control: controlRouter,
  course: courseRouter,
  class: classRouter,
  club: clubRouter,
  eventor: eventorRouter,
  draw: drawRouter,
  testLab: testLabRouter,
  liveresults: liveresultsRouter,
  onlineInput: onlineInputRouter,
  external: externalRouter,
  tracks: tracksRouter,
  events: eventsRouter,
  lease: leaseRouter,
  registrationTrends: registrationTrendsRouter,
  users: usersRouter,
  permission: permissionRouter,
  clubMap: clubMapRouter,
  controlSeries: controlSeriesRouter,
  classPreset: classPresetRouter,
});

export type AppRouter = typeof appRouter;
