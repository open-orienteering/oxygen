/** ISOM 2017-2 Rev 6 — the canonical library, reference scale 1:15 000. */

import type { LibraryEntryInput } from "../schema.js";
import { LIBRARY_ID } from "./common.js";
import { course } from "./course.js";
import { landforms } from "./landforms.js";
import { manmade } from "./manmade.js";
import { rock } from "./rock.js";
import { technical } from "./technical.js";
import { vegetation } from "./vegetation.js";
import { water } from "./water.js";

export const isom2017_2 = {
  id: LIBRARY_ID,
  spec: "ISOM2017-2" as const,
  revision: "Rev 6 (20 January 2024)",
  referenceScale: 15_000,
  palette: "iof2024" as const,
  entries: [...landforms, ...rock, ...water, ...vegetation, ...manmade, ...technical, ...course] satisfies LibraryEntryInput[],
};
