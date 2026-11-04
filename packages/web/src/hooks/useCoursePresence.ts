import { useEffect, useRef, useState } from "react";
import { trpc } from "../lib/trpc";
import { usePageVisible } from "./usePageVisible";
import { newClientId, PRESENCE_HEARTBEAT_MS, type PresenceMode, type PresenceOther } from "../lib/editor/presence";

/**
 * The editor's presence heartbeat (docs/course-layer.md §7; D11): while a
 * course is open and the tab is visible, `course.presence` goes out at once and
 * then on the poll's 5 s cadence; its answer is who else has a course open.
 * A hidden tab stops, so its row ages out after the server's 30 s TTL.
 */
export function useCoursePresence(courseId: number | null, mode: PresenceMode, enabled = true): PresenceOther[] {
  const [clientId] = useState(newClientId);
  const visible = usePageVisible();
  const [others, setOthers] = useState<PresenceOther[]>([]);
  const mutate = trpc.course.presence.useMutation();
  const send = useRef(mutate.mutateAsync);
  send.current = mutate.mutateAsync;

  useEffect(() => {
    if (!enabled || !visible || courseId === null) {
      setOthers([]);
      return;
    }
    let live = true;
    const beat = () => {
      send.current({ courseId, mode, clientId }).then(
        (res) => { if (live) setOthers(res.others as PresenceOther[]); },
        () => { /* offline or refused: the next beat tries again */ },
      );
    };
    beat();
    const timer = setInterval(beat, PRESENCE_HEARTBEAT_MS);
    return () => { live = false; clearInterval(timer); };
  }, [courseId, mode, enabled, visible, clientId]);

  return others;
}
