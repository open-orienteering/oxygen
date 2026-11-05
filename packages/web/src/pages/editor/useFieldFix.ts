/** Field mode's GPS watch (docs/course-editor.md §9): running while `active`, stopped otherwise and on unmount. */

import { useEffect } from "react";
import { useGeolocationWatch } from "../../hooks/useGeolocationWatch";

export function useFieldFix(active: boolean) {
  const geo = useGeolocationWatch();
  const { start, stop } = geo;
  useEffect(() => {
    if (active) start();
    else stop();
  }, [active, start, stop]);
  return geo;
}
