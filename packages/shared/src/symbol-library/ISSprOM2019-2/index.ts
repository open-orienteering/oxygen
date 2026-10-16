/** ISSprOM 2019-2 Rev 6 — the canonical library, reference scale 1:4 000. */

import type { LibraryEntryInput } from "../schema.js";
import { LIBRARY_ID } from "./common.js";
import { course } from "./course.js";
import { landforms } from "./landforms.js";
import { manmade } from "./manmade.js";
import { rock } from "./rock.js";
import { technical } from "./technical.js";
import { vegetation } from "./vegetation.js";
import { water } from "./water.js";

export const issprom2019_2 = {
  id: LIBRARY_ID,
  spec: "ISSprOM2019-2" as const,
  revision: "Rev 6 (1 February 2024)",
  referenceScale: 4_000,
  palette: "iof2024" as const,
  entries: [...landforms, ...rock, ...water, ...vegetation, ...manmade, ...technical, ...course] satisfies LibraryEntryInput[],
};
