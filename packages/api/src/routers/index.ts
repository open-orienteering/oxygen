import { router } from "../trpc.js";
import { competitionRouter } from "./competition.js";
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

export const appRouter = router({
  competition: competitionRouter,
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
});


export type AppRouter = typeof appRouter;
