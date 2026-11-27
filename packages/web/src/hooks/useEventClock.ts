import { useEffect, useMemo, useState } from "react";
import { trpc, activeEventNameId } from "../lib/trpc";
import { EventClock } from "../lib/event-clock";

/**
 * The event's clock, ticking locally (see `lib/event-clock.ts`).
 *
 * `currentDs` re-renders every `tickMs`; `nowDs()` reads the clock at the
 * moment it is called (use it to stamp a finish). `syncMs` is how often the
 * server is asked again.
 */
export function useEventClock(opts: { tickMs?: number; syncMs?: number } = {}) {
  const { tickMs = 250, syncMs = 30_000 } = opts;
  const utils = trpc.useUtils();
  const nameId = activeEventNameId() ?? "";
  const clock = useMemo(() => new EventClock(nameId), [nameId]);
  const [currentDs, setCurrentDs] = useState(() => clock.nowDs());
  const [synced, setSynced] = useState(clock.synced);

  useEffect(() => {
    let cancelled = false;
    const sync = () =>
      clock.sync(() => utils.client.race.serverTime.query()).then(() => {
        if (!cancelled) {
          setSynced(clock.synced);
          setCurrentDs(clock.nowDs());
        }
      });
    void sync();
    const s = setInterval(() => void sync(), syncMs);
    const t = setInterval(() => setCurrentDs(clock.nowDs()), tickMs);
    return () => {
      cancelled = true;
      clearInterval(s);
      clearInterval(t);
    };
  }, [clock, utils, tickMs, syncMs]);

  return {
    currentDs,
    nowDs: () => clock.nowDs(),
    timeZone: clock.timeZone,
    synced,
  };
}
